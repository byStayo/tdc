import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { calculateConsensus } from "../lib/consensus/engines/v2.ts";
import { collectMarketHistoryVolatility, validateMarketHistoryVolatility } from "../lib/consensus/market-history-volatility.ts";

const now = "2026-11-24T03:00:00.000Z";
const through = "2026-11-20T00:00:00Z";
const identities = {
  VIX: [5, "S&P 500, 30-day"], VXN: [24, "Nasdaq-100"], RVX: [3, "Russell 2000"], VXD: [14, "DJIA"],
  VXTLT: [26, "20+ Year Government Bond ETF"], VIX9D: [10, "S&P 500, 9-day"], VIX3M: [8, "S&P 500, 3-month"],
} as const;
type Ticker = keyof typeof identities;
function source(breakDate = false, mismatch = false, short = 21, long = 20, wrongReference?: string) {
  return async (url: string) => {
    const reference = new URL(url).hostname === "cdn-api.cboe.com";
    const symbol = (reference ? url.split("/").at(-1)!.split("_")[0] : url.split("/").filter(k => k in identities)[0]) as Ticker;
    assert.ok(symbol);
    const [id, name] = identities[symbol];
    const end = mismatch && symbol === "VIX9D" ? "2026-11-19T00:00:00Z" : through;
    if (!reference && !url.includes("/bars/")) return Response.json({ ticker: symbol, dataset: "volatility/us",
      contract: { asset_class: "volatility", country: "US", exchange: "Cboe", name: "Volatility Index (" + name + ")", status: "active" },
      bars: { timeframes: [{ timeframe: "1d", last: end, updated: "2026-11-23T05:06:06Z" }] } });
    const dates = exchangeSessions("2026-08-18", end.slice(0,10));
    dates.push("2026-09-07"); // VIX also has a holiday reading outside equity sessions.
    if (breakDate && symbol === "VXTLT") dates.splice(dates.indexOf("2026-10-20"), 1);
    const rows = dates.sort().map(day => {
      const price = day === "2026-09-07" ? 999 : symbol === "VIX9D" ? short : symbol === "VIX3M" ? long : 20;
      if (reference) {
        const [year, month, date] = day.split("-");
        const close = price + Number(wrongReference === symbol && day === "2026-11-19");
        return [month + "/" + date + "/" + year, ...(symbol === "VXTLT" ? [close] : [price,price,price,close])].join(",");
      }
      return JSON.stringify({ timestamp: day + "T00:00:00Z", symbol, symbol_id: id, is_gap: false, gap_fill_method: 0,
        close: price, high: price, low: price, open: price, volume: 0, trade_count: 0 });
    });
    if (reference) return new Response([symbol === "VXTLT" ? "DATE,VXTLT" : "DATE,OPEN,HIGH,LOW,CLOSE",...rows].join("\n"),
      { headers: { "content-type":"text/csv" } });
    return new Response(rows.join("\n"), { headers: { "content-type":"application/x-ndjson", "x-format":"jsonl",
      "x-data-through":end, "x-preview-limit":"100", "x-session":"UTC 00:00", "x-row-count":String(rows.length) } });
  };
}

test("a complete US calendar produces private-source-backed ranks and a separately dated same-session curve", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const dir = await mkdtemp(join(tmpdir(), "tdc-iv-"));
  try {
    const signals = await collectMarketHistoryVolatility(source(), dir);
    signals.forEach(validateMarketHistoryVolatility);
    assert.deepEqual(signals.map(s => s.series[0].value), [3,3,3,3,3,0]); // ties and the exact 5% boundary
    assert.deepEqual(signals.map(s => s.instruments), [["MARKET","SPY"],["QQQ"],["IWM"],["DIA"],["TLT"],["MARKET","SPY"]]);
    assert.ok(signals.every(s => s.source.observedAt === "2026-11-20" && s.source.releasedAt === null));
    const result = calculateConsensus(signals,"MARKET","daily",now);
    assert.equal(result.families.find(s => s.id === "options")?.available, 2);
    assert.equal(result.families.find(s => s.id === "options")?.score, null);
    assert.ok(!result.reasons.includes("Options risk is not measured."));
    const folder = join(dir, "2026-11-20");
    const files = await readdir(folder);
    assert.equal(files.length, 7);
    const path = join(folder, files.find(file => file.startsWith("VXN-"))!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await collectMarketHistoryVolatility(source(),dir),signals);
    const captured = JSON.parse(await readFile(path,"utf8"));
    captured.capture.bars += "\ncorruption";
    await writeFile(path,JSON.stringify(captured));
    const retry = await collectMarketHistoryVolatility(source(),dir);
    assert.equal(retry[1].status,"unavailable");
    assert.equal(retry[1].failureKind,"validation");
  } finally { await rm(dir,{ recursive:true,force:true }); }
});

test("a missing trading day or mismatched maturity stays unavailable and never disables the other funds", async t => {
  t.mock.timers.enable({ apis:["Date"],now:Date.parse(now) });
  const signals = await collectMarketHistoryVolatility(source(true,true));
  assert.deepEqual(signals.map(s => s.status), ["available","available","available","available","unavailable","unavailable"]);
  signals.forEach(validateMarketHistoryVolatility);
  assert.throws(() => validateMarketHistoryVolatility({ ...signals[0], metrics:[{ ...signals[0].metrics[0],value:44.123 }] }));
  assert.throws(() => validateMarketHistoryVolatility({ ...signals[0], source:{ ...signals[0].source,releasedAt:now } }));
  assert.throws(() => validateMarketHistoryVolatility({ ...signals[0],scores:{ daily:1,weekly:null,monthly:null } }));
  assert.throws(() => validateMarketHistoryVolatility({ ...signals[0],summary:"raw price" }));
  const declines = await collectMarketHistoryVolatility(async () => new Response(null,{ status:503 }));
  assert.ok(declines.every(s => s.status === "unavailable" && s.failureKind === "transport"));
});


test("decimal curve boundaries are stable and a differing Cboe close withholds only that index", async t => {
  t.mock.timers.enable({ apis:["Date"],now:Date.parse(now) });
  for (const [short,long,band] of [[21.42,20.40,0],[15.77,16.60,0],[21.43,20.40,1],[15.76,16.60,-1]]) {
    const signals = await collectMarketHistoryVolatility(source(false,false,short,long,"RVX"));
    assert.equal(signals[5].series[0].value,band);
    assert.equal(signals[2].failureKind,"validation");
    assert.equal(signals[2].series.length,0);
    assert.equal(signals[0].status,"available");
  }
});
