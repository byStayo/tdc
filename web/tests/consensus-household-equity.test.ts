import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { collectHouseholdEquity, householdEquityTable, validateHouseholdEquity } from "../lib/consensus/household-equity.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";
import type { Signal } from "../lib/consensus/types.ts";

const html = await readFile(new URL("./fixtures/fed-household-equity-20260911.html", import.meta.url), "utf8");
const id = "fed-household-equity-transactions";
const current = "https://www.federalreserve.gov/releases/z1/current/html/S1M_t.htm";
const dated = "https://www.federalreserve.gov/releases/z1/20260911/html/S1M_t.htm";
const cutoff = "2026-11-19T20:00:00.000Z";
const doc = (text = html, retrievedAt = cutoff) => ({ text, retrievedAt, sha256: createHash("sha256").update(text).digest("hex") });

test("normal daily collection admits the original household/NPISH transaction as nonvoting retail context", async () => {
  const snapshot = await collectSnapshot(async url => new Response([current, dated].includes(url) ? html : "", {
    status: [current, dated].includes(url) ? 200 : 503,
  }));
  const signal = snapshot.signals.find(s => s.id === id);
  assert.ok(signal, "Normal collector omits the reviewed household-equity observation");
  assert.equal(signal.status, "available");
  assert.equal(signal.family, "retail");
  assert.equal(signal.source.url, dated);
  assert.equal(signal.source.releasedAt, "2026-09-11");
  assert.equal(signal.source.observedAt, "2026-06-30");
  assert.equal(signal.unit, "$bn SAAR");
  assert.deepEqual(signal.series, [{ date: "2026-06-30", value: 1352.7 }]);
  assert.deepEqual(signal.directionalInstruments, []);
  assert.ok(Object.values(signal.scores).every(score => score === null));
});

test("original Fed annual columns do not become earlier quarterly publications", () => {
  const result = householdEquityTable(html, cutoff);
  assert.deepEqual(result.points, [
    { date: "2025-03-31", value: 845.1 }, { date: "2025-06-30", value: -273.8 },
    { date: "2025-09-30", value: 1648.5 }, { date: "2025-12-31", value: 1076.4 },
    { date: "2026-03-31", value: 2016.1 }, { date: "2026-06-30", value: 1352.7 },
  ]);
  assert.equal(householdEquityTable(html.replace('>1352.7</td>', '>0.0</td>'), cutoff).points.at(-1)?.value, 0);
});

