import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectVxCurve, validateVxCurve, VX_CURVE_ID } from "../lib/consensus/vx-curve.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";

const sourceDay = "2026-11-23";
const targetDay = "2026-11-24";
const morning = targetDay + "T12:31:00.000Z";
const cutoff = targetDay + "T13:00:00.000Z";
const api = "https://getmarkethistory.com/api/v1/";
const expiries = ["2026-12-16", "2027-01-20"];
const amounts = [24.1234, 23.4467];
const ticker = (expiry: string) => "VX-" + expiry;
const contract = (expiry: string, i: number) => ({
  symbol: ticker(expiry), symbol_id: 160 + i, first_timestamp: "2026-01-02T00:00:00Z",
});
const json = (body: unknown) => Response.json(body);
const clock = (date: string) => () => date;
const unused = async (): Promise<Response> => { throw new Error("Unexpected live request"); };

type Options = {
  observed?: string;
  through?: string[];
  vendorAmounts?: number[];
  cfeAmounts?: number[];
  wrongDate?: boolean;
  wrongId?: boolean;
  duplicate?: boolean;
  gap?: boolean;
  duplicateRow?: boolean;
  incorrectPair?: boolean;
  filenameDate?: string;
  fee?: boolean;
  unavailable?: boolean;
  feed?: string;
  capture?: string[];
};
function fixtures(o: Options = {}) {
  const observed = o.observed ?? sourceDay;
  const closes = o.cfeAmounts ?? amounts;
  const catalog = [
    contract(expiries[1], 1), contract("2027-02-17", 2), contract(expiries[0], 0), contract("2026-11-18", 3),
    { symbol: "VX01-2026-11-24", symbol_id: 901, first_timestamp: "2026-01-02T00:00:00Z" },
  ];
  if (o.duplicate) catalog.push(contract(expiries[0], 90));
  if (o.incorrectPair) catalog.push(contract("2026-11-25", 10));

  return async (url: string, init?: RequestInit) => {
    o.capture?.push(url);
    assert.equal(init?.credentials, "omit");
    assert.equal(init.redirect, "error");
    const cfe = "https://www-api.cboe.com/us/futures/market_statistics/settlement/csv/?dt=";
    if (url === cfe + observed) {
      if (o.unavailable) return new Response("unavailable", {status:503});
      const rows = ["Product,Symbol,Expiration Date,Price", "VX,VX/G7,2027-02-17,20",
        "VX,VX47/X6,2026-11-24,88", "VXM,VXM/Z6,2026-12-16,99", "VX,VX/X6,2026-11-18,21",
        "VX,VX/F7," + expiries[1] + "," + closes[1], "VX,VX/Z6," + expiries[0] + "," + closes[0] + "*"];
      return new Response(rows.join("\r\n"), {headers:{"content-type":"text/csv",
        "content-disposition":'attachment; filename="FuturesSettlements_' + (o.filenameDate ?? observed) + '.csv"'}});
    }
    if (url === api + "symbols?dataset=futures/us&timeframe=1d") return json({count:catalog.length,symbols:catalog});
    const expiry = expiries.find(d => url.includes(ticker(d)));
    assert.ok(expiry, "unexpected contract " + url);
    const i = expiries.indexOf(expiry), day = (o.through ?? [observed, observed])[i];
    const last = day + "T00:00:00Z", updated = exchangeSession(day)?.closeAt;
    assert.ok(updated);
    const spec = "futures/us/" + ticker(expiry);
    if (url === api + spec) return json({
      ticker:ticker(expiry),dataset:"futures/us",contract:{exchange:"CFE",asset_class:"volatility",country:"US",currency:"USD",
        name:"VIX future, expires " + expiry,status:"active"},
      bars:{timeframes:[{timeframe:"1d",feed:o.feed ?? "cboe",venue:"Cboe Futures Exchange (CFE)",last,updated}]},
    });
    assert.equal(url, api + "bars/" + spec + "/1d");
    const row = {symbol:ticker(expiry),symbol_id:160 + i + (o.wrongId ? 9 : 0),timestamp:o.wrongDate ? "2026-11-19T00:00:00Z" : last,
      is_gap:o.gap === true,gap_fill_method:0,close:(o.vendorAmounts ?? closes)[i]};
    const lines = o.duplicateRow ? [row,row] : [row];
    return new Response(lines.map(v => JSON.stringify(v)).join("\n"), {headers:{"content-type":"application/x-ndjson",
      "x-data-through":last,"x-row-count":String(lines.length),"x-preview-limit":"100","x-session":"UTC 00:00",
      "x-format":"jsonl","x-bars-charged":o.fee ? "1" : "0"}});
  };
}

