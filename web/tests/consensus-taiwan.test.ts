import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectTaiwan, refreshTaiwan, taiwanObservations, twseURL, TWSE_SERIES } from "../lib/consensus/taiwan.ts";
import { collectSnapshot, publicText } from "../lib/consensus/collector.ts";
import { freezeConsensus, asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";
import { effectiveStatus } from "../lib/consensus/engine.ts";
import { INSTRUMENTS, HORIZONS, type Signal, type Snapshot } from "../lib/consensus/types.ts";

const texts = await Promise.all(["twse-price-2026-11-04.json", "twse-return-2026-11-04.json"].map(name => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")));
const at = "2026-11-04T22:30:00.000Z", nextAt = "2026-11-05T22:30:00.000Z";
const document = (text: string, retrievedAt = at) => ({ text, retrievedAt, sha256: createHash("sha256").update(text).digest("hex") });
const read = async (url: string) => document(texts[TWSE_SERIES.findIndex(spec => twseURL(spec) === url)]);
const prior: Snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-04T21-29-43-446Z.json", import.meta.url), "utf8"));
const saved = async () => freezeConsensus(await refreshTaiwan(prior, read, () => at));

test("real TWSE rows retain distinct price and reinvested-distribution levels with Gregorian session dates", () => {
  const price = taiwanObservations(texts[0], TWSE_SERIES[0], at);
  const totalReturn = taiwanObservations(texts[1], TWSE_SERIES[1], at);
  assert.deepEqual(price.map(p => [p.date, p.value]), [["2026-11-02",44920.14],["2026-11-03",43307.54],["2026-11-04",42948.91]]);
  assert.deepEqual(totalReturn.map(p => p.value), [103873.24,100144.27,99315.03]);
  assert.deepEqual(price.at(-1), {date:"2026-11-04",value:42948.91,open:43449.45,high:43741.54,low:41855.82});
  assert.deepEqual(taiwanObservations(JSON.stringify(JSON.parse(texts[0]).reverse()), TWSE_SERIES[0], at), price);
});

test("malformed values, OHLC conflicts, duplicate/future dates and schema changes fail closed", () => {
  const raw = JSON.parse(texts[0]);
  for (const mutate of [
    (rows: Record<string,string>[]) => { rows[0].Date = "1150231"; },
    (rows: Record<string,string>[]) => { rows[0].Date = "20261102"; },
    (rows: Record<string,string>[]) => { rows[0].Date = "1151105"; },
    (rows: Record<string,string>[]) => { rows[0].Date = "1151002"; },
    (rows: Record<string,string>[]) => { rows[0].Date = rows[1].Date; },
    (rows: Record<string,string>[]) => { rows[0].HighestIndex = "100"; },
    (rows: Record<string,string>[]) => { rows[0].LowestIndex = "99999"; },
    (rows: Record<string,string>[]) => { rows[0].OpeningIndex = "99999"; },
    (rows: Record<string,string>[]) => { delete rows[0].ClosingIndex; },
    (rows: Record<string,string>[]) => { rows[0].Currency = "USD"; },
  ]) { const bad = structuredClone(raw); mutate(bad); assert.throws(() => taiwanObservations(JSON.stringify(bad), TWSE_SERIES[0], at)); }
  for (const bad of ["", "0", "-1", "NaN", "Infinity", "4,29,48.91", "42948.91USD", " 42948.91", null, 42948.91]) {
    const rows = structuredClone(raw); rows[0].ClosingIndex = bad;
    assert.throws(() => taiwanObservations(JSON.stringify(rows), TWSE_SERIES[0], at));
  }
  for (const bad of ["{}", "[]", "null", "<html>outage</html>", JSON.stringify(Array(32).fill(raw[0]))])
    assert.throws(() => taiwanObservations(bad, TWSE_SERIES[0], at));
  assert.throws(() => taiwanObservations(texts[0], TWSE_SERIES[1], at));
});

test("first session of a month keeps a real level without a fabricated prior return", async () => {
  const result = await collectTaiwan(async url => {
    const raw = JSON.parse(texts[TWSE_SERIES.findIndex(spec => twseURL(spec) === url)]);
    return document(JSON.stringify([raw[0]]));
  }, () => at);
  assert.ok(result.every(s => s.status === "available" && s.series.length === 1));
  assert.ok(result.every(s => !s.metrics.some(m => m.label === "Observed-session change")));
});

test("collector binds original hash, date, licence and actual index arithmetic without votes", async () => {
  const rows = await collectTaiwan(read, () => at);
  for (const [i, signal] of rows.entries()) {
    assert.equal(signal.status, "available");
    assert.equal(signal.source.observedAt, "2026-11-04");
    assert.equal(signal.source.releasedAt, null);
    assert.equal(signal.source.sha256, document(texts[i]).sha256);
    assert.equal(signal.source.url, twseURL(TWSE_SERIES[i]));
    assert.match(signal.source.usage, /Open Government Data License 1.0/);
    assert.match(signal.source.attribution, /2026/);
    assert.deepEqual(signal.directionalInstruments, []);
    assert.deepEqual(signal.scores, {daily:null,weekly:null,monthly:null});
    assert.equal(signal.metrics.at(-1)?.unit, "%");
    // Independently calculated with Python Decimal from the literal source values.
    assert.ok(Math.abs(signal.metrics.at(-1)!.value - (i === 0 ? -0.8281006032667753 : -0.8280453789318151)) < 1e-12);
    assert.equal(effectiveStatus(signal, "2026-11-20T00:00:00.000Z"), "stale");
  }
});

test("each endpoint retains its own observation date and fails independently", async () => {
  const independent = await collectTaiwan(async url => url.endsWith("MFI94U") ? document(JSON.stringify(JSON.parse(texts[1]).slice(0,2))) : read(url), () => at);
  assert.deepEqual(independent.map(s => s.source.observedAt), ["2026-11-04","2026-11-03"]);
  const failure = await collectTaiwan(async url => { if (url.endsWith("MFI94U")) throw new SourceTransportError("offline"); return read(url); }, () => at);
  assert.equal(failure[0].status, "available"); assert.equal(failure[1].status, "unavailable");
  assert.equal(failure[1].failureKind, "transport"); assert.deepEqual(failure[1].series, []);
});

test("source hash, future retrieval and malformed input cannot be published as known observations", async () => {
  for (const bad of [{...document(texts[0]),sha256:"a".repeat(64)}, document(texts[0], nextAt), document("{}")]) {
    const rows = await collectTaiwan(async () => bad, () => at);
    assert.ok(rows.every(s => s.status === "unavailable" && s.failureKind === "validation" && !s.series.length && !s.metrics.length));
  }
});

test("scoped collection preserves every other source value and all 18 directional scores", async () => {
  const original = JSON.stringify(prior), next = await saved(); validateSnapshot(next);
  assert.equal(JSON.stringify(prior), original);
  for (const signal of prior.signals.filter(s => s.id !== "global-equities"))
    assert.deepEqual(next.signals.find(s => s.id === signal.id), signal);
  assert.match(next.signals.find(s => s.id === "global-equities")!.summary, /partial context/);
  assert.equal(next.signals.find(s => s.id === "daily-prices")!.status, "unavailable");
  assert.deepEqual(next.review, prior.review);
  for (const instrument of INSTRUMENTS) for (const horizon of HORIZONS) {
    const before = asIssuedConsensus(prior, instrument, horizon), after = asIssuedConsensus(next, instrument, horizon);
    assert.equal(after.score, before.score); assert.equal(after.directionalCoverage, before.directionalCoverage);
    assert.equal(after.abstain, true);
  }
});

test("refresh timestamps alone do not create a new edition", async () => {
  const one = await saved();
  const two = freezeConsensus(await refreshTaiwan(one, async url => ({...await read(url), retrievedAt:nextAt}), () => nextAt));
  assert.equal(observationDigest(one), observationDigest(two));
});

test("transport outages retain old source ages; invalid replacement data cannot revive old values", async () => {
  const previous = await saved();
  for (const transport of [true,false]) {
    const next = await refreshTaiwan(previous, async () => { if (transport) throw new SourceTransportError("offline"); return document("{}",nextAt); }, () => nextAt);
    const retained = retainLastKnown(next, previous);
    for (const spec of TWSE_SERIES) {
      const signal = retained.signals.find(s => s.id === spec.id)!;
      if (transport) { assert.deepEqual(signal.source, previous.signals.find(s => s.id === spec.id)!.source); assert.match(signal.collectionNote!, /original dates/); }
      else { assert.equal(signal.status,"unavailable"); assert.equal(signal.series.length,0); }
    }
  }
});

test("publication rejects Taiwan data relabelled as US prices, votes, altered units or invented dates", async () => {
  const original = await saved();
  for (const mutate of [
    (s: Signal) => { s.family = "technicals"; }, (s: Signal) => { s.unit = "USD"; },
    (s: Signal) => { s.scores.daily = 1; }, (s: Signal) => { s.directionalInstruments = ["SPY"]; },
    (s: Signal) => { s.source.releasedAt = at; }, (s: Signal) => { s.source.url = "https://thedailyconsensus.com/"; },
    (s: Signal) => { s.source.observedAt = "2026-11-03"; }, (s: Signal) => { s.metrics[0].value += 1; },
    (s: Signal) => { s.metrics.at(-1)!.value = 0; }, (s: Signal) => { s.metrics[2].value = 100; },
    (s: Signal) => { s.source.usage = "unknown"; }, (s: Signal) => { s.status = "unavailable"; },
  ]) { const bad = structuredClone(original); mutate(bad.signals.find(s => s.id === TWSE_SERIES[0].id)!); assert.throws(() => validateSnapshot(bad)); }
});

test("full collection includes the real parsers through the bounded public fetch path", async () => {
  const urls: string[] = [];
  const result = await collectSnapshot(async (url) => {
    urls.push(url);
    const index = TWSE_SERIES.findIndex(spec => twseURL(spec) === url);
    return index < 0 ? new Response("not in fixture",{status:404}) : new Response(texts[index]);
  });
  assert.equal(result.signals.filter(s => s.id.startsWith("twse-") && s.status === "available").length,2);
  for (const spec of TWSE_SERIES) assert.equal(urls.filter(url => url === twseURL(spec)).length,1);
  const later = new Date(Date.parse(result.issuedAt) + 1000).toISOString();
  const before = {...result, signals: result.signals.filter(s => !s.id.startsWith("twse-"))};
  const scoped = await refreshTaiwan(before, async url => ({...await read(url),retrievedAt:later}), () => later);
  const sameFull = {...result, signals:result.signals.map(s => scoped.signals.find(other => other.id === s.id)!)};
  assert.deepEqual(result.signals.map(s => s.id), scoped.signals.map(s => s.id));
  assert.equal(observationDigest(sameFull), observationDigest(scoped));
  await assert.rejects(publicText("https://openapi.twse.com.tw.attacker.example/v1/indicesReport/MFI94U"), /allowlist/);
});