test("missing or ambiguous periods, transaction values and sector definitions fail closed", () => {
  const row = html.match(/<tr\b[^>]*>[\s\S]*?FA153064105[\s\S]*?<\/tr>/)![0];
  for (const bad of [
    html.replace('>1352.7</td>', '>n.a.</td>'), html.replace('>1352.7</td>', '></td>'),
    html.replace('>2026:Q2</th>', '>2026:Q1</th>'), html.replace('>2026:Q2</th>', '>2026:Q3</th>'),
    html.replace('id="s1mt"', 'id="s1ms"'), html.replaceAll('FA153064105', 'LM153064105'),
    html.replace('through 2012q3', 'through 2026q2'), html.replace('Households and nonprofit organizations', 'Households'),
    html.replace(row, row + row), html.replace('id="lastUpdate"', 'id="updated"'),
    html.replace(/<td[^>]+headers="t9[^>]*>[\s\S]*?<\/td>/, ''),
  ]) assert.throws(() => householdEquityTable(bad, cutoff), /household-equity|Household-equity|Fed/);
});

test("date-only publication is not known at the quarter end or during its New York release day", async () => {
  for (const at of ["2026-06-30T20:00:00.000Z", "2026-09-11T23:59:00.000Z", "2026-09-12T01:00:00.000Z"])
    assert.equal((await collectHouseholdEquity(async () => doc(html, at), () => at)).status, "unavailable");
  assert.equal((await collectHouseholdEquity(async () => doc(html, "2026-09-12T12:00:00.000Z"), () => "2026-09-12T12:00:00.000Z")).status, "available");
  assert.throws(() => householdEquityTable(html.replaceAll("September 11, 2026", "December 10, 2026"), "2026-12-11T20:00:00.000Z"), /requires units and input-lag review/);
});

test("dated source disagreement, invalid digest or a future capture withholds the observation", async () => {
  for (const bad of [doc(html.replace('>1352.7</td>', '>1353.7</td>')), { ...doc(), sha256: 'bad' }, doc(html, "2026-11-20T20:00:00.000Z")]) {
    const signal = await collectHouseholdEquity(async url => url === current ? doc() : bad, () => cutoff);
    assert.equal(signal.status, "unavailable"); assert.equal(signal.failureKind, "validation");
    assert.deepEqual(signal.series, []); assert.equal(signal.householdEquity, undefined);
  }
});

test("publication enforces native units, NPISH residual scope, first capture, method break and nonvoting grade", async () => {
  const signal = await collectHouseholdEquity(async () => doc(), () => cutoff);
  validateHouseholdEquity(signal);
  assert.equal(signal.householdEquity?.seriesId, "FA153064105.Q");
  assert.equal(signal.householdEquity?.firstObservedAt, cutoff);
  assert.equal(signal.householdEquity?.publicationClock, "date-only");
  assert.equal(signal.householdEquity?.revisedDefinitionFrom, "2012-10-01");
  assert.match(signal.limitation, /nonprofit|private-equity|residual/);
  for (const mutate of [
    (s: Signal) => { s.unit = "$bn cash"; }, (s: Signal) => { s.metrics[0].value += 1; },
    (s: Signal) => { s.source.url = 'https://www.federalreserve.gov.evil.invalid/releases/z1/20260911/html/S1M_t.htm'; },
    (s: Signal) => { s.source.releasedAt = "2026-06-30"; },
    (s: Signal) => { s.householdEquity!.firstObservedAt = "2026-06-30T20:00:00.000Z"; },
    (s: Signal) => { s.householdEquity!.firstObservedAt = "2026-11-20T20:00:00.000Z"; },
    (s: Signal) => { s.householdEquity!.revisedDefinitionFrom = "2012-01-01" as "2012-10-01"; },
    (s: Signal) => { s.scores.daily = 0.5; }, (s: Signal) => { s.directionalInstruments = ["SPY"]; },
    (s: Signal) => { s.limitation = "Retail investors bought equities"; },
    (s: Signal) => { delete s.householdEquity; }, (s: Signal) => { s.id = "wrong-id"; },
  ]) { const changed = structuredClone(signal); mutate(changed); assert.throws(() => validateHouseholdEquity(changed), /household-equity|Household-equity/); }
});

test("normal rerun preserves first verified capture and prior snapshot, without new observation identity", async () => {
  const fetcher = async (url: string) => new Response([current, dated].includes(url) ? html : "", { status: [current, dated].includes(url) ? 200 : 503 });
  const first = await collectSnapshot(fetcher), before = JSON.stringify(first);
  validateSnapshot(first);
  const second = await collectSnapshot(fetcher, first);
  assert.equal(JSON.stringify(first), before);
  assert.deepEqual(second.signals.find(s => s.id === id)?.householdEquity, first.signals.find(s => s.id === id)?.householdEquity);
  assert.equal(observationDigest(second), observationDigest(first));
  const tampered = structuredClone(first); tampered.signals.find(s => s.id === id)!.scores.daily = 1;
  assert.throws(() => validateSnapshot(tampered), /household-equity/);
});

test("household transport failure preserves original first-capture evidence through the existing last-known path", async () => {
  const snapshot = await collectSnapshot(async () => new Response('', {status: 503}));
  const at = snapshot.cutoff;
  const signal = await collectHouseholdEquity(async () => doc(html, at), () => at);
  const failed = await collectHouseholdEquity(async () => { throw new SourceTransportError("offline"); }, () => at, signal);
  const first = { ...snapshot, signals: snapshot.signals.map(s => s.id === id ? signal : s) };
  const later = new Date(Date.parse(at) + 1000).toISOString();
  const next = { ...snapshot, id: later.replace(/[:.]/g, "-"), issuedAt: later, cutoff: later,
    signals: snapshot.signals.map(s => s.id === id ? failed : s) };
  const kept = retainLastKnown(next, first).signals.find(s => s.id === id)!;
  assert.equal(kept.status, "available"); assert.deepEqual(kept.source, signal.source);
  assert.deepEqual(kept.householdEquity, signal.householdEquity);
});

test("a household source outage does not withhold the distinct private-credit observation", async () => {
  const credit = await readFile(new URL("./fixtures/fed-private-credit-20260911.html", import.meta.url), "utf8");
  const result = await collectSnapshot(async url => new Response(url.includes('S124_8_t.htm') ? credit : '', {status: url.includes('S124_8_t.htm') ? 200 : 503}));
  assert.equal(result.signals.find(s => s.id === id)?.status, "unavailable");
  assert.equal(result.signals.find(s => s.id === 'fed-private-credit-loans')?.status, "available");
  assert.equal(result.signals.find(s => s.id === 'fed-private-credit-loans')?.series.at(-1)?.value, 50);
});
