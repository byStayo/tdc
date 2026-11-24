import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { SESSION_HORIZONS } from "./evaluation.ts";
import { firstRateIssuerActionProof, type MarketHistoryActionProof } from "./market-history-actions.ts";
import type { MarketHistoryETF } from "./market-history-boundaries.ts";
import { collectMarketHistoryPriceControls } from "./market-history-price-controls.ts";
import type { ResearchPriceReceipt } from "./research-price-capture.ts";
import { ETF_SYMBOLS, type MarketParquetDay, type ReferenceBars } from "./marketparquet.ts";

export const MARKETPARQUET_HOURLY_REFERENCE = "https://getmarkethistory.com/docs/bars/";
export type MarketParquetIssuerCash = Record<MarketHistoryETF, CashDistribution[]>;
export type FundProof = { symbol: MarketHistoryETF; raw: string; splits: string; actions: string };
type Chunk = { from: string; through: string; funds: FundProof[] };
export type MarketParquetHourlyReference = {
  source: typeof MARKETPARQUET_HOURLY_REFERENCE; capturedAt: string; chunks: Chunk[];
};

const dayMs = 86_400_000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fixed consecutive windows independent of prices, provider responses, and outcomes. */
export function marketParquetHourlyWindows(dates: string[]) {
  const from = dates[0], through = dates.at(-1);
  if (!from || !through || !same(exchangeSessions(from, through), dates))
    throw new Error("MarketParquet hourly controls require every exchange session in order");
  const windows: string[][] = [];
  let window: string[] = [];
  for (const day of dates) {
    const session = exchangeSession(day)!;
    if (Date.parse(session.closeAt) - Date.parse(session.openAt) !== 6.5 * 3_600_000)
      throw new Error("Market History has no independently qualified exchange auction for the shortened session " + day);
    if (!window.length || Date.parse(day) - Date.parse(window[0]) > 35 * dayMs) {
      window = [];
      windows.push(window);
    }
    window.push(day);
  }
  return windows;
}

/** Join separately decoded native bases and the primary corporate-action evidence by identity and date. */
export function marketParquetFundReference(symbol: MarketHistoryETF, days: string[], raw: ResearchPriceReceipt,
  splits: ResearchPriceReceipt, actions: MarketHistoryActionProof) {
  if (actions.provider !== "market-history" || actions.scope !== "issuer-cash-vs-corporate-actions" ||
      actions.symbol !== symbol || actions.from !== days[0] || actions.through !== days.at(-1) ||
      [raw, splits].some(row => row.instrument !== symbol || row.from !== days[0] || row.through !== days.at(-1)))
    throw new Error("Market History price and corporate-action sources cover different targets");
  if (raw.sessions.length !== days.length || splits.sessions.length !== days.length || raw.sessions.some((row, i) =>
    row.session !== days[i] || row.session !== splits.sessions[i].session ||
    row.open !== splits.sessions[i].open || row.close !== splits.sessions[i].close))
    throw new Error("Market History raw and split-adjusted regular-session bounds differ for " + symbol);
  if (actions.issuerMirrorCount > 0)
    throw new Error("Market History cites the same issuer for a corporate action in the " + symbol + " review");
  return {
    proof: { symbol, raw: raw.sha256, splits: splits.sha256, actions: actions.sha256 },
    prices: raw.sessions.map(({ session, open, close }) => ({ session, open, close })),
  };
}

export async function collectMarketParquetFundReference(root: string, symbol: MarketHistoryETF, days: string[],
  cash: CashDistribution[], cachedOnly: boolean, options: { asOf?: string; fetcher?: typeof fetch; signal?: AbortSignal }) {
  const hours = await collectMarketHistoryPriceControls(root, symbol, days, cachedOnly, options);
  const actions = await firstRateIssuerActionProof(root, symbol, days[0], days.at(-1)!, cash, cachedOnly, options);
  return marketParquetFundReference(symbol, days, hours.raw[0], hours.splits[0], actions);
}

/**
 * Every hash covers the complete original source response in the private native store.
 * Replay uses that same store with collection disabled. It cannot select a different
 * provider or skip a failing fund, date, basis or dividend.
 */
export async function marketParquetHourlyControls(root: string, dates: string[], cash: MarketParquetIssuerCash,
  options: { replay?: MarketParquetHourlyReference; fetcher?: typeof fetch; now?: () => string } = {}) {
  const windows = marketParquetHourlyWindows(dates);
  const now = options.now ?? (() => new Date().toISOString());
  const asOf = options.replay?.capturedAt;
  if (options.replay && (Object.keys(options.replay).sort().join() !== "capturedAt,chunks,source" || options.replay.source !== MARKETPARQUET_HOURLY_REFERENCE ||
      typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf ||
      asOf > now() || asOf < exchangeSession(dates.at(-1)!)!.closeAt))
    throw new Error("Invalid Market History reference source or replay clock");

  const chunks: Chunk[] = [];
  const reference = {} as ReferenceBars;
  for (const symbol of ETF_SYMBOLS) reference[symbol] = [];
  const deadline = AbortSignal.timeout(180_000);
  const fetcher: typeof fetch = (input, init) => (options.fetcher ?? fetch)(input, {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
  const cachedOnly = !!options.replay;
  for (const days of windows) {
    const from = days[0], through = days.at(-1)!;
    const chunk: Chunk = { from, through, funds: [] };
    for (const symbol of ETF_SYMBOLS) {
      deadline.throwIfAborted();
      const fund = await collectMarketParquetFundReference(root, symbol, days, cash[symbol], cachedOnly, { asOf, fetcher, signal: deadline });
      chunk.funds.push(fund.proof);
      reference[symbol].push(...fund.prices);
    }
    chunks.push(chunk);
  }
  if (options.replay && !same(chunks, options.replay.chunks))
    throw new Error("Market History originals differ from the complete sealed reference");
  const proof: MarketParquetHourlyReference = { source: MARKETPARQUET_HOURLY_REFERENCE, capturedAt: asOf ?? now(), chunks };
  return { reference, proof };
}

/** A passing day-level review can still disagree near zero across a five- or 21-session span. */
export function verifyMarketParquetHorizonSigns(files: MarketParquetDay[], reference: ReferenceBars,
  cash: MarketParquetIssuerCash) {
  for (const symbol of ETF_SYMBOLS) {
    const days = files.map(file => file.session);
    const controls = reference[symbol];
    if (controls.length !== days.length || controls.some((row, i) => row.session !== days[i]))
      throw new Error("Market History horizon checks require every matching reference session for " + symbol);
    const distributions = cash[symbol].filter(action => action.session >= days[0] && action.session <= days.at(-1)!);
    const observed = adjustETFPrices(files.map(file => ({
      ...exchangeSession(file.session)!, ...file.bars[symbol],
    })), distributions, []);
    const compared = adjustETFPrices(controls.map(row => ({ ...exchangeSession(row.session)!, ...row })), distributions, []);
    for (const span of [SESSION_HORIZONS.weekly, SESSION_HORIZONS.monthly]) {
      for (let first = 0; first + span <= days.length; first++) {
        const last = first + span - 1;
        if (Math.sign(observed[last].close - observed[first].open) !== Math.sign(compared[last].close - compared[first].open))
          throw new Error("Market History adjusted horizon direction differs for " + symbol + " from " + days[first] + " through " + days[last]);
      }
    }
  }
}
