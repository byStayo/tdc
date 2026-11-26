import test from "node:test";
import assert from "node:assert/strict";
import { CENSUS_TRADE, beaTradeUrls, collectUsTrade, reportedExports, tradePeriod, tradeReleaseTime, validateUsTrade } from "../lib/consensus/us-trade.ts";
import { SourceMissingError, SourceTransportError } from "../lib/consensus/source-failure.ts";
import { ft900Targets, priorDollarFix } from "../scripts/research-ft900-exports.ts";

const captured = "2026-11-23T20:00:00.000Z";
const title = "U.S. International Trade in Goods and Services, September 2026";
const data = "September exports were $321.5 billion, $5.8 billion more than August exports.";
const census = "<article>FOR IMMEDIATE RELEASE: Wednesday, November 4, 2026 " + title + "</article><p>" + data + "</p>";
const bea = "<h1>" + title + "</h1>FOR RELEASE AT 8:30 A.M. EST, Wednesday, November 4, 2026 <p>" + data + "</p>";
const url = "https://www.bea.gov/news/2026/us-international-trade-goods-and-services-september-2026";
const doc = (text: string, retrievedAt = captured) => ({ text, retrievedAt, sha256: "a".repeat(64) });

test("joint trade release carries its reference month, actual embargo clock, units and non-voting scope into the archive", async () => {
  const requests: string[] = [];
  const signal = await collectUsTrade(async u => { requests.push(u); return doc(u === CENSUS_TRADE ? census : bea); }, captured);
  assert.deepEqual(requests, [CENSUS_TRADE, url]);
  assert.equal(signal.status, "available");
  assert.equal(signal.source.observedAt, "2026-09-30");
  assert.equal(signal.source.releasedAt, "2026-11-04T13:30:00.000Z");
  assert.equal(signal.source.url, url);
  assert.deepEqual(signal.metrics.map(m => [m.unit, m.value]), [["USD billion", 321.5], ["USD billion", 5.8]]);
  assert.deepEqual(signal.directionalInstruments, []);
  validateUsTrade(signal);
  const other = { ...signal.source, url: "https://www.bea.gov/news/2026/another-release" };
  assert.throws(() => validateUsTrade({ ...signal, source: other }), /reading/);
  assert.throws(() => validateUsTrade({ ...signal, scores: { ...signal.scores, daily: 1 } }), /scope/);
  assert.throws(() => validateUsTrade({ ...signal, instruments: ["MARKET", "SPY"] }), /scope/);
});

test("an ambiguous change, conflicting original releases or a future timestamp cannot supply a trade observation", async () => {
  for (const [landing, dated, clock] of [
    [census, bea.replace("$5.8", "$5.7"), captured],
    [census, bea.replace("Wednesday", "Thursday"), captured],
    [census, bea.replace("A.M. EST", "A.M. EDT"), captured],
    [census, bea.replace("August exports", "July exports"), captured],
    [census, bea.replace(title, title.replace("September", "October")), captured],
    [census, bea + " ERRATA: Exhibit 1 was revised after the release.", captured],
    [census, bea + " FOR RELEASE AT 8:30 A.M. EST, Thursday, November 5, 2026", captured],
    [census, bea + " " + data.replace("$5.8", "$5.7"), captured],
    [census, bea, "2026-11-04T13:29:59.000Z"],
  ]) {
    const signal = await collectUsTrade(async u => doc(u === CENSUS_TRADE ? landing : dated, clock), clock);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.failureKind, "validation");
    assert.deepEqual(signal.metrics, []);
    validateUsTrade(signal);
  }
  assert.deepEqual(reportedExports(data.replace("more", "less"), "2026-09"), { level: 321.5, change: -5.8 });
  assert.throws(() => reportedExports(data.replace("$5.8 billion more than", "up less than $0.1 billion from"), "2026-09"));
  assert.throws(() => tradePeriod(title.replace("September", "September and Annual")));
  assert.throws(() => tradeReleaseTime("FOR RELEASE AT 8:30 AM, EDT, Thursday, July 3, 2024"));
});

test("a joint December release supports the original annual and monthly permanent URLs", async () => {
  const annual = "U.S. International Trade in Goods and Services, December and Annual 2024";
  const figure = "December exports were $266.5 billion, $7.1 billion less than November exports.";
  const day = "Wednesday, February 5, 2025";
  const urls = beaTradeUrls("2024-12", "2025-02-05");
  const requests: string[] = [];
  const candidate = await collectUsTrade(async u => {
    requests.push(u);
    if (u === urls[0]) throw new SourceMissingError("Source HTTP 404");
    return doc(u === CENSUS_TRADE ? "FOR IMMEDIATE RELEASE: " + day + " " + annual + " " + figure :
      annual + " FOR RELEASE AT 8:30 AM, EST, " + day + " " + figure);
  }, captured);
  assert.deepEqual(requests, [CENSUS_TRADE, ...urls]);
  assert.equal(candidate.source.observedAt, "2024-12-31");
  assert.equal(candidate.metrics[1].value, -7.1);
  const outage = await collectUsTrade(async u => {
    if (u === CENSUS_TRADE) return doc("FOR IMMEDIATE RELEASE: " + day + " " + annual + " " + figure);
    throw new SourceTransportError("outage");
  }, captured);
  assert.equal(outage.failureKind, "transport");
});

test("the frozen study excludes an early first session and both colliding releases, then uses the prior dated fixes", () => {
  const make = (release: string) => ({ release, kind: "reported" as const, monthlyExportHeadlineMillions: 200000,
    changeOrBoundMillions: -1000, beaSHA256: "e".repeat(64), pdfSHA256: "a".repeat(64) });
  const records = { "2025-05": make("2025-07-02T08:30:00-04:00"), "2025-06": make("2025-08-05T08:30:00-04:00"),
    "2025-07": make("2025-09-04T08:30:00-04:00"), "2025-08": make("2025-09-04T08:30:00-04:00") };
  const out = ft900Targets(records, ["2025-07-02", "2025-07-03", "2025-08-05", "2025-08-06", "2025-09-04", "2025-09-05"]);
  assert.deepEqual(Object.fromEntries(Object.entries(out.excluded)), { "2025-05": "shortened first session", "2025-07": "shared target", "2025-08": "shared target" });
  assert.deepEqual([...out.features.keys()], ["2025-08-06"]);
  assert.equal(out.features.get("2025-08-06")?.exportChangePercent, -100000 / 201000);
  const rates = [{ date: "2025-08-04", value: 1.15 }, { date: "2025-08-05", value: 1.14 }, { date: "2025-08-06", value: 1.17 }];
  assert.deepEqual(priorDollarFix("2025-08-06", rates)?.dates, ["2025-08-04", "2025-08-05"]);
  assert.equal(priorDollarFix("2025-08-15", rates), null);
});