test("two exact, dated, still-live standard monthlies yield only a coarse observation; first private capture survives replay", async t => {
  const dir = await mkdtemp(join(tmpdir(),"consensus-vx-"));
  t.after(() => rm(dir,{force:true,recursive:true}));
  const requests: string[] = [];
  const observed = await collectVxCurve(fixtures({capture:requests}),dir,undefined,clock(morning));
  assert.equal(observed.id,VX_CURVE_ID);
  assert.equal(observed.status,"available");
  assert.deepEqual(observed.series,[{date:sourceDay,value:1}]);
  assert.deepEqual(observed.scores,{daily:null,weekly:null,monthly:null});
  assert.deepEqual(observed.directionalInstruments,[]);
  assert.deepEqual(observed.instruments,["MARKET","SPY"]);
  assert.equal(observed.source.retrievedAt,morning);
  assert.equal(observed.source.releasedAt,null);
  validateVxCurve(observed,cutoff);
  assert.equal(requests.length,6);
  assert.doesNotMatch(JSON.stringify(observed),/24\.1234|23\.4467|VX-2026-12-16|VX-2027-01-20/);
  const file = join(dir,targetDay,"verified.json");
  assert.equal((await stat(file)).mode & 0o777,0o600);
  assert.equal((await stat(join(dir,targetDay))).mode & 0o777,0o700);
  const bytes = await readFile(file,"utf8");
  const later = await collectVxCurve(unused,dir,undefined,clock(targetDay + "T16:00:00.000Z"));
  assert.deepEqual(later,observed);
  assert.equal(await readFile(file,"utf8"),bytes);
  const corrupt = JSON.parse(bytes);
  corrupt.legs[0].preview.text = corrupt.legs[0].preview.text.replace("24.1234","25.1234");
  await writeFile(file,JSON.stringify(corrupt));
  const checked = await collectVxCurve(unused,dir,observed,clock(targetDay + "T17:00:00.000Z"));
  assert.equal(checked.failureKind,"validation");
});

test("one late maturity preserves the original prior observation; a subsequent timely matching pair can replace it", async t => {
  const dir = await mkdtemp(join(tmpdir(),"consensus-vx-"));
  t.after(() => rm(dir,{force:true,recursive:true}));
  const priorDay = "2026-11-20", yesterday = clock("2026-11-23T12:32:00.000Z");
  const prior = await collectVxCurve(fixtures({observed:priorDay}),dir,undefined,yesterday);
  assert.equal(prior.source.observedAt,priorDay);
  for (const through of [[priorDay,sourceDay],[sourceDay,priorDay]]) {
    const delayed = await collectVxCurve(fixtures({through}),dir,prior,clock(morning));
    assert.deepEqual(delayed.source,prior.source);
    assert.deepEqual(delayed.series,prior.series);
    assert.match(delayed.collectionNote ?? "",/pending/);
    validateVxCurve(delayed,cutoff);
  }
  const files = await readdir(join(dir,targetDay));
  assert.equal(files.length,1);
  assert.match(files[0],/^cfe-[a-f0-9]{64}\.json$/);
  const conflict = await collectVxCurve(fixtures({through:[priorDay,sourceDay],vendorAmounts:[amounts[0],98]}),dir,prior,clock(morning));
  assert.equal(conflict.failureKind,"validation","a late first leg cannot conceal a corrupt second leg");
  const current = await collectVxCurve(fixtures({}),dir,prior,clock("2026-11-24T12:45:00.000Z"));
  assert.equal(current.source.observedAt,sourceDay);
  assert.deepEqual((await readdir(join(dir,targetDay))).sort(),[files[0],"verified.json"].sort());
  const outage = await collectVxCurve(fixtures({unavailable:true}),undefined,prior,clock(morning));
  assert.deepEqual(outage.source,prior.source);
  validateVxCurve(outage,cutoff);
});

