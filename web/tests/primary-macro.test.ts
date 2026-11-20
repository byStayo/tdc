import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fedMarketProviders, h15YieldPoints, treasuryYieldPoints, nyFedRatePoints, nyFedReverseRepo } from "../lib/consensus/fed-market-data.ts";
import { balanceSheetPoints, bankCreditPoints, broadDollarPoints } from "../lib/consensus/board-statistics.ts";
import { permitsModelInputs } from "../lib/consensus/model.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const doc = (text: string) => ({ text, sha256: "0".repeat(64), retrievedAt: "2026-11-18T19:50:00.000Z" });
const table = (rows: string[][], attrs = "") => `<table ${attrs}>${rows.map(row =>
  "<tr>" + row.map(cell => "<td>" + cell + "</td>").join("") + "</tr>").join("")}</table>`;

test("Treasury uses only the requested constant maturities and rejects future observations", () => {
  const xml = '<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"><entry><m:properties>' +
    '<d:NEW_DATE m:type="Edm.DateTime">2026-11-17T00:00:00</d:NEW_DATE>' +
    '<d:BC_2YEAR>4.80</d:BC_2YEAR><d:BC_3YEAR>6.20</d:BC_3YEAR>' +
    '<d:BC_10YEAR>5.10</d:BC_10YEAR><d:BC_30YEAR>5.46</d:BC_30YEAR></m:properties></entry></feed>';
  const series = treasuryYieldPoints(xml, 2026, "2026-11-18");
  assert.deepEqual(Object.values(series).map(points => points[0].value), [4.8, 5.1, 5.46]);
  assert.throws(() => treasuryYieldPoints(xml, 2026, "2026-11-16"), /Invalid dates/);
  assert.throws(() => treasuryYieldPoints(xml.replace("d:BC_2YEAR", "d:DifferentField"), 2026, "2026-11-18"), /2-year/);
});

test("reference rates verify type and each effective date, including a real zero rate", () => {
  const row = { effectiveDate: "2026-11-17", type: "SOFR", percentRate: 0 };
  const source = (refRates: typeof row[]) => JSON.stringify({ refRates });
  assert.deepEqual(nyFedRatePoints(source([row]), "SOFR", "2026-11-18"), [{ date: row.effectiveDate, value: 0 }]);
  assert.throws(() => nyFedRatePoints(source([row]), "EFFR", "2026-11-18"), /EFFR row/);
  assert.throws(() => nyFedRatePoints(source([row, row]), "SOFR", "2026-11-18"), /Invalid dates/);
});

test("the verified Board fallback preserves series identities and cited origin", async () => {
  const csv = 'Unit:,Percent:_Per_Year,Percent:_Per_Year,Percent:_Per_Year\n' +
    'Time Period,RIFLGFCY10_N.B,RIFLGFCY30_N.B,RIFLGFCY02_N.B\n2026-11-16,5.12,5.46,4.83';
  assert.equal(h15YieldPoints(csv, "2026-11-18").DGS2[0].value, 4.83);
  assert.throws(() => h15YieldPoints(csv.replace("Percent:_Per_Year", "Millions"), "2026-11-18"), /units/);
  const urls: string[] = [];
  const sources = fedMarketProviders(async url => {
    urls.push(url);
    if (url.startsWith("https://home.treasury.gov")) throw new Error("Treasury unavailable");
    return doc(csv);
  }, doc("").retrievedAt);
  const readings = await Promise.all([sources.DGS10.read(), sources.DGS30.read(), sources.DGS2.read()]);
  assert.equal(urls.length, 2);
  assert.ok(readings.every(reading => reading.source?.url === "https://www.federalreserve.gov/releases/h15/"));
});

