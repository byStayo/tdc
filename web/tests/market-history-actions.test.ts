import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { firstRateIssuerActionProof, marketHistoryActionCachePath, sealMarketHistoryActionCapture,
  type MarketHistoryActionCapture } from "../lib/consensus/market-history-actions.ts";

const friday = "2026-11-20", thursday = "2026-11-19";
const cash = [{ session: friday, amount: 0.54628 }];
const served = "2026-11-23T23:00:00.000Z", checked = "2026-11-23T23:00:10.000Z";
const row = { cusip: "78467X109", id: "7a28d1e3-861d-49e9-8ba8-eabdb5cff97b", symbol: "DIA", type: "cash_dividends",
  ex_date: friday, process_date: "2026-12-14", payable_date: "2026-12-14", record_date: friday, source: null,
  special: false, foreign: false, old_rate: null, new_rate: null, rate: 0.54628, due_bill_redemption_date: null, extra: null };
const endpoint = (fund: string, start: string, end: string) =>
  "https://getmarkethistory.com/query/v1/corporate-actions?" + new URLSearchParams({ dataset: "stocks/us", ticker: fund, start, end, format: "jsonl" });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const offline: typeof fetch = async () => { throw Error("Offline fixture made a request"); };
async function isolated(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "consensus-etf-actions-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function capture(rows: object[], source = endpoint("DIA", "2026-10-30", "2026-11-23")): MarketHistoryActionCapture {
  const raw = rows.map(r => JSON.stringify(r) + "\n").join("");
  return { source, receivedAt: checked, headers: { "content-type": "application/x-ndjson", date: new Date(served).toUTCString(),
    "x-row-count": String(rows.length), "x-bars-charged": rows.length ? "1000" : "0", "x-bars-paid-remaining": "0" },
    raw, sha256: sha(raw) };
}
const cache = (root: string) => marketHistoryActionCachePath(root, "DIA", thursday, friday);
const savedProof = (root: string, payments = cash) => firstRateIssuerActionProof(root, "DIA", thursday, friday, payments, true, { fetcher: offline, asOf: checked });

