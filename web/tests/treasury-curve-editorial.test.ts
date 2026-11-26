import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { treasuryYieldFile } from "../lib/consensus/fed-market-data.ts";
import { attachTreasuryCurve, collectOfficialTreasuryCurve, collectTreasuryCurve, preparedTreasuryDocuments, TREASURY_CURVE_ID, type TreasuryCurveData } from "../lib/treasury-curve-editorial.ts";
import { assertPublicURL, collectEditorialEvidence, saveEditorialEvidence, type EditorialSource } from "../scripts/collect-editorial-evidence.ts";
import { macro } from "../lib/consensus/collector.ts";
import { digest } from "../lib/consensus/history.ts";
import { validateEditorialPublication } from "../scripts/publish-editorial-brief.ts";

const now = Date.parse("2026-11-20T09:24:54.308Z");
const stamp = new Date(now).toISOString();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const head = '<feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">';
function row(date: string, two = "4.76", ten = "5.04", thirty = "5.40") {
  return '<entry><m:properties><d:NEW_DATE>' + date + 'T00:00:00</d:NEW_DATE><d:BC_2YEAR>' + two + '</d:BC_2YEAR><d:BC_10YEAR>' + ten +
    '</d:BC_10YEAR><d:BC_30YEAR>' + thirty + '</d:BC_30YEAR></m:properties></entry>';
}
const previous = row("2026-11-18", "4.80", "5.07", "5.41"), latest = row("2026-11-19");
const xml = head + previous + latest + '</feed>';
const expected = { date: "2026-11-19", twoYearPercent: 4.76, tenYearPercent: 5.04, thirtyYearPercent: 5.40 };
const capture = (text: string, retrievedAt = new Date().toISOString()) => ({ text, sha256: hash(text), retrievedAt });
const evidence = (sources: EditorialSource[]) => ({ schemaVersion: 1 as const, scope: "market" as const, collectedAt: stamp, sources, limitations: ["Dated official sources."] });
const candidate = (source: EditorialSource) => ({ status:"ok", scope:"market", createdAt:stamp, model:"Codex editorial workflow", message:"Treasury curve.",
  data:{ headline:"Published Treasury rates", summary:"The official curve covers three maturities.", bull:[], bear:[],
    watch:[{text:"The ten-year yield reached 5.04%.",sourceIds:[source.id]}], limitations:["Observation dates come from Treasury."] },
  sources:[{ id:source.id, title:source.title, url:source.url }] });