test("repo preserves the result timestamp and excludes test operations on the same day", () => {
  const row = {
    note: "", auctionStatus: "Results", operationType: "Reverse Repo", operationMethod: "Fixed Rate",
    term: "Overnight", operationDate: "2026-11-18", settlementDate: "2026-11-18",
    lastUpdated: "2026-11-18 13:15:28", totalAmtAccepted: 331000000,
    details: [{ securityType: "Treasury", amtAccepted: 331000000 }],
  };
  const source = (...operations: typeof row[]) => JSON.stringify({ repo: { operations } });
  assert.deepEqual(nyFedReverseRepo(source({ ...row, note: "Small Value Exercise" }, row), doc("").retrievedAt), {
    releasedAt: "2026-11-18T18:15:28.000Z", series: [{ date: "2026-11-18", value: 0.331 }],
  });
  assert.throws(() => nyFedReverseRepo(source(row, row), doc("").retrievedAt), /Invalid dates/);
  assert.throws(() => nyFedReverseRepo(source(row), "2026-11-18T18:15:27.000Z"), /Invalid regular/);
});

test("H.4.1 separates the Wednesday position from the two week averages", () => {
  const headers = ["Reserve Bank credit", "Averages of daily figures", "Wednesday Nov 11, 2026"];
  const sheet = "Release Date: November 12, 2026" + table([
    headers, ["Week ended Nov 11, 2026"],
    ["U.S. Treasury, General Account", "914,370", "-42,805", "-39,446", "912,134"],
    ["Reserve balances with Federal Reserve Banks", "2,960,603", "30,515", "105,573", "2,969,977"],
  ]) + table([["Assets, liabilities, and capital", "Eliminations from consolidation", "Wednesday Nov 11, 2026"],
    ["Total assets", "(0)", "&#xa0; 6,758,867", "10,722", "178,405"]]);
  const parsed = balanceSheetPoints(doc(sheet));
  assert.deepEqual(Object.values(parsed).map(point => point.value), [6758867, 914370, 2960603]);
  assert.throws(() => balanceSheetPoints(doc(sheet.replace("Week ended Nov 11", "Week ended Nov 04"))), /periods differ/);
});

test("H.8 and H.10 validate the published basis and reconcile the latest FX vintage", () => {
  const bank = "Release Date: November 13, 2026 Seasonally adjusted, billions of dollars." + table([
    ["Account", "2026 Sep", "2026 Oct", "Week ending"], ["Oct 28", "Nov 04"],
    ["1", "Bank credit", "19,883.1", "20,000.0", "20,025.1", "20,083.1"],
    ["10", "Commercial and industrial loans", "2,959.0", "2,992.9", "2,997.8", "2,997.2"],
  ], 'id="h8t2"');
  assert.equal(bankCreditPoints(doc(bank)).BUSLOANS.at(-1)?.value, 2992.9);
  assert.equal(bankCreditPoints(doc(bank)).TOTBKCR.at(-1)?.date, "2026-11-04");
  const fx = doc("Release Date: November 16, 2026" + table([
    ["COUNTRY", "CURRENCY", "Nov. 12", "Nov. 13"], ["1) BROAD", "JAN06=100", "122.5433", "122.6503"],
  ]));
  const history = table([["12-NOV-26", "122.5433"], ["13-NOV-26", "122.6503"]],
    'title="Nominal Broad Dollar Index - Daily Index"');
  assert.equal(broadDollarPoints(fx, doc(history)).at(-1)?.value, 122.6503);
  assert.throws(() => broadDollarPoints(fx, doc(history.replace("122.6503", "122.9999"))), /rolling index differ/);
});

test("only an in-scope FRED score with current data excludes a model input", () => {
  const snap = JSON.parse(readFileSync(new URL("../lib/consensus/current.json", import.meta.url), "utf8")) as Snapshot;
  const original = snap.signals.find(signal => signal.id === "fred-DGS10")!;
  const source = { ...original.source, url: "https://fred.stlouisfed.org/series/DGS10" };
  const snapshot = { ...snap, signals: [{ ...original, source }] };
  assert.equal(permitsModelInputs(snapshot, "SPY", "daily"), false);
  snapshot.signals[0].directionalInstruments = ["SPY"];
  assert.equal(permitsModelInputs(snapshot, "TLT", "daily"), true);
  snapshot.signals[0].source.observedAt = "2026-01-02";
  assert.equal(permitsModelInputs(snapshot, "SPY", "daily"), true);
  snapshot.signals[0].source = { ...original.source, url: "https://home.treasury.gov/treasury-daily-interest-rate-xml-feed" };
  assert.equal(permitsModelInputs(snapshot, "SPY", "daily"), true);
});
