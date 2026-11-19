import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { filingBreadth } from "../scripts/research-sec-form144.ts";

test("Form 144 breadth uses distinct issuers and the prior cutoff interval", () => {
  const rows = [
    { ticker: "PLTR", kind: "144", acceptedAt: "2026-11-10T21:26:32.000Z" },
    { ticker: "PLTR", kind: "144", acceptedAt: "2026-11-11T12:02:00.000Z" },
    { ticker: "AMD", kind: "144/A", acceptedAt: "2026-11-11T12:00:00.000Z" },
    { ticker: "AMD", kind: "4", acceptedAt: "2026-11-10T13:00:00.000Z" },
    { ticker: "MSFT", kind: "144", acceptedAt: "2026-11-11T13:00:00.000Z" },
  ] as const;
  assert.deepEqual(filingBreadth([...rows], "2026-11-10T13:00:00.000Z", "2026-11-11T13:00:00.000Z"),
    { proposals: 1, transactions: 1 });
  assert.deepEqual(filingBreadth([...rows], "2026-11-11T13:00:00.000Z", "2026-11-12T13:00:00.000Z"),
    { proposals: 1, transactions: 0 });
});

test("Form 144 extracts proposal date and plan date without carrying seller details", () => {
  const doc = `<edgarSubmission xmlns="http://www.sec.gov/edgar/ownership">
    <headerData><submissionType>144</submissionType></headerData><formData>
    <issuerInfo><issuerCik>1321655</issuerCik></issuerInfo>
    <securitiesInformation><securitiesClassTitle>Common</securitiesClassTitle><noOfUnitsSold>1000</noOfUnitsSold>
    <aggregateMarketValue>100000.50</aggregateMarketValue><approxSaleDate>11/17/2026</approxSaleDate></securitiesInformation>
    <noticeSignature><noticeDate>11/16/2026</noticeDate><planAdoptionDates><planAdoptionDate>08/11/2026</planAdoptionDate>
    </planAdoptionDates><signature>Example signer</signature></noticeSignature></formData></edgarSubmission>`;
  const file = fileURLToPath(new URL("../scripts/parse-sec-form144.py", import.meta.url));
  const normalized = JSON.parse(execFileSync("python3", ["-B", file], { input: JSON.stringify([doc]), encoding: "utf8" }));
  assert.deepEqual(normalized, [{ cik: "0001321655", noticeDate: "2026-11-16", planAdoptionDates: ["2026-08-11"],
    proposals: [{ security: "Common", approxSaleDate: "2026-11-17", shares: 1000, marketValue: 100000.5 }] }]);
});
