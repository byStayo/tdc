import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { freeMarketHistoryBalance, marketHistoryBoundaries, type MarketHistoryETF } from "./market-history-boundaries.ts";
import { importMarketHistoryHours, type DeliveredMarketHistoryHours, type MarketHistoryAdjustment,
  type MarketHistoryGrid } from "./market-history-closes.ts";
import { etfHourSource, fetchFreeEtfHours, type FreeHourlyAccount } from "./market-history-hourly-access.ts";
import { marketHistoryPreview } from "./market-history-preview.ts";
import { readResearchReceipt, type ResearchPriceReceipt } from "./research-price-capture.ts";
export type HourPair = { opening: DeliveredMarketHistoryHours; closing: DeliveredMarketHistoryHours };
export type HourlyControlProof = { provider: "market-history"; from: string; through: string; raw: string; splits: string };
export class ComparisonUnavailable extends Error {}
const directory = (root: string) => resolve(root, ".consensus/private-market-history/firstrate-controls");

export function readMarketHistoryPriceControl(symbol: MarketHistoryETF, days: string[], pair: HourPair, adjustment: MarketHistoryAdjustment, asOf: string): ResearchPriceReceipt {
  const from = days[0], through = days.at(-1)!;
  if (!days.length || !exchangeSession(from) || !exchangeSession(through) ||
      exchangeSessions(from, through).join() !== days.join()) throw new Error("Price comparison needs consecutive exchange sessions");
  const clocks = days.map(day => exchangeSession(day)!);
  for (const leg of [pair.opening, pair.closing]) freeMarketHistoryBalance(new Headers(leg.headers));
  const checked = marketHistoryBoundaries(pair.opening, pair.closing, clocks, asOf, symbol, adjustment);
  const sessions = checked.map(({ session, openAt, closeAt, open, close }) => {
    if (open === null || close === null) throw new ComparisonUnavailable(symbol + " lacks a completed hourly edge on " + session);
    return { session, openAt, closeAt, open, close };
  });
  return { instrument: symbol, from, through, sessions, priceDigest: digest(sessions),
    sha256: digest({ provider: "market-history", symbol, adjustment, days, opening: digest(pair.opening), closing: digest(pair.closing) }) };
}

export async function collectMarketHistoryPriceControls(root: string, symbol: MarketHistoryETF, days: string[], cachedOnly: boolean,
  { fetcher = fetch, environmentKey = process.env.MARKET_HISTORY_KEY, asOf, signal }: {
    fetcher?: typeof fetch; environmentKey?: string; asOf?: string; signal?: AbortSignal } = {}) {
  const from = days[0], through = days.at(-1)!;
  const close = exchangeSession(through)?.closeAt;
  if (!close || !days.length || !exchangeSession(from) || exchangeSessions(from, through).join() !== days.join())
    throw new Error("Invalid hourly comparison window");
  const store = directory(root);
  let ready = false;
  let account: FreeHourlyAccount | undefined;
  async function readLeg(adjustment: MarketHistoryAdjustment, grid: MarketHistoryGrid) {
    const path = resolve(store, [symbol, from, through, adjustment, grid === "exchange" ? "close" : "open"].join("-") + ".json");
    const url = etfHourSource(symbol, from, through, grid, adjustment);
    const verify = (delivery: DeliveredMarketHistoryHours) => {
      if (delivery.source !== url) throw new Error("Unexpected hourly comparison source");
      freeMarketHistoryBalance(new Headers(delivery.headers));
      const capture = importMarketHistoryHours(delivery, symbol, asOf ?? new Date().toISOString(), grid, adjustment);
      if (Date.parse(capture.through) < Date.parse(close!) || Date.parse(capture.capturedAt) < Date.parse(close!))
        throw new ComparisonUnavailable(symbol + " hourly control ends before " + through + " close");
      return capture;
    };
    const stored = await readResearchReceipt<DeliveredMarketHistoryHours>(path);
    if (stored) { verify(stored); return stored; }
    if (cachedOnly) throw new ComparisonUnavailable("Missing saved " + symbol + " hourly control through " + through);
    if (!ready) {
      if (!account) {
        const key = environmentKey || (await readResearchReceipt<{ apiKey: string }>(
          resolve(root, ".consensus/private-market-history/credentials.json")))?.apiKey;
        if (!key) throw new ComparisonUnavailable("No active free Market History account for the hourly price comparison");
        account = { key, signal };
      }
      const catalogue = JSON.parse((await marketHistoryPreview("stocks/us/" + symbol, fetcher)).text);
      const frames = catalogue.bars?.timeframes?.filter((r: { timeframe: string; feed: string; venue: string }) =>
        r.timeframe === "1m" && r.feed === "consolidated" && r.venue === "US consolidated tape");
      if (catalogue.dataset !== "stocks/us" || catalogue.ticker !== symbol || catalogue.contract?.status !== "active" ||
          frames?.length !== 1 || !Number.isFinite(Date.parse(frames[0].last))) throw new Error("Invalid Market History catalogue for " + symbol);
      if (Date.parse(frames[0].last) < Date.parse(close!))
        throw new ComparisonUnavailable(symbol + " Market History catalogue has not delivered " + through + " close");
      ready = true;
    }
    const delivery = await fetchFreeEtfHours(symbol, from, through, grid, account!, fetcher, adjustment);
    const data = verify(delivery);
    // A delivered watermark alone can include a gap in one grid. Only pin a grid with every requested edge.
    const available = new Set(data.text.trim().split(/\r?\n/).map(line => Date.parse(JSON.parse(line).timestamp)));
    for (const day of days) {
      const clock = exchangeSession(day)!;
      const edge = grid === "exchange" ? Date.parse(clock.closeAt) - 3_600_000 : Date.parse(clock.openAt);
      if (!available.has(edge)) throw new ComparisonUnavailable(symbol + " hourly grid lacks the " + adjustment + " edge on " + day);
    }
    await durableDirectory(store, 0o700);
    try { await durableJSON(path, delivery, true); return delivery; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await readResearchReceipt<DeliveredMarketHistoryHours>(path);
      if (!prior) throw error;
      verify(prior); return prior;
    }
  }
  async function basis(adjustment: MarketHistoryAdjustment) {
    const opening = await readLeg(adjustment, "Asia/Kolkata"), closing = await readLeg(adjustment, "exchange");
    return readMarketHistoryPriceControl(symbol, days, { opening, closing }, adjustment, asOf ?? new Date().toISOString());
  }
  const raw = await basis("raw"), splits = await basis("splits");
  const proof: HourlyControlProof = { provider: "market-history", from, through, raw: raw.sha256, splits: splits.sha256 };
  return { raw: [raw], splits: [splits], proof };
}