test("native settlement and vendor contracts, identities, dates, zero-charge delivery and recorded prices must all match", async () => {
  const faults: Options[] = [{vendorAmounts:[amounts[0]+0.0001,amounts[1]]},{wrongId:true},{duplicate:true},{incorrectPair:true},
    {wrongDate:true},{duplicateRow:true},{gap:true},{fee:true},{filenameDate:"2026-11-20"},{feed:"synthetic"}];
  for (const options of faults) {
    const s = await collectVxCurve(fixtures(options),undefined,undefined,clock(morning));
    assert.equal(s.failureKind,"validation",JSON.stringify(options));
    assert.deepEqual(s.series,[]);
    validateVxCurve(s,cutoff);
  }
});

test("equal and below bands preserve the same schema; extra values, scores or prospective clocks fail archive validation", async () => {
  for (const [front,second,band] of [[24.1234,24.1234,0],[23.4467,24.1234,-1]]) {
    const good = await collectVxCurve(fixtures({cfeAmounts:[front,second]}),undefined,undefined,clock(morning));
    assert.deepEqual(good.series,[{date:sourceDay,value:band}]);
    validateVxCurve(good,cutoff);
    assert.throws(() => validateVxCurve({...good,scores:{...good.scores,daily:1}},cutoff));
    assert.throws(() => validateVxCurve({...good,series:[...good.series,{date:sourceDay,value:front}]},cutoff));
    assert.throws(() => validateVxCurve({...good,source:{...good.source,releasedAt:morning}},cutoff));
    assert.throws(() => validateVxCurve({...good,source:{...good.source,observedAt:"2026-11-20"}},cutoff));
    assert.throws(() => validateVxCurve({...good,source:{...good.source,retrievedAt:cutoff}},cutoff));
    assert.throws(() => validateVxCurve(good,"2026-11-24T12:00:00.000Z"));
  }
});

test("late or intraday collection cannot create prior history; rejects an acquisition running across the deadline", async t => {
  for (const at of [cutoff,targetDay+"T17:00:00.000Z"]) {
    const requests: string[] = [];
    const s = await collectVxCurve(fixtures({capture:requests}),undefined,undefined,clock(at));
    assert.equal(s.status,"not_formed");
    assert.deepEqual(requests,[]);
    validateVxCurve(s,at);
  }
  const dir = await mkdtemp(join(tmpdir(),"consensus-vx-"));
  t.after(() => rm(dir,{force:true,recursive:true}));
  let at = "2026-11-24T12:59:59.900Z";
  const source = fixtures();
  const s = await collectVxCurve(async (url, init) => {
    const response = await source(url,init);
    if (url.includes("/bars/") && url.includes(expiries[1])) at = cutoff;
    return response;
  },dir,undefined,() => at);
  assert.equal(s.status,"not_formed","crossing the cutoff prevents the receipt");
  assert.ok(!(await readdir(join(dir,targetDay))).includes("verified.json"));
});

test("an expiry day excludes the expired monthly; holiday and shortened settlement sessions retain the correct next morning", async () => {
  const cases = [
    ["2026-11-18","2026-11-19T12:31:00.000Z"], // Wednesday Nov 18 contract has expired.
    ["2026-11-25","2026-11-26T16:00:00.000Z"], // Thanksgiving; the next equity forecast is Friday.
    ["2026-11-27","2026-11-27T18:01:00.000Z"], // CFE noon Chicago settlement on the Friday early close.
  ];
  for (const [observed,at] of cases) {
    const s = await collectVxCurve(fixtures({observed}),undefined,undefined,clock(at));
    assert.equal(s.source.observedAt,observed,at);
    validateVxCurve(s,at);
  }
});
