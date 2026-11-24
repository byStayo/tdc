import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { digest } from "../lib/consensus/history.ts";
import { historicalNasdaqAuction } from "../lib/consensus/historical-nasdaq-auction.ts";
import { collectKibotSeries, kibotHistorySource, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { kibotPostCloseIssuerActions } from "../lib/consensus/kibot-session-witnesses.ts";
import { boundaryClock, freeMarketHistoryBalance, marketHistoryBoundaries, type MarketHistoryETF } from "../lib/consensus/market-history-boundaries.ts";
import { type DeliveredMarketHistoryHours, type MarketHistoryAdjustment, type MarketHistoryGrid } from "../lib/consensus/market-history-closes.ts";
import { etfHourSource, fetchFreeEtfHours, type FreeHourlyAccount } from "../lib/consensus/market-history-hourly-access.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const policy = await readFile(resolve(root, "scripts/short-session-etf-price-policy.json"));
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
if (hash(policy) !== "e3542ed63f28988798b6356b7913ec441b109979146ddfef6a50508beb832983")
  throw Error("The 2025 early-close comparison policy has changed");
const { dates, symbols } = JSON.parse(policy.toString()) as { dates: string[]; symbols: MarketHistoryETF[] };
if (symbols.join() !== ETF_SYMBOLS.join()) throw Error("The historical policy and ETF universe disagree");
const folder = resolve(root, ".consensus/private-short-session-price-qualification/2025");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--collect")) throw Error("Usage: qualify-short-session-prices.ts [--collect]");
const collect = args[0] === "--collect";
if (collect) await durableDirectory(folder, 0o700);
let account: FreeHourlyAccount | undefined;
const issuerVintage = "2026-11-23";

async function original<T>(name: string, acquire: () => Promise<T>, verify: (capture: T) => void) {
  const path = resolve(folder, name + ".json");
  const saved = await readResearchReceipt<T>(path);
  if (saved) { verify(saved); return saved; }
  if (!collect) throw Error("Missing private historical receipt " + name);
  const fresh = await acquire();
  verify(fresh);
  try { await durableJSON(path, fresh, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const first = await readResearchReceipt<T>(path);
    if (!first) throw error;
    verify(first);
    return first;
  }
  return fresh;
}

type NativeBar = { source: string; sha256: string; csv: string; capturedAt: string };
async function native(symbol: MarketHistoryETF, day: string, basis: MarketHistoryAdjustment) {
  const source = kibotHistorySource(symbol, day, day, basis);
  const proof = await original<NativeBar>([symbol, day, "kibot", basis].join("-"), async () => {
    let csv = "";
    const capture = await collectKibotSeries(symbol, [day], { unadjusted: basis === "raw", splitAdjusted: basis === "splits",
      sessionClock: boundaryClock, onVerifiedResponse: body => { csv = body; } });
    return { source, sha256: capture.sha256, csv, capturedAt: new Date().toISOString() };
  }, (row) => {
    if (row.source !== source || hash(row.csv) !== row.sha256 || new Date(row.capturedAt).toISOString() !== row.capturedAt ||
        row.capturedAt <= boundaryClock(day)!.closeAt || Date.parse(row.capturedAt) > Date.now()) throw Error("Invalid Kibot original");
    parseKibotDaily(row.csv, [day], boundaryClock);
  });
  return parseKibotDaily(proof.csv, [day], boundaryClock)[0];
}
async function bound(symbol: MarketHistoryETF, day: string, basis: MarketHistoryAdjustment) {
  async function leg(grid: MarketHistoryGrid) {
    const source = etfHourSource(symbol, day, day, grid, basis);
    return original<DeliveredMarketHistoryHours>([symbol, day, basis, grid === "exchange" ? "close" : "open"].join("-"), async () => {
      if (!account) {
        const key = process.env.MARKET_HISTORY_KEY || (await readResearchReceipt<{ apiKey: string }>(
          resolve(root, ".consensus/private-market-history/credentials.json")))?.apiKey;
        if (!key) throw Error("The free hourly account is unavailable");
        account = { key };
      }
      return fetchFreeEtfHours(symbol, day, day, grid, account, fetch, basis);
    }, (delivery) => {
      if (delivery.source !== source || delivery.status !== 200 || delivery.sha256 !== hash(delivery.text))
        throw Error("Wrong Market History source or content digest");
      freeMarketHistoryBalance(new Headers(delivery.headers));
    });
  }
  const clock = boundaryClock(day)!;
  const [row] = marketHistoryBoundaries(await leg("Asia/Kolkata"), await leg("exchange"), [clock], new Date().toISOString(), symbol, basis);
  const close = Date.parse(clock.closeAt);
  if (!row.earlyClose || close - Date.parse(clock.openAt) !== 210 * 60_000 ||
      row.openingBucket !== clock.openAt || row.closingBucket !== new Date(close - 3_600_000).toISOString() ||
      row.open === null || row.close === null) throw Error("Missing one or both regular-session edges on the shortened session");
  return { open: row.open, close: row.close };
}

const rows = [];
for (const symbol of symbols) {
  const issuer = await kibotPostCloseIssuerActions(root, resolve(root, ".consensus/private-kibot/sources", issuerVintage),
    symbol, issuerVintage, undefined, false, { from: "2025-01-01" });
  const cash = issuer.cashHistory!;
  for (const day of dates) {
    const [raw, splits] = [await native(symbol, day, "raw"), await native(symbol, day, "splits")];
    const [hourly, splitHourly] = [await bound(symbol, day, "raw"), await bound(symbol, day, "splits")];
    const auction = await historicalNasdaqAuction(root, symbol, day);
    const issuerBracketsDay = cash.some(event => event.session < day) && cash.some(event => event.session > day);
    const cashEvents = issuerBracketsDay ? cash.filter(event => event.session === day).length : null;
    const differences = [];
    if (raw.open !== splits.open || raw.close !== splits.close) differences.push("Kibot split basis");
    if (hourly.open !== splitHourly.open || hourly.close !== splitHourly.close) differences.push("Market History split basis");
    if (Math.abs(hourly.open / raw.open - 1) * 10_000 > 3) differences.push("open");
    if (Math.abs(hourly.close / raw.close - 1) * 10_000 > 15) differences.push("close");
    if (Math.sign(hourly.close - hourly.open) !== Math.sign(raw.close - raw.open)) differences.push("direction");
    const checkedAuction = auction ? { openMatches: hourly.open === auction.open, closeMatches: hourly.close === auction.close } : null;
    rows.push({ symbol, day, boundaryComparison: !differences.length, differences, checkedAuction, issuerBracketsDay, cashEvents });
  }
}
const result = { method: "short-session-etf-prices-2025-v1", rows };
const checked = await original<typeof result>("counts", async () => result, (saved) => {
  if (digest(saved) !== digest(result)) throw Error("Frozen historical comparison differs from the replay");
});
console.log(JSON.stringify(checked));
