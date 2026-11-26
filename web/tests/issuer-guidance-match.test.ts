import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectIssuerGuidance, validateIssuerGuidance } from "../lib/consensus/issuer-guidance-match.ts";
import { filedGuidanceRows } from "../lib/consensus/guidance.ts";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const checked = "2026-11-24T01:00:00.000Z";
const guidance = "0000002488-26-000121", results = "0000002488-26-000188", quarterly = "0000002488-26-000191";
const folder = (accession: string) => "https://www.sec.gov/Archives/edgar/data/2488/" + accession.replaceAll("-", "") + "/";
const idx = (accession: string) => folder(accession) + accession + "-index.htm";
const rows = [
  [guidance, "2026-08-04", "2026-08-04", "8-K", "2.02,9.01", "2026-08-04T20:16:24.000Z", "2026-08-04 16:16:24"],
  [results, "2026-11-03", "2026-11-03", "8-K", "2.02,9.01", "2026-11-03T21:16:27.000Z", "2026-11-03 16:16:27"],
  [quarterly, "2026-11-04", "2026-09-26", "10-Q", "", "2026-11-03T23:00:17.000Z", "2026-11-03 18:00:17"],
];
const dates = ["Filing Date", "Period of Report", "Accepted"];
const catalogUrl = "https://data.sec.gov/submissions/CIK0000002488.json";
function catalog(extra: string[][] = [], base = rows) {
  const all = [...base, ...extra];
  return JSON.stringify({cik: "0000002488", filings: { recent: Object.fromEntries(
    ["accessionNumber", "filingDate", "reportDate", "form", "items", "acceptanceDateTime"]
      .map((key, i) => [key, all.map(row => row[i])])) }});
}
function release(q: string, next: string, end: string, revenue: string, forecast: string) {
  return `<h1>AMD Reports ${q} Quarter 2026 Financial Results</h1><p>Current Outlook</p>
    <p>For the ${next} quarter of 2026, AMD expects revenue to be approximately $${forecast} billion, plus or minus $300 million.</p>
    <p>AMD Teleconference</p><p>ADVANCED MICRO DEVICES, INC. CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS
    (Millions except per share amounts and percentages) (Unaudited) Three Months Ended ${end}</p>
    <table><tr><td>Net revenue</td><td>$</td><td>${revenue}</td><td>Revenue last year</td></tr></table>`;
}
const xml = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:dei="http://xbrl.sec.gov/dei/2026"
  xmlns:gaap="http://fasb.org/us-gaap/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
  <xbrli:context id="q"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000002488</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2026-06-28</xbrli:startDate><xbrli:endDate>2026-09-26</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="year"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000002488</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>2025-12-28</xbrli:startDate><xbrli:endDate>2026-09-26</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <dei:EntityCentralIndexKey contextRef="year">0000002488</dei:EntityCentralIndexKey>
  <dei:DocumentFiscalYearFocus contextRef="year">2026</dei:DocumentFiscalYearFocus>
  <dei:DocumentFiscalPeriodFocus contextRef="year">Q3</dei:DocumentFiscalPeriodFocus>
  <dei:DocumentType contextRef="year">10-Q</dei:DocumentType><dei:DocumentPeriodEndDate contextRef="year">2026-09-26</dei:DocumentPeriodEndDate>
  <gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="q" unitRef="usd">13377000000</gaap:RevenueFromContractWithCustomerExcludingAssessedTax>
  <gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="year" unitRef="usd">35166000000</gaap:RevenueFromContractWithCustomerExcludingAssessedTax>
