import assert from "node:assert/strict";
import test from "node:test";
import { compareNportClose, corroborateNportCloses, nportMonthEndBinding, parseNportClose,
  readSavedKibotReference, NPORT_ALL_CLOSE_SOURCES, NPORT_CLOSE_SOURCES } from "../scripts/research-nport-close.ts";

// Synthetic values only. A fiscal year end is deliberately different from the report date.
function fixture(index = 0, value = ["1511700.00", "16710300.00", "1360900.00"][index]) {
  const source = NPORT_CLOSE_SOURCES[index];
  return `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
    <headerData><submissionType>NPORT-P</submissionType><isConfidential>false</isConfidential></headerData>
    <formData><genInfo><regName>Synthetic Fund Trust</regName><regCik>${source.cik}</regCik>
      <seriesName>Synthetic ETF</seriesName><seriesId>${source.seriesId}</seriesId>
      <repPdEnd>2026-08-31</repPdEnd><repPdDate>2025-11-30</repPdDate></genInfo>
    <invstOrSecs><invstOrSec><name>SPDR Dow Jones Industrial Average ETF Trust</name>
      <title>SPDR Dow Jones Industrial Average ETF Trust</title><cusip>78467X109</cusip>
      <balance>${source.shares}.00000000</balance><units>NS</units><curCd>USD</curCd>
      <valUSD>${value}</valUSD><payoffProfile>Long</payoffProfile><assetCat>EC</assetCat>
      <issuerCat>RF</issuerCat><invCountry>US</invCountry><isRestrictedSec>N</isRestrictedSec>
      <fairValLevel>1</fairValLevel></invstOrSec></invstOrSecs></formData></edgarSubmission>`;
}

const parse = (index = 0, xml = fixture(index)) => parseNportClose(Buffer.from(xml), NPORT_CLOSE_SOURCES[index]);

// Catches using the fiscal year end instead of the actual month-end valuation date.
test("reads USD share marks at the report date and preserves a separate fiscal year end", () => {
  const mark = parse(1);
  assert.equal(mark.reportDate, "2025-11-30");
  assert.equal(mark.fiscalYearEnd, "2026-08-31");
  assert.equal(mark.shares, 167103);
  assert.equal(mark.valueUSD, "16710300.00");
  assert.equal(mark.impliedClose, 100);
  assert.equal(mark.cusip, "78467X109");
  assert.equal(mark.units, "NS");
  assert.equal(mark.currency, "USD");
  assert.equal(mark.fairValueLevel, 1);
  assert.match(mark.sha256, /^[a-f0-9]{64}$/);
});

// Catches admitting another security, units, date, source identity or valuation basis.
test("rejects changed holding identity and noncomparable valuation fields", () => {
  for (const [from, to] of [
    ["<cusip>78467X109</cusip>", "<cusip>78467X108</cusip>"],
    ["<curCd>USD</curCd>", "<curCd>CAD</curCd>"],
    ["<units>NS</units>", "<units>PA</units>"],
    ["<fairValLevel>1</fairValLevel>", "<fairValLevel>2</fairValLevel>"],
    ["<repPdDate>2025-11-30</repPdDate>", "<repPdDate>2025-10-31</repPdDate>"],
    ["<balance>15117.00000000</balance>", "<balance>15116.00000000</balance>"],
    ["<regCik>0001545440</regCik>", "<regCik>0001545441</regCik>"],
    ["<seriesId>S000077993</seriesId>", "<seriesId>S000077992</seriesId>"],
    ["<payoffProfile>Long</payoffProfile>", "<payoffProfile>Short</payoffProfile>"],
    ["<assetCat>EC</assetCat>", "<assetCat>DCO</assetCat>"],
    ["<isRestrictedSec>N</isRestrictedSec>", "<isRestrictedSec>Y</isRestrictedSec>"],
    ["<valUSD>1511700.00</valUSD>", "<valUSD>-1511700.00</valUSD>"],
    ["<valUSD>1511700.00</valUSD>", "<valUSD>1.5117e6</valUSD>"],
  ]) assert.throws(() => parse(0, fixture().replace(from, to)), /N-PORT/);
});

// Catches selecting a derivative's underlying CUSIP or the first of duplicate holdings.
test("rejects duplicate direct holdings and XML entity declarations", () => {
  const holding = fixture().match(/<invstOrSec>.*?<\/invstOrSec>/s)![0];
  assert.throws(() => parse(0, fixture().replace("</invstOrSecs>", holding + "</invstOrSecs>")), /N-PORT/);
  assert.throws(() => parse(0, fixture().replace("<cusip>", "<reference><cusip>")
    .replace("</cusip>", "</cusip></reference>")), /N-PORT/);
  assert.throws(() => parse(0, fixture().replace("<repPdDate>", "<repPdDate>2025-11-30</repPdDate><repPdDate>")), /N-PORT/);
  assert.throws(() => parse(0, '<!DOCTYPE foo [<!ENTITY price "100">]>' + fixture()), /N-PORT/);
  assert.throws(() => parse(0, fixture().replace("http://www.sec.gov/edgar/nport", "https://invalid.example/")), /N-PORT/);
});

// Catches shifting a weekend month-end to the following full session or inventing a print clock.
test("binds the reviewed month-end to the preceding 1 pm session without an auction timestamp", () => {
  const binding = nportMonthEndBinding("2025-11-30");
  assert.equal(binding.session, "2025-11-28");
  assert.equal(binding.scheduledCloseAt, "2025-11-28T18:00:00.000Z");
  assert.equal(binding.auctionExecutionAt, null);
  assert.equal(binding.calendar, "nyse-nasdaq-core-research-2022-2025-v1");
  assert.throws(() => nportMonthEndBinding("2025-11-28"), /reviewed month-end/);
  assert.throws(() => nportMonthEndBinding("2026-11-30"), /reviewed month-end/);
});