test("a post-close original covering a larger range confirms the exact date, total cash and source", async () => isolated(async root => {
  await durableJSON(cache(root), sealMarketHistoryActionCapture(capture([row])), true);
  const proof = await savedProof(root, [{session:"2026-10-16", amount:.11404}, ...cash ]);
  assert.deepEqual({ ...proof, sha256: null }, { symbol: "DIA", from: thursday, through: friday, primaryCount: 1,
    issuerMirrorCount: 0, provider: "market-history", scope: "issuer-cash-vs-corporate-actions", sha256: null });
  assert.match(proof.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(savedProof(root, []), /Missing verified/);
  await assert.rejects(savedProof(root, [{ session: thursday, amount: .54628 }]), /Missing verified/);
  await assert.rejects(savedProof(root, [{ session: friday, amount: .546279999 }]), /Missing verified/);
  assert.equal((await savedProof(root)).sha256, proof.sha256);
}));

test("the issuer's capital gains, special payment and return of capital are counted once; mirror provenance is explicit", async () => isolated(async root => {
  const ordinary = { ...row, rate: .5, source: "issuer:ssga",
    extra: JSON.stringify({ dividend_rate: .3, short_term_rate: .05, long_term_rate: .1, return_of_capital_rate: .05, currency: "USD" }) };
  const special = { ...row, id: "special", special:true, rate:.04628 };
  await durableJSON(cache(root), sealMarketHistoryActionCapture(capture([ordinary,special])), true);
  const p = await savedProof(root);
  assert.equal(p.primaryCount, 1); assert.equal(p.issuerMirrorCount, 1);
}));

test("splits, mixed security, shifted dates, duplicate actions, unknown issuers and ambiguous tax fields remain pending", async () => {
  const badRows = [[{ ...row,type:"forward_splits", old_rate:1,new_rate:5 }], [{ ...row,type:"spin_offs" }],
    [{ ...row, cusip:"464287432" }], [{ ...row, symbol:"TLT" }], [{ ...row, ex_date:null }],
    [row, { ...row, id:"second" }], [row,row], [{ ...row, source:"supplier:renamed-from:XYZ" }], [{ ...row, source:"issuer:ishares" }],
    [{ ...row, extra:JSON.stringify({ long_term_rate:.2, return_of_capital_rate:.1 }) }], [{ ...row, extra:{ currency:"CAD" } }],
    [{ ...row, currency:"EUR" }],
    [{ ...row, due_bill_redemption_date:"2026-12-15" }]];
  for(const events of badRows) await isolated(async root => {
    await durableJSON(cache(root), sealMarketHistoryActionCapture(capture(events)), true);
    await assert.rejects(savedProof(root));
  });
});

test("replay rejects corrupted bodies, scope, clocks, native counts, paid debits and unexpected sensitive fields", async () => {
  const native = capture([row]);
  const variants = [
    { ...native, raw:"" }, { ...native, receivedAt: "2026-11-24T02:00:00.000Z" },
    { ...native, source:endpoint("SPY",thursday,friday) }, { ...native, source:endpoint("DIA",friday,friday) },
    { ...native, source:native.source+"&other=yes" }, { ...native, headers:{ ...native.headers,date:"Fri, 20 Nov 2026 20:59:00 GMT" } },
    { ...native, headers:{ ...native.headers,"x-row-count":"0" } }, { ...native, headers:{ ...native.headers,"x-next-cursor":"more" } },
    { ...native, headers:{ ...native.headers,"x-bars-paid-remaining":"1" } }, { ...native, headers:{ ...native.headers,"x-bars-charged":"500" } },
  ];
  for (const item of variants) await isolated(async root => {
    await durableJSON(cache(root), sealMarketHistoryActionCapture(item), true);
    await assert.rejects(savedProof(root));
  });
  assert.throws(() => sealMarketHistoryActionCapture({ ...native, headers:{ ...native.headers, authorization:"private" } }));
  await isolated(async root => {
    const original=sealMarketHistoryActionCapture(native);
    await durableJSON(cache(root), { ...original, capture:{ ...native, receivedAt:"2026-11-23T23:00:04.000Z" } },true);
    await assert.rejects(savedProof(root), /seal differs/);
  });
});

function transport(log: string[], events: object[], options: { lag?: boolean; paid?: string; free?: string; fail?: boolean } = {}): typeof fetch {
  return async (source, init) => {
    const url=String(source), auth=new Headers(init?.headers).get("authorization");
    log.push(url);
    assert.equal(init?.redirect,"error"); assert.equal(init?.credentials,"omit");
    if(url.includes("/api/v1/stocks/")) {
      assert.equal(auth,null);
      return Response.json({ dataset:"stocks/us",ticker:"DIA",contract:{status:"active",exchange:"ARCA"},
        bars:{timeframes:[{timeframe:"1m",feed:"consolidated",venue:"US consolidated tape", last: options.lag ? thursday+"T21:00:00Z": friday+"T22:00:00Z"}]} });
    }
    assert.equal(auth,"Bearer privately-held");
    const budget={"x-bars-remaining":options.free??"10000","x-bars-paid-remaining":options.paid??"0"};
    if(url.includes("/fee-rules?"))return new Response("fees",{headers:budget});
    assert.equal(url,endpoint("DIA",thursday,friday));
    if(options.fail)return new Response("busy",{status:429});
    const c=capture(events);
    return new Response(c.raw,{headers:{ ...c.headers,...budget,date:new Date().toUTCString(), "x-private-extra":"never persist" }});
  };
}
function acquire(root: string, fetcher: typeof fetch, payments = cash) {
  return firstRateIssuerActionProof(root,"DIA",thursday,friday,payments,false,{environmentKey:"privately-held",fetcher});
}
test("two collectors converge on one immutable free receipt and keep credentials outside its bytes", async () => isolated(async root => {
  const calls: string[]=[];
  const [a,b]=await Promise.all([acquire(root,transport(calls,[row])), acquire(root,transport(calls,[row]))]);
  assert.deepEqual(a,b);
  const evidence=await readFile(cache(root),"utf8");
  assert.equal(evidence.includes("privately-held"),false);assert.equal(evidence.includes("x-private-extra"),false);
  const cached=await firstRateIssuerActionProof(root,"DIA",thursday,friday,cash,true,{fetcher:offline});assert.deepEqual(cached,a);
  assert.equal((await readdir(dirname(cache(root)))).length,1);
}));
test("late catalogue, mixed balances, rate limits and incomplete action data do not pin a pending window", async () => {
  for(const step of [{lag:true},{paid:"10"},{free:"999"},{fail:true},{}]) await isolated(async root => {
    const calls: string[]=[];
    await assert.rejects(acquire(root,transport(calls,[],step)));
    await assert.rejects(readFile(cache(root)),{code:"ENOENT"});
    if("lag" in step)assert.equal(calls.length,1);
    if("paid" in step||"free" in step)assert.equal(calls.length,2);
    const verified=await acquire(root,transport(calls,[row]));assert.equal(verified.primaryCount,1);
  });
});
test("an improved issuer release gets a separate verified revision and prior payments stay reproducible", async () => isolated(async root => {
  const calls:string[]=[], a=await acquire(root,transport(calls,[row]));
  const corrected=[{session:friday,amount:.56}];
  await assert.rejects(acquire(root,transport(calls,[row]),corrected));
  assert.equal((await readdir(dirname(cache(root)))).length,1);
  const b=await acquire(root,transport(calls,[{...row,rate:.56}]),corrected);assert.notEqual(a.sha256,b.sha256);
  assert.equal((await readdir(dirname(cache(root)))).length,2);
  assert.deepEqual(await firstRateIssuerActionProof(root,"DIA",thursday,friday,cash,true,{fetcher:offline}),a);
  assert.deepEqual(await firstRateIssuerActionProof(root,"DIA",thursday,friday,corrected,true,{fetcher:offline}),b);
}));