</xbrli:xbrl>`;
const dataURL = folder(quarterly) + "revenue_htm.xml";
function documents() {
  const files = new Map([[catalogUrl, catalog()], [dataURL, xml]]);
  for (const [i, row] of rows.entries()) {
    const [acc, filed, date, form, , , accepted] = row, report = form === "10-Q";
    const link = report ? "revenue_htm.xml" : "quarter.htm";
    files.set(idx(acc), acc + dates.map((key, n) => `<div class="infoHead">${key}</div><div class="info">${[filed,date,accepted][n]}</div>`).join("") +
      `<tr><td>${report ? "<b>EXTRACTED</b> XBRL INSTANCE DOCUMENT" : "EX-99.1"}</td><td><a href="${link}">Document</a></td></tr>`);
    if (!report) files.set(folder(acc) + link, i === 0 ? release("Second", "third", "June 27, 2026", "11,000", "13.0") :
      release("Third", "fourth", "September 26, 2026", "13,377", "17.0"));
  }
  return files;
}
function collect(sources: Map<string,string>, at = checked, directory?: string, previous?: Signal, calls?: string[]) {
  return collectIssuerGuidance("AMD", async url => {
    calls?.push(url);
    const value = sources.get(url);
    if (value === undefined) throw new SourceTransportError("Simulated interruption");
    return { url, text: value, sha256: createHash("sha256").update(value).digest("hex"), retrievedAt: at };
  }, () => at, directory, previous);
}
function snapshot(s: Signal): Snapshot {
  return {schemaVersion: 1, id: checked.replace(/[:.]/g,"-"), issuedAt: checked, cutoff: checked, engineVersion: "test",
    origin: "prospective", signals: [s], catalysts: [], sourcesAttempted: 1, collectionErrors: []};
}

test("matches the issuer, target period, disjoint filings and exact consolidated USD quarter", async () => {
  const s = await collect(documents());
  assert.equal(s.status, "available");
  assert.equal(s.source.releasedAt, "2026-11-04");
  assert.equal(s.source.observedAt, "2026-09-26");
  assert.equal(s.issuerGuidance?.quarterly.filed, "2026-11-04");
  assert.equal(s.issuerGuidance?.quarterly.acceptedAt, "2026-11-03T23:00:17.000Z");
  assert.equal(s.issuerGuidance?.publiclyKnownBy, "2026-11-05T05:00:00.000Z");
  assert.equal(s.issuerGuidance?.firstEvidenceCompleteAt, checked);
  assert.match(s.summary, /\$77m above/);
  assert.deepEqual(s.metrics.map(v => v.value), [12700,13000,13300,13377]);
  assert.deepEqual(s.instruments, ["MARKET","SPY","QQQ"]);
  assert.deepEqual(s.scores, {daily:null, weekly:null, monthly:null});
  assert.doesNotThrow(() => validateIssuerGuidance(s, checked));
  assert.throws(() => validateIssuerGuidance({...s, metrics: []}, checked));
  assert.throws(() => validateIssuerGuidance({...s, instruments:["IWM"]}, checked));
  assert.throws(() => validateIssuerGuidance({...s,issuerGuidance:{...s.issuerGuidance!,firstEvidenceCompleteAt:"2026-11-03T20:00:00.000Z"}},checked));
  const original = s.issuerGuidance!;
  for (const change of [{rawFiling:"prohibited"}, {publiclyKnownBy:original.quarterly.acceptedAt},
    {quarterly:{...original.quarterly,rawFiling:"prohibited"}}, {quarterly:{...original.quarterly,filed:"1900-01-01"}},
    {guidance:{...original.guidance,filed:"2026-08-26"}}, {results:{...original.results,filed:"2026-11-08"}}]) {
    assert.throws(() => validateIssuerGuidance({...s,issuerGuidance:{...original,...change}},checked));
  }
  assert.equal(filedGuidanceRows(snapshot(s), "QQQ", checked).length, 1);
  assert.equal(filedGuidanceRows(snapshot(s), "IWM", checked).length, 0);
  assert.equal(filedGuidanceRows(snapshot(s), "TLT", checked).length, 0);
  assert.equal(filedGuidanceRows(snapshot(s), "SPY", "2026-11-03T22:00:00Z").length, 0);
});

test("EDGAR acceptance, filing-day dissemination and first witnessed intraday availability remain distinct", async () => {
  for (const at of ["2026-11-03T23:15:00.000Z","2026-11-04T10:59:59.000Z"]) {
    const s = await collect(documents(),at);
    assert.equal(s.status,"not_formed"); assert.equal(s.issuerGuidance,undefined);
  }
  const morning = "2026-11-04T14:00:00.000Z", early = await collect(documents(),morning);
  assert.equal(early.status,"available"); assert.equal(early.issuerGuidance?.publiclyKnownBy,morning);
  assert.equal(early.issuerGuidance?.firstEvidenceCompleteAt,morning); assert.equal(early.source.releasedAt,"2026-11-04");
  assert.equal(filedGuidanceRows(snapshot(early),"SPY","2026-11-04T13:59:59.000Z").length,0);
  for (const index of [0,1]) {
    const dates = rows.map(row => [...row]), edited = dates[index];
    const source = documents();
    edited[1] = index ? "2026-11-05" : "2026-08-05";
    edited[5] = index ? "2026-11-04T23:40:00.000Z" : "2026-08-04T23:00:00.000Z";
    edited[6] = index ? "2026-11-04 18:40:00" : "2026-08-04 19:00:00";
    source.set(catalogUrl,catalog([],dates));
    source.set(idx(edited[0]),source.get(idx(edited[0]))!.replace('class="info">'+rows[index][1],'class="info">'+edited[1])
      .replace(rows[index][6],edited[6]));
    const s = await collect(source);
    assert.equal(s.status,"available");
    assert.equal((index ? s.issuerGuidance!.results : s.issuerGuidance!.guidance).filed,edited[1]);
    assert.equal(s.source.releasedAt,index ? "2026-11-05" : "2026-11-04");
    assert.equal(s.issuerGuidance!.publiclyKnownBy,index ? "2026-11-06T05:00:00.000Z" : "2026-11-05T05:00:00.000Z");
  }
});

test("keeps current 8-K results pending until the separate 10-Q exists and rejects amendments", async () => {
  const before = await collect(documents(), "2026-11-03T22:00:00.000Z");
  assert.equal(before.status, "not_formed");
  assert.equal(before.source.observedAt, null);
  assert.equal(before.issuerGuidance, undefined);
  const after = documents();
  after.set(catalogUrl,catalog([["0000002488-26-000201","2026-11-20","2026-09-26","10-Q/A","","2026-11-20T22:00:00.000Z"]]));
  const amended = await collect(after);
  assert.equal(amended.failureKind, "validation"); assert.match(amended.collectionNote!, /amended quarterly/);
  after.set(catalogUrl,catalog([["0000002488-26-000202","2026-11-20","2026-08-04","8-K/A","2.02","2026-11-20T22:00:00.000Z"]]));
  assert.equal((await collect(after)).status, "unavailable");
});

test("withheld future guidance still permits validation of the previously guided quarter", async () => {
  const files = documents(), resultURL = folder(results) + "quarter.htm", guideURL = folder(guidance) + "quarter.htm";
  files.set(resultURL,files.get(resultURL)!.replace("AMD expects revenue","AMD previously expected revenue"));
  assert.equal((await collect(files)).issuerGuidance?.actualMillions,13377);
  files.set(guideURL,files.get(guideURL)!.replace("AMD expects revenue","AMD previously expected revenue"));
  assert.equal((await collect(files)).status,"unavailable");
});

test("refuses segment-only, YTD, incorrect currency, wrong fiscal identities and mismatching revenue", async () => {
  for (const wrong of [xml.replace("</xbrli:identifier>", "</xbrli:identifier><xbrli:segment/>"),
    xml.replace("2026-06-28", "2025-12-28"), xml.replace("iso4217:USD", "iso4217:EUR"), xml.replace(">Q3<", ">Q2<"),
    xml.replace("13377000000", "13350000000"), xml.replaceAll("0000002488","0001045810"),
    xml.replace("fasb.org", "fasbxorg"), xml.replace("xbrl.sec.gov", "xbrlxsec.gov")]) {
    const docs = documents(); docs.set(dataURL,wrong);
    const s = await collect(docs);
    assert.equal(s.status,"unavailable"); assert.equal(s.failureKind,"validation"); assert.deepEqual(s.metrics,[]);
  }
  const docs = documents(); docs.set(idx(quarterly),docs.get(idx(quarterly))!.replace("revenue_htm.xml","https://other.example/revenue_htm.xml"));
  assert.equal((await collect(docs)).failureKind,"validation");
});

test("reuses accession receipts, keeps the original comparison, and distinguishes a newer unmatched quarter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "issuer-guidance-match-"));
  try {
    const files = documents(), first = await collect(files, checked, dir), calls: string[] = [];
    const next = "2026-11-25T18:00:00.000Z", again = await collect(files, next, dir, first, calls);
    assert.deepEqual(calls, [catalogUrl,dataURL]); assert.equal(again.issuerGuidance?.firstEvidenceCompleteAt,checked);
    assert.equal(observationDigest(snapshot(first)), observationDigest(snapshot(again)));
    assert.equal((JSON.parse(await readFile(join(dir,"guidance-matches","AMD-2026-09-26.json"),"utf8"))).catalog.retrievedAt, checked);
    assert.equal((await collect(new Map(), next, dir, first)).failureKind, "transport");
    const revised = xml.replace("13377000000","13000000000");
    files.set(dataURL,revised);
    const correction = await collect(files,next,dir,first);
    assert.equal(correction.status,"unavailable"); assert.match(correction.collectionNote!, /changed the originally captured/);
    const digest = createHash("sha256").update(revised).digest("hex");
    assert.equal(JSON.parse(await readFile(join(dir,quarterly+"-instance-"+digest+".json"),"utf8")).sha256,digest);
    files.set(dataURL,xml.replace("<xbrli:context","\n<xbrli:context"));
    assert.equal(observationDigest(snapshot(await collect(files,next,dir,first))),observationDigest(snapshot(first)));
    const stale = await collect(files,"2027-03-01T13:00:00.000Z",dir,first);
    assert.equal(stale.status,"stale"); assert.equal(stale.issuerGuidance?.firstEvidenceCompleteAt,checked);
    files.set(catalogUrl, catalog([["0000002488-27-000005","2027-02-02","2027-02-02","8-K","2.02","2027-02-02T21:20:00.000Z"]]));
    const missing = await collect(files,"2027-02-03T13:00:00.000Z",dir,first);
    assert.equal(missing.status,"not_formed"); assert.equal(missing.issuerGuidance,undefined);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test("the ordinary daily collector includes both issuer sources and preserves all directional gates", async () => {
  const files = documents();
  const snapshot = await collectSnapshot(async url => files.has(url) ? new Response(files.get(url)) : new Response("absent",{status:404}));
  const amd = snapshot.signals.find(s => s.id === "sec-issuer-guidance-amd")!;
  assert.equal(amd.issuerGuidance?.actualMillions,13377); assert.deepEqual(amd.directionalInstruments,[]);
  assert.deepEqual(amd.scores,{daily:null,weekly:null,monthly:null});
  assert.ok(snapshot.signals.some(s => s.id === "sec-issuer-guidance-nvda" && s.status === "unavailable"));
  validateSnapshot(snapshot);
});
