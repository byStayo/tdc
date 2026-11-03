import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectPrivateCredit, privateCreditTable, privateCreditVintage, refreshPrivateCredit, PRIVATE_CREDIT_CURRENT, PRIVATE_CREDIT_ID } from "../lib/consensus/private-credit.ts";
import { validateSnapshot, observationDigest } from "../lib/consensus/history.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { freezeConsensus } from "../lib/consensus/as-issued.ts";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";
import { effectiveStatus } from "../lib/consensus/engine.ts";
import { publicText } from "../lib/consensus/collector.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const html = await readFile(new URL("./fixtures/fed-private-credit-20260911.html", import.meta.url), "utf8");
const cutoff = "2026-11-03T20:00:00.000Z";
const doc = (text = html, retrievedAt = cutoff) => ({ text, retrievedAt, sha256: createHash("sha256").update(text).digest("hex") });
const previous: Snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-03T18-35-28-910Z.json", import.meta.url), "utf8"));
const saved = async () => freezeConsensus(await refreshPrivateCredit(previous, async () => doc(), () => cutoff));

test("Fed private-credit parser excludes annual data and keeps exact quarterly units, periods and series", () => {
  const parsed = privateCreditTable(html, cutoff);
  assert.equal(parsed.releaseDate, "2026-09-11");
  assert.equal(parsed.inputThrough, "2026-03-31");
  assert.deepEqual(parsed.series[0].points.map(p => p.value), [56.2, 57.3, 34.7, 58, 85.6, 50]);
  assert.deepEqual(parsed.series.map(s => s.points.at(-1)), [
    {date: "2026-06-30", value: 50}, {date: "2026-06-30", value: 81.7}, {date: "2026-06-30", value: 1.7},
  ]);
  assert.equal(parsed.series[2].points.at(-2)?.value, -54.3);
  assert.equal(privateCreditTable(html.replace('>50.0</td>', '>0.0</td>'), cutoff).series[0].points.at(-1)?.value, 0);
});

test("missing, malformed, duplicate, future and incomplete Fed cells fail closed instead of becoming zero", () => {
  for (const [bad, pattern] of [
    [html.replace('>50.0</td>', '>n.a.</td>'), /value/],
    [html.replace('>50.0</td>', '></td>'), /value/],
    [html.replace('>50.0</td>', '>Infinity</td>'), /value/],
    [html.replace('id="x4t9" headers="t9 r4 d1 d4 s4"', 'id="x4t9" headers="t8 r4 d1 d4 s4"'), /duplicate/],
    [html.replace('>2026:Q2</th>', '>2026:Q1</th>'), /duplicate/],
    [html.replace('>2026:Q2</th>', '>2027:Q2</th>'), /future/],
    [html.replace('>2026:Q2</th>', '>2026:Q3</th>'), /future|window/],
    [html.replace('>2025:Q3</th>', '>2025:Q5</th>'), /Invalid/],
    [html.replace('id="s1248t"', 'id="s1248s"'), /table/],
    [html.replaceAll('FA443067205', 'FL443067205'), /series/],
    [html.replace(/<td id="x4t9"[\s\S]*?<\/td>/, ''), /Incomplete/],
  ] as const) assert.throws(() => privateCreditTable(bad, cutoff), pattern);
  const row = html.match(/<tr>\s*<th id="r4"[\s\S]*?<\/tr>/)![0];
  assert.throws(() => privateCreditTable(html.replace(row, row+row), cutoff), /duplicate Fed series/);
});

test("unreviewed vintages, invalid dates and newer quarters require a fresh primary-document review", () => {
  assert.throws(() => privateCreditVintage(html.replace("September 11, 2026", "December 10, 2026"), "2026-12-11T00:00:00.000Z"), /requires units and input-lag review/);
  assert.throws(() => privateCreditVintage(html, "2026-09-01T00:00:00.000Z"), /future/);
  assert.throws(() => privateCreditVintage(html.replace("September 11, 2026", "September 31, 2026"), cutoff), /Invalid/);
  assert.throws(() => privateCreditVintage(html.replace('id="lastUpdate"', 'id="updated"'), cutoff), /release date/);
});