// Catches using a majority mark, accepting fewer originals or silently widening the 15bp limit.
test("requires three agreeing original marks and compares against the existing close tolerance", () => {
  const marks = NPORT_CLOSE_SOURCES.map((_, i) => parse(i));
  const failed = compareNportClose(marks, 100.2);
  assert.equal(failed.independentFilings, 3);
  assert.equal(failed.consensusClose, 100);
  assert.equal(failed.closeToleranceBps, 15);
  assert.equal(failed.closeDifferenceBps, -19.9601);
  assert.equal(failed.rawKibotDifferenceFromReferenceBps, 20);
  assert.equal(failed.closePass, false);
  assert.equal(compareNportClose(marks, 100.1).closePass, true);
  assert.throws(() => compareNportClose(marks.slice(0, 2), 100), /three/);
  assert.throws(() => compareNportClose([marks[0], marks[0], marks[2]], 100), /three/);
  assert.throws(() => compareNportClose([marks[0], marks[1], parse(2, fixture(2, "1361036.09"))], 100), /disagree/);
  assert.throws(() => compareNportClose(marks, 0), /Kibot/);
});

// Catches dropping an ETF, treating one filing as three, or conflating the two as-of dates.
test("corroborates all five from the four reviewed originals and records exact support counts", () => {
  const rows = [
    [0, "DIA", "78467X109", 15117], [0, "QQQ", "46090E103", 11000], [0, "TLT", "464287432", 5861],
    [1, "DIA", "78467X109", 167103], [1, "SPY", "78462F103", 116889], [1, "QQQ", "46090E103", 1810],
    [2, "DIA", "78467X109", 13609], [2, "QQQ", "46090E103", 7161],
    [3, "SPY", "78462F103", 2723], [3, "IWM", "464287655", 262],
  ] as const;
  const marks = rows.map(([index, symbol, cusip, shares]) => {
    const source = NPORT_ALL_CLOSE_SOURCES[index];
    const xml = fixture().replace(NPORT_CLOSE_SOURCES[0].cik, source.cik)
      .replace(NPORT_CLOSE_SOURCES[0].seriesId, source.seriesId)
      .replace("<repPdDate>2025-11-30</repPdDate>", `<repPdDate>${source.reportDate}</repPdDate>`)
      .replace("<cusip>78467X109</cusip>", `<cusip>${cusip}</cusip>`)
      .replace("<balance>15117.00000000</balance>", `<balance>${shares}</balance>`)
      .replace("<valUSD>1511700.00</valUSD>", `<valUSD>${shares * 100}.00</valUSD>`);
    return parseNportClose(Buffer.from(xml), source, symbol);
  });
  const references = corroborateNportCloses(marks);
  assert.deepEqual(references.map(({ instrument, consensusClose, filingMarks }) => ({ instrument, consensusClose, filingMarks })), [
    { instrument: "SPY", consensusClose: 100, filingMarks: 2 },
    { instrument: "QQQ", consensusClose: 100, filingMarks: 3 },
    { instrument: "IWM", consensusClose: 100, filingMarks: 1 },
    { instrument: "DIA", consensusClose: 100, filingMarks: 3 },
    { instrument: "TLT", consensusClose: 100, filingMarks: 1 },
  ]);
  assert.deepEqual(references[0].reportDates, ["2025-11-28", "2025-11-30"]);
  assert.deepEqual(references[2].reportDates, ["2025-11-28"]);
  assert.throws(() => corroborateNportCloses(marks.slice(1)), /reviewed holdings/);
  assert.throws(() => corroborateNportCloses([...marks, marks[0]]), /reviewed holdings/);
  assert.throws(() => corroborateNportCloses(marks.map((mark, i) => i === 0 ? { ...mark, impliedClose: 101 } : mark)), /disagree/);
});

// Catches silently comparing adjusted or undated bars when reusing private research.
test("reuses a hashed private raw Kibot review without admitting other session or price bases", () => {
  const saved = {
    schemaVersion: 1, purpose: "private-month-end-close-reference", instrument: "DIA",
    evaluatedAt: "2026-11-18T20:26:17.042Z", binding: nportMonthEndBinding("2025-11-30"),
    rawKibot: { source: "https://www.kibot.com/api/history-request.html", mode: "guest-unadjusted",
      session: "2025-11-28", close: 100, sha256: "a".repeat(64),
      clockBasis: "reviewed-calendar-annotation-not-provider-auction-evidence" },
  };
  const bytes = Buffer.from(JSON.stringify(saved));
  const reference = readSavedKibotReference(bytes);
  assert.equal(reference.close, 100);
  assert.equal(reference.sha256, "a".repeat(64));
  assert.equal(reference.mode, "preserved-review");
  assert.equal(reference.reviewEvaluatedAt, "2026-11-18T20:26:17.042Z");
  for (const patch of [ { mode: "advertised-adjusted" }, { session: "2025-12-01" }, { close: 0 }, { sha256: "not-a-hash" } ]) {
    assert.throws(() => readSavedKibotReference(Buffer.from(JSON.stringify({ ...saved,
      rawKibot: { ...saved.rawKibot, ...patch } }))), /Kibot/);
  }
});
