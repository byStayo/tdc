import { test } from "node:test";
import assert from "node:assert/strict";
import { exhibitURL, pairIssuerRevenue, readIssuerRevenue, resultsFilings, type ResultsFiling } from "../lib/consensus/issuer-revenue.ts";

const nvidia: ResultsFiling = {
  ticker: "NVDA", accession: "0001045810-26-000073", reportDate: "2026-08-26",
  filingDate: "2026-08-26", acceptedAt: "2026-08-26T20:21:19.000Z",
};
const nvidiaOriginal = `
  <h1>NVIDIA Announces Financial Results for Second Quarter Fiscal 2027</h1>
  <p>Quarter ended July 26, 2026. Revenue $96.2 billion.</p>
  <p>NVIDIA&#8217;s outlook for the third quarter of fiscal 2027 is as follows&#58;
  &#8226; Revenue is expected to be $108.0 billion, plus or minus 2%.</p>
  <p>NVIDIA CORPORATION CONDENSED CONSOLIDATED STATEMENTS OF INCOME
  (In millions, except per share data) (Unaudited) Three Months Ended July 26, July 27, 2026 2025</p>
  <table><tr><td>Revenue</td><td>$</td><td>96,221</td><td>$</td><td>46,743</td></tr></table>`;

test("uses the consolidated revenue and pairs consecutive fiscal quarters before target availability", () => {
  const current = readIssuerRevenue(nvidia, nvidiaOriginal);
  assert.equal(current.actualMillions, 96221);
  assert.equal(current.periodEnd, "2026-07-26");
  assert.deepEqual([current.guidance.lowMillions, current.guidance.highMillions], [105840, 110160]);
  const later = readIssuerRevenue({
    ...nvidia, accession: "0001045810-26-000088", reportDate: "2026-11-17",
    filingDate: "2026-11-18", acceptedAt: "2026-11-18T01:00:00.000Z",
  }, nvidiaOriginal.replace("Second Quarter", "Third Quarter")
    .replace("ended July 26", "ended October 25")
    .replace("third quarter of fiscal 2027", "fourth quarter of fiscal 2027, which includes an additional week,")
    .replace("108.0 billion, plus or minus 2%", "130.0 billion, plus or minus 3%")
    .replace("96,221", "115,844"));
  const [pair] = pairIssuerRevenue([later, current]);
  assert.equal(pair.rangeStatus, "above");
  assert.equal(pair.afterDate, "2026-11-18");
  assert.deepEqual(pairIssuerRevenue([later]), []);
  assert.throws(() => pairIssuerRevenue([current, current]), /Duplicate original/);
  assert.throws(() => pairIssuerRevenue([{ ...current, filingDate: later.periodEnd }, later]), /before the reported quarter end/);
});

test("uses AMD's absolute USD tolerance and rejects an unrecognized basis", () => {
  const amd: ResultsFiling = {
    ticker: "AMD", accession: "0000002488-25-000045", reportDate: "2025-05-06",
    filingDate: "2025-05-06", acceptedAt: "2025-05-06T20:16:45.000Z",
  };
  const document = `
    <h1>AMD Reports First Quarter 2025 Financial Results</h1>
    <p>Current Outlook</p><p>For the second quarter of 2025, AMD expects revenue to be approximately
    $7.4 billion, plus or minus $300 million.</p><p>AMD Teleconference</p>
    <p>ADVANCED MICRO DEVICES, INC. CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS
    (Millions except per share amounts and percentages) (Unaudited) Three Months Ended March 29, 2025 March 30, 2024</p>
    <table><tr><td>Net revenue</td><td>$</td><td>7,438</td><td>$</td><td>5,473</td></tr></table>`;
  const result = readIssuerRevenue(amd, document);
  assert.equal(result.periodEnd, "2025-03-29");
  assert.equal(result.actualMillions, 7438);
  assert.deepEqual([result.guidance.lowMillions, result.guidance.highMillions], [7100, 7700]);
  assert.throws(() => readIssuerRevenue(amd, document.replace("300 million", "300 thousand")), /Missing original/);
  assert.throws(() => readIssuerRevenue(amd, document.replace("second quarter of 2025", "third quarter of 2025")), /Inconsistent/);
});

test("requires an original Item 2.02 accession and an exhibit under its own directory", () => {
  const payload = { cik: "0001045810", filings: { recent: {
    accessionNumber: [nvidia.accession, "0001045810-26-000074"], form: ["8-K", "8-K/A"],
    items: ["2.02,9.01", "2.02"], filingDate: [nvidia.filingDate, nvidia.filingDate],
    reportDate: [nvidia.reportDate, nvidia.reportDate], acceptanceDateTime: [nvidia.acceptedAt, nvidia.acceptedAt],
  } } };
  assert.deepEqual(resultsFilings("NVDA", payload, "2025-02-01", "2026-08-27T00:00:00.000Z"), [nvidia]);
  assert.throws(() => resultsFilings("AMD", payload, "2025-02-01", "2026-08-27T00:00:00.000Z"), /issuer mismatch/);
  const prefix = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/";
  const index = '<tr><td><a href="q2fy27pr.htm">Exhibit</a></td><td>EX-99.1</td></tr>';
  assert.equal(exhibitURL(nvidia, index), prefix + "q2fy27pr.htm");
  assert.throws(() => exhibitURL(nvidia, index.replace("q2fy27pr.htm", "../other.htm")), /Unexpected/);
  assert.throws(() => exhibitURL(nvidia, index + index), /Expected one original/);
});