test("collector binds the dated table hash, release metadata and estimated quarter without a directional score", async () => {
  const calls: string[] = [];
  const signal = await collectPrivateCredit(async url => { calls.push(url); return doc(); }, () => cutoff);
  assert.deepEqual(calls, [PRIVATE_CREDIT_CURRENT, "https://www.federalreserve.gov/releases/z1/20260911/html/S124_8_t.htm"]);
  assert.equal(signal.status, "available");
  assert.equal(signal.source.sha256, doc().sha256);
  assert.equal(signal.source.observedAt, "2026-06-30");
  assert.equal(signal.privateCredit?.inputThrough, "2026-03-31");
  assert.match(signal.privateCredit!.documentation.sha256, /^[a-f0-9]{64}$/);
  assert.ok(signal.metrics.every(m => m.unit === "$bn SAAR" && m.date === "2026-06-30"));
  assert.ok(Object.values(signal.scores).every(s => s === null));
  assert.deepEqual(signal.directionalInstruments, []);
  assert.match(signal.summary, /estimated/);
  assert.equal(effectiveStatus(signal, cutoff), "available");
  assert.equal(effectiveStatus(signal, "2027-02-01T00:00:00.000Z"), "stale");
});

test("current/dated disagreement or invalid provenance withholds the source", async () => {
  for (const document of [doc(html.replace('>50.0</td>', '>51.0</td>')), {...doc(), sha256: 'bad'}, doc(html, "2027-01-01T00:00:00.000Z")]) {
    const signal = await collectPrivateCredit(async url => url === PRIVATE_CREDIT_CURRENT ? doc() : document, () => cutoff);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.failureKind, "validation");
    assert.equal(signal.series.length, 0);
    assert.equal(signal.metrics.length, 0);
  }
});

test("transport failures retain original Fed evidence; invalid or unreviewed releases never do", async () => {
  const prior = await saved(), nextTime = "2026-11-04T20:00:00.000Z";
  const original = prior.signals.find(s => s.id === PRIVATE_CREDIT_ID)!;
  for (const transport of [true, false]) {
    const next = await refreshPrivateCredit(prior, async () => {
      if (transport) throw new SourceTransportError("source interrupted");
      return doc(html.replace("September 11, 2026", "November 3, 2026"), nextTime);
    }, () => nextTime);
    const retained = retainLastKnown(next, prior).signals.find(s => s.id === PRIVATE_CREDIT_ID)!;
    if (transport) {
      assert.deepEqual(retained.source, original.source);
      assert.deepEqual(retained.privateCredit, original.privateCredit);
      assert.match(retained.collectionNote!, /original dates/);
    } else assert.equal(retained.status, "unavailable");
  }
});

test("publication rejects tampered units, vintage, source, estimates or votes", async () => {
  const snapshot = await saved(); validateSnapshot(snapshot);
  for (const mutate of [
    (s: Signal) => { s.unit = "$bn"; },
    (s: Signal) => { s.metrics[0].value += 1; },
    (s: Signal) => { s.metrics[1].unit = "$bn"; },
    (s: Signal) => { s.privateCredit!.inputThrough = "2026-06-30"; },
    (s: Signal) => { s.privateCredit!.documentation.sha256 = "b".repeat(64); },
    (s: Signal) => { s.source.url = PRIVATE_CREDIT_CURRENT; },
    (s: Signal) => { s.scores.daily = 1; },
    (s: Signal) => { s.directionalInstruments = ["MARKET"]; },
    (s: Signal) => { delete s.privateCredit; },
    (s: Signal) => { s.id = "mislabelled"; },
  ]) {
    const changed = structuredClone(snapshot); mutate(changed.signals.find(s => s.id === PRIVATE_CREDIT_ID)!);
    assert.throws(() => validateSnapshot(changed), /Private-credit|private-credit/);
  }
});

test("scoped addition preserves prior observations and missing PE flows; refetching alone creates no new identity", async () => {
  const before = JSON.stringify(previous), next = await saved();
  assert.equal(JSON.stringify(previous), before);
  assert.equal(next.signals.length, previous.signals.length + 1);
  assert.deepEqual(next.signals.filter(s => s.id !== PRIVATE_CREDIT_ID), previous.signals);
  assert.deepEqual(next.catalysts, previous.catalysts);
  assert.deepEqual(next.news, previous.news);
  for (let i = 0; i < 18; i++) {
    assert.equal(next.consensus![i].score, previous.consensus![i].score);
    assert.equal(next.consensus![i].directionalCoverage, previous.consensus![i].directionalCoverage);
    assert.equal(next.consensus![i].abstain, true);
  }
  const later = "2026-11-03T20:01:00.000Z";
  const refreshed = freezeConsensus(await refreshPrivateCredit(next, async () => ({...doc(html, later),sha256:'c'.repeat(64)}), () => later));
  assert.equal(refreshed.signals.length, next.signals.length);
  assert.equal(observationDigest(refreshed), observationDigest(next));
  assert.equal(previous.signals.some(s => s.id === PRIVATE_CREDIT_ID), false);
});

test("public text collection advertises HTML for official HTML tables", async () => {
  await publicText(PRIVATE_CREDIT_CURRENT, async (_url, init) => {
    assert.match(new Headers(init?.headers).get('Accept')!, /text\/html/);
    return new Response(html);
  });
});
