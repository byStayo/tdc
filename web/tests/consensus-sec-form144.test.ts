import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { filingBreadth } from "../scripts/research-sec-form144.ts";
import { attachForm144Sources, form144EditorialSource, validateForm144Source } from "../lib/sec-form144-editorial.ts";
import type { EditorialEvidence, EditorialSource } from "../scripts/collect-editorial-evidence.ts";
import { validateEditorialPublication } from "../scripts/publish-editorial-brief.ts";

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

test("the editorial source binds a proposed sale to the same EDGAR accession and its actual publication clock", () => {
  const acceptedAt = "2026-11-12T12:58:20.000Z", cutoff = "2026-11-14T13:00:00.000Z";
  const cik = "0001321655", accession = "0001950047-26-010983";
  const folder = "https://www.sec.gov/Archives/edgar/data/1321655/000195004726010983/";
  const document = { url: folder + "primary_doc.xml", retrievedAt: "2026-11-13T13:00:00.000Z", sha256: "a".repeat(64) };
  const catalog = { url: `https://data.sec.gov/submissions/CIK${cik}.json`, retrievedAt: "2026-11-14T13:01:01.000Z", sha256: "b".repeat(64) };
  const proposal = { security: "Common stock", approxSaleDate: "2026-11-11", shares: 1000, marketValue: 120000 };
  const notice = { ticker: "PLTR", cik, accession, acceptedAt, filingDate: "2026-11-12", noticeDate: "2026-11-11",
    planAdoptionDates: ["2026-08-10"], proposals: [proposal], source: document };
  const source = form144EditorialSource(notice, catalog, cutoff);
  assert.equal(source.url, folder + accession + "-index.htm");
  assert.equal(source.retrievedAt, catalog.retrievedAt);
  assert.deepEqual(source.observationDates, ["2026-11-12"]);
  for (const malformed of [
    { ...source, url: folder + "other-index.htm" }, { ...source, kind: "sec" as const },
    { ...source, title: "Completed insider sale" },
    { ...source, observationDates: ["2026-11-11"] }, { ...source, retrievedAt: document.retrievedAt },
    { ...source, data: { ...source.data as object, cutoff: acceptedAt } },
    { ...source, data: { ...source.data as object, filingDate: "2099-01-01", noticeDate: "2099-01-01" } },
    { ...source, data: { ...source.data as object, catalog: { ...catalog, url: "https://data.sec.gov/submissions/CIK0000320193.json" } } },
    { ...source, data: { ...source.data as object, document: { ...document, sha256: "missing" } } },
    { ...source, data: { ...source.data as object, proposals: [{ ...proposal, sellerAddress: "private" }] } },
    { ...source, data: { ...source.data as object, planAdoptionDates: ["2026-12-01"] } },
  ]) assert.throws(() => validateForm144Source(malformed), /Invalid original SEC/);

  const base: EditorialEvidence = { schemaVersion: 1, scope: "market", collectedAt: cutoff,
    sources: Array.from({ length: 29 }, (_, i) => ({ id: `EXISTING_${i}` } as EditorialSource)), limitations: [] };
  const earlier = form144EditorialSource({ ...notice, accession: "0001950047-26-010948",
    acceptedAt: "2026-11-10T21:26:32.000Z", source: { ...document, url: document.url.replace("010983", "010948") } }, catalog, cutoff);
  const prepared = attachForm144Sources(base, [earlier, source], catalog.retrievedAt);
  assert.equal(prepared.sources.length, 30);
  assert.equal(prepared.sources.at(-1)?.id, source.id);
  assert.match(prepared.limitations.at(-1)!, /2 original notices/);
  assert.match(attachForm144Sources(base, [], catalog.retrievedAt).limitations.at(-1)!, /0 original notices/);
  assert.match(attachForm144Sources(base, null, catalog.retrievedAt).limitations.at(-1)!, /unavailable/);
  assert.throws(() => attachForm144Sources(base, [source, source], catalog.retrievedAt), /Duplicate/);
  assert.throws(() => attachForm144Sources(base, [source], cutoff), /collection time/);
  const evidence: EditorialEvidence = { ...base, collectedAt: catalog.retrievedAt, sources: [source], limitations: ["Selected issuers."] };
  const citation = { id: source.id, url: source.url, title: source.title };
  const claim = { text: "The issuer disclosed a proposed share sale.", sourceIds: [source.id] };
  const draft = { status: "ok", scope: "market", createdAt: catalog.retrievedAt, message: "Reviewed public filing.",
    sources: [citation], data: { headline: "A proposed insider sale", summary: "The proposal appears in the public filing.",
      watch: [claim], bull: [], bear: [], limitations: ["Execution requires corroboration."] } };
  assert.doesNotThrow(() => validateEditorialPublication(draft, evidence, Date.parse(catalog.retrievedAt)));
  assert.throws(() => validateEditorialPublication({ ...draft, sources: [{ ...citation, title: "Completed sale" }] },
    evidence, Date.parse(catalog.retrievedAt)), /verified proposed sale/);
  assert.throws(() => validateEditorialPublication({ ...draft, data: { ...draft.data, watch: [{ ...claim, text: "The insider completed the sale." }] } },
    evidence, Date.parse(catalog.retrievedAt)), /separately reviewed transaction/);
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