test("weekday collection recovers an HTTP 503 and seals the successful Treasury bytes and retrieval time", async t => {
  t.mock.timers.enable({ apis:["Date"], now });
  const root = await mkdtemp(join(tmpdir(), "tdc-curve-"));
  try {
    const urls: string[] = [];
    const e = await collectEditorialEvidence(async (input, init) => {
      const url = String(input);
      if (new URL(url).hostname !== "home.treasury.gov") return new Response("unavailable", {status:503});
      urls.push(url);
      assert.equal(init?.redirect, "error");
      if (urls.length === 1) return new Response("temporary response", {status: 503, headers: {"Retry-After":"0"}});
      t.mock.timers.setTime(now + 1000);
      return new Response(xml);
    }, {archiveRoot:root});
    assert.deepEqual(urls, [treasuryYieldFile(2026), treasuryYieldFile(2026)]);
    const source = e.sources.find(s => s.id === TREASURY_CURVE_ID)!;
    assert.equal(source.status, "ok");
    const recoveredAt = new Date(now + 1000).toISOString();
    assert.equal(source.retrievedAt, recoveredAt);
    const data = source.data as TreasuryCurveData;
    assert.deepEqual(data.latest, expected);
    assert.deepEqual(data.previous,{date:"2026-11-18",twoYearPercent:4.80,tenYearPercent:5.07,thirtyYearPercent:5.41});
    assert.deepEqual(data.documents, [{url:urls[0],retrievedAt:recoveredAt,sha256:hash(xml)}]);
    assert.deepEqual(source.observationDates, [data.latest.date,data.previous.date]);
    await collectTreasuryCurve(async () => capture(xml), root);
    const folder = join(root, ".editorial/treasury-curves");
    assert.deepEqual(await readdir(folder), [hash(xml)+".json"]);
    const file = join(folder, hash(xml)+".json");
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal(gunzipSync(Buffer.from(JSON.parse(await readFile(file, "utf8")).gzipBase64, "base64")).toString(),xml);
    assert.equal(validateEditorialPublication({...candidate(source), createdAt: recoveredAt}, {...evidence([source]), collectedAt:recoveredAt}, now + 1000).brief.sources?.[0]?.id, source.id);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("weekday forecasts replay the exact Treasury XML with its original observation and retrieval clocks", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const root = await mkdtemp(join(tmpdir(), "tdc-prepared-curve-"));
  try {
    const dates = Array.from({length: 35}, (_, i) => new Date(Date.parse("2026-10-15") + i * 86400000))
      .filter(date => date.getUTCDay() % 6 !== 0);
    const original = head + dates.map(date => row(date.toISOString().slice(0, 10))).join("") + latest + "</feed>";
    const source = await collectTreasuryCurve(async () => capture(original), root);
    const packet = evidence([source]);
    const filename = basename(await saveEditorialEvidence(packet, root));
    const later = new Date(now + 60000).toISOString();
    t.mock.timers.setTime(Date.parse(later));
    const read = () => preparedTreasuryDocuments(root, filename, digest(packet), later);
    const requested: string[] = [];
    const signals = await macro(async url => { requested.push(url); return new Response("", {status: 503}); }, await read());
    for (const id of ["fred-DGS2", "fred-DGS10", "fred-DGS30"]) {
      const signal = signals.find(item => item.id === id)!;
      assert.equal(signal.status, "available");
      assert.equal(signal.source.observedAt, "2026-11-19");
      assert.equal(signal.source.retrievedAt, stamp);
      assert.equal(signal.source.sha256, hash(original));
    }
    assert.ok(requested.length > 0 && requested.every(url => !url.includes("treasury.gov") && !url.includes("rel=H15")));
    await assert.rejects(preparedTreasuryDocuments(root, filename, "0".repeat(64), later), /does not match/);
    await assert.rejects(preparedTreasuryDocuments(root, filename, digest(packet), "2026-11-21T16:00:00.000Z"), /does not match/);
    const changed = structuredClone(packet);
    (changed.sources[0].data as TreasuryCurveData).latest.thirtyYearPercent += 1;
    const other = basename(await saveEditorialEvidence(changed, root));
    await assert.rejects(preparedTreasuryDocuments(root, other, digest(changed), later), /differ from the original/);
    await rm(join(root, ".editorial/treasury-curves", hash(original) + ".json"));
    await assert.rejects(read(), /original is missing/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test("permanent HTTP or XML failures and long throttles stop immediately with sanitized diagnostics", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const secret = "private-response-marker";
  for (const [status, body, retryAfter, expectedError] of [
    [403, secret, null, /HTTP 403/], [404, secret, null, /HTTP 404/],
    [429, secret, "120", /HTTP 429.*three seconds/], [503, secret, "invalid", /HTTP 503.*retry delay/],
    [200, "<html>" + secret + "</html>", null, /verification/],
  ] as const) {
    let requests = 0;
    const source = await collectOfficialTreasuryCurve(async () => {
      requests++;
      return new Response(body, { status, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } });
    });
    assert.equal(requests, 1);
    assert.equal(source.status, "unavailable");
    assert.match(source.error!, expectedError);
    assert.doesNotMatch(source.error!, /private-response-marker/);
    assert.equal(source.data, null);
    assert.deepEqual(source.observationDates, []);
  }
});

test("one collection-wide retry at year rollover preserves the first annual receipt and both source times", async t => {
  const january = Date.parse("2027-01-05T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: january });
  const requests: string[] = [];
  const source = await collectOfficialTreasuryCurve(async url => {
    requests.push(url);
    t.mock.timers.setTime(january + requests.length * 1000);
    if (requests.length === 2) return new Response(null, { status: 503, headers: { "Retry-After": "0" } });
    return new Response(head + row(url === treasuryYieldFile(2027) ? "2027-01-04" : "2026-12-31") + "</feed>");
  });
  assert.equal(source.status, "ok");
  assert.deepEqual(requests, [treasuryYieldFile(2027), treasuryYieldFile(2026), treasuryYieldFile(2026)]);
  assert.deepEqual(source.observationDates, ["2027-01-04", "2026-12-31"]);
  assert.deepEqual((source.data as TreasuryCurveData).documents.map(d => d.retrievedAt),
    [new Date(january + 1000).toISOString(), new Date(january + 3000).toISOString()]);

  let reads = 0;
  const failed = await collectOfficialTreasuryCurve(async () => {
    reads++;
    if (reads === 2) return new Response(head + row("2027-01-04") + "</feed>");
    return new Response("private-response-marker", { status: 503, headers: { "Retry-After": "0" } });
  });
  assert.equal(reads, 3);
  assert.equal(failed.status, "unavailable");
  assert.match(failed.error!, /HTTP 503.*retry/);
  assert.doesNotMatch(failed.error!, /private-response-marker/);
  const packet = evidence([source]);
  const original = JSON.stringify(packet);
  assert.throws(() => attachTreasuryCurve(packet, failed, new Date(january + 3000).toISOString()), /separately verified/);
  assert.equal(JSON.stringify(packet), original);
});

test("a connection reset can recover; an invalid TLS certificate cannot qualify by retry", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const [code, expectedCalls, expectedStatus] of [
    ["ECONNRESET", 2, "ok"], ["CERT_HAS_EXPIRED", 1, "unavailable"],
  ] as const) {
    let calls = 0;
    const source = await collectOfficialTreasuryCurve(async () => {
      calls++;
      if (calls === 1) {
        const cause = Object.assign(new Error("private-provider-detail"), { code });
        throw new TypeError("sensitive connection description", { cause });
      }
      return new Response(xml);
    });
    assert.equal(calls, expectedCalls);
    assert.equal(source.status, expectedStatus);
    assert.doesNotMatch(JSON.stringify(source), /private-provider-detail|sensitive connection description/);
  }
});

test("future, intraday pre-observation, incomplete, duplicate and mismatched dates fail closed", async t => {
  t.mock.timers.enable({ apis:["Date"], now });
  for (const body of [xml.replace("2026-11-19","2026-11-21"),xml.replace("2026-11-19","2026-11-20"),
    xml.replace("2026-11-19","2026-11-18"),xml.replace("2026-11-19","2025-11-19"),
    head+previous+latest.replace("<d:BC_30YEAR>5.40</d:BC_30YEAR>",'<d:BC_30YEAR m:null="true"/>')+"</feed>"]) {
    const s = await collectTreasuryCurve(async () => capture(body));
    assert.equal(s.status, "unavailable"); assert.deepEqual(s.observationDates, []); assert.equal(s.data, null);
  }
  const missing = await collectTreasuryCurve(async () => { throw new Error("provider offline"); });
  assert.equal(missing.status, "unavailable");
  assert.equal((await collectTreasuryCurve(async () => ({...capture(xml),sha256:"0".repeat(64)}))).status,"unavailable");
});

test("one source crosses New Year with the actual original files for both observations", async t => {
  const january = Date.parse("2027-01-05T12:00:00Z");
  t.mock.timers.enable({ apis:["Date"], now:january });
  const reads: string[]=[];
  const source = await collectTreasuryCurve(async url => {
    reads.push(url);
    return capture(head+(url===treasuryYieldFile(2027)?row("2027-01-04"):row("2026-12-31"))+'</feed>');
  });
  assert.equal(source.status,"ok");
  assert.deepEqual(reads,[treasuryYieldFile(2027),treasuryYieldFile(2026)]);
  assert.deepEqual(source.observationDates,["2027-01-04","2026-12-31"]);
  assert.deepEqual((source.data as TreasuryCurveData).documents.map(d=>d.url),reads);
});

test("the publication guard binds the source identity, dates, percent fields, strict URLs and capture stamps", async t => {
  t.mock.timers.enable({ apis:["Date"], now });
  const source=await collectTreasuryCurve(async()=>capture(xml));
  for(const u of [source.url+"#cb",source.retrievalUrl+"&other=1",source.url.replace("type=daily_","type=real_"),source.retrievalUrl.replace("home.treasury.gov","home.treasury.gov.example"),source.url.replace("https://","http://"),source.url.replace("home.treasury.gov/","home.treasury.gov:443/")]) assert.throws(()=>assertPublicURL(u));
  const changes: ((s:EditorialSource,d:TreasuryCurveData)=>void)[]=[
    s=>{s.kind="fred";},s=>{s.id="UNRELATED";},s=>{s.retrievalUrl=s.url;},s=>{s.url=s.url.replace("2026","2025");},
    s=>{s.observationDates=["2026-11-18","2026-11-19"];},(_,d)=>{d.latest.twoYearPercent=NaN;},
    (_,d)=>{d.documents[0].sha256="missing";},(_,d)=>{d.documents[0].url=treasuryYieldFile(2025);},
    (_,d)=>{d.documents[0].retrievedAt="2026-11-21T12:00:00.000Z";},(_,d)=>{Object.assign(d,{xml});}];
  for(const change of changes) {
    const changed=structuredClone(source);change(changed,changed.data as TreasuryCurveData);
    assert.throws(()=>validateEditorialPublication(candidate(changed),evidence([changed]),now));
  }
});

test("a full saved packet preserves filings and Fed evidence and displaces only a corroborated FRED curve reading", async t => {
  t.mock.timers.enable({ apis:["Date"], now });
  const source=await collectTreasuryCurve(async()=>capture(xml));
  const fred:EditorialSource={id:"FRED_DGS30",kind:"fred",title:"30-year Treasury",url:"https://fred.stlouisfed.org/series/DGS30",
    retrievalUrl:"https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS30",retrievedAt:stamp,observationDates:["2026-11-18"],status:"ok",
    data:{seriesId:"DGS30",unit:"percent",observations:[{date:"2026-11-18",value:5.41},{date:"2026-11-19",value:null}]}};
  const existing=Array.from({length:29},(_,i)=>({...fred,id:i===0?"FED_FOMC_MINUTES":"SEC144_"+i,kind:i===0?"fed_minutes" as const:"sec_form144" as const}));
  const original=evidence([...existing,fred]), before=JSON.stringify(original);
  const enriched=attachTreasuryCurve(original,source,stamp);
  assert.equal(enriched.sources.length,30);assert.deepEqual(enriched.sources,[...existing,source]);assert.equal(JSON.stringify(original),before);
  assert.match(enriched.limitations.at(-1)!,/FRED_DGS30/);
  assert.deepEqual(attachTreasuryCurve(enriched,source,stamp).sources,enriched.sources);
  const mismatched = structuredClone(fred);
  (mismatched.data as {observations:{value:number}[]}).observations[0].value=5.45;
  assert.throws(()=>attachTreasuryCurve(evidence([...existing,mismatched]),source,stamp),/30-source/);
  assert.throws(()=>attachTreasuryCurve(evidence(existing),{...source,status:"unavailable",data:null,observationDates:[]},stamp),/separately verified/);
});
