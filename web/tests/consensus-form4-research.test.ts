import assert from "node:assert/strict";
import test from "node:test";
import { historicalResearchSession } from "../lib/consensus/research-session-calendar.ts";
import { insiderTrainingRows } from "../scripts/research-sec-insiders.ts";
import { issuerBreadth } from "../scripts/research-sec-insider-breadth.ts";

const beforeFirstPublicForecast = "2026-11-03T06:28:30.460Z";
const event = (filingDate: string, signedCents: number, ticker: "AAPL" | "NVDA" = "AAPL") => ({
  accession: "0000000123-25-000001", transaction: "1", ticker,
  filingDate, transactionDate: filingDate, signedCents,
});
const price = (session: string) => ({ ...historicalResearchSession(session)!, open: 100, close: 101 });

test("Form 4 filings aggregate into one next-session label and never shift to a later available bar", () => {
  const expected = ["2025-11-26", "2025-11-28", "2025-12-01", "2025-12-02"];
  const filings = [event("2025-11-26", 10_000_000), event("2025-11-28", 50_000_000), event("2025-11-29", -10_000_000)];
  const rows = insiderTrainingRows(filings, expected, expected.map(price), "SPY", beforeFirstPublicForecast);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "SPY:2025-12-01");
  assert.equal(rows[0].issuedAt, "2025-12-01T13:00:00.000Z");
  assert.deepEqual(rows[0].features, [Math.asinh(0.4)]);
  assert.equal(rows[0].up, 1);
  assert.deepEqual(insiderTrainingRows(filings, expected, [price("2025-12-02")], "SPY", beforeFirstPublicForecast), []);
});

test("DIA admits NVIDIA filings once their target session reaches the effective index date", () => {
  const expected = ["2024-11-06", "2024-11-07", "2024-11-08", "2024-11-11"];
  const filings = [event("2024-11-06", -70_000_000, "NVDA"), event("2024-11-07", -40_000_000, "NVDA")];
  const rows = insiderTrainingRows(filings, expected, expected.map(price), "DIA", beforeFirstPublicForecast);
  assert.deepEqual(rows.map(row => [row.id, row.features[0]]), [["DIA:2024-11-08", Math.asinh(-0.4)]]);
});

test("issuer breadth nets repeated disclosures before assigning equal issuer weight", () => {
  const schedule = ["2025-11-28", "2025-12-01"];
  const issuerDays = [
    { cik: "10", filingDate: "2025-11-28", netCents: -9_000_000 },
    { cik: "10", filingDate: "2025-11-29", netCents: 10_000_000 },
    { cik: "20", filingDate: "2025-11-28", netCents: -1_000_000_000 },
    { cik: "30", filingDate: "2025-11-28", netCents: 1_000_000 },
    { cik: "40", filingDate: "2025-11-28", netCents: 0 },
  ];
  assert.deepEqual([...issuerBreadth(issuerDays, schedule)], [["2025-12-01", 1 / 3]]);
});
