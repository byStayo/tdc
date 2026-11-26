import { extendedResearchSession } from "./extended-research-calendar.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import type { CashDistribution } from "./corporate-adjustment.ts";
import { coreSessionCloses, importMarketHistoryHours, parseMarketHistoryHours,
  type CoreClock, type DeliveredMarketHistoryHours, type MarketHistoryAdjustment } from "./market-history-closes.ts";
export type { MarketHistoryGrid } from "./market-history-closes.ts";

const HOUR = 3_600_000;
// The provider's original hourly reference files identify these securities on both aggregation grids.
export const MARKET_HISTORY_ETF_IDS = { SPY: 10860, QQQ: 9519, IWM: 6213, DIA: 3116, TLT: 11418 } as const;
export type MarketHistoryETF = keyof typeof MARKET_HISTORY_ETF_IDS;

type Bar = { session: string; open: number; close: number };
export const boundaryClock = (day: string) => hasReviewedCalendar(day) ? exchangeSession(day) : extendedResearchSession(day);
export type Boundary = CoreClock & { open: number | null; close: number | null; openingBucket: string | null;
  closingBucket: string | null; earlyClose: boolean };

export function freeMarketHistoryBalance(headers: Headers) {
  const total = headers.get("x-bars-remaining"), paid = headers.get("x-bars-paid-remaining"), cap = headers.get("x-cap-remaining");
  if (!total || !/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)) || paid !== "0" ||
      (cap !== null && (!/^\d+$/.test(cap) || !Number.isSafeInteger(Number(cap)))))
    throw new Error("Market History did not confirm a free-only account balance");
  return Math.min(Number(total), cap === null ? Infinity : Number(cap));
}

/** Each price is from a complete, documented one-hour bucket, with an edge on the exchange clock. */
export function marketHistoryBoundaries(opening: DeliveredMarketHistoryHours, closing: DeliveredMarketHistoryHours,
  clocks: CoreClock[], cutoff: string, symbol: MarketHistoryETF = "TLT", adjustment: MarketHistoryAdjustment = "raw"): Boundary[] {
  if (!Object.hasOwn(MARKET_HISTORY_ETF_IDS, symbol)) throw new Error("Unsupported Market History ETF");
  const openCapture = importMarketHistoryHours(opening, symbol, cutoff, "Asia/Kolkata", adjustment);
  const closeCapture = importMarketHistoryHours(closing, symbol, cutoff, "exchange", adjustment);
  const openQuery = new URL(opening.source).searchParams, closeQuery = new URL(closing.source).searchParams;
  const from = openQuery.get("start")!, through = openQuery.get("end")!;
  if (from !== closeQuery.get("start") || through !== closeQuery.get("end") || clocks.some((clock, i) => {
    const official = boundaryClock(clock.session);
    return clock.session < from || clock.session > through || (i > 0 && clocks[i - 1].session >= clock.session) ||
      !official || official.openAt !== clock.openAt || official.closeAt !== clock.closeAt;
  })) throw new Error("Market History boundaries require the same range and reviewed exchange sessions");
  const openHours = parseMarketHistoryHours(openCapture, symbol, "Asia/Kolkata", adjustment);
  const closeHours = parseMarketHistoryHours(closeCapture, symbol, "exchange", adjustment);
  if ([openHours, closeHours].some(hours => hours[0].symbol_id !== MARKET_HISTORY_ETF_IDS[symbol]))
    throw new Error(`The Market History ${symbol} instrument ID changed`);
  const byOpen = new Map(openHours.map(hour => [Date.parse(hour.timestamp), hour]));
  const { closes } = coreSessionCloses(closeHours, clocks, closeCapture.through);
  const byClose = new Map(closes.map(close => [close.session, close]));
  return clocks.map(clock => {
    const start = Date.parse(clock.openAt), end = Date.parse(clock.closeAt);
    const first = start + HOUR <= Date.parse(openCapture.through) ? byOpen.get(start) : undefined;
    const last = byClose.get(clock.session);
    return { ...clock, earlyClose: end - start < 6.5 * HOUR, open: first?.open ?? null, close: last?.close ?? null,
      openingBucket: first ? new Date(start).toISOString() : null, closingBucket: last?.bucketAt ?? null };
  });
}

/** Check the provider's consolidated edge prices against as-traded, split-only and independent listed history. */
export function compareMarketHistoryBoundary(row: Boundary, raw: Bar | undefined, splits: Bar | undefined,
  listed: Bar | undefined, issuerCovered: boolean, auction?: Bar) {
  if (row.open === null || row.close === null) return "boundary_missing";
  if (!raw || !splits || !listed || [raw, splits, listed].some(ref => ref.session !== row.session ||
      ![ref.open, ref.close].every(n => Number.isFinite(n) && n > 0))) return "reference_missing";
  if (raw.open !== splits.open || raw.close !== splits.close) return "split_basis";
  const { open, close } = row;
  if (Math.sign(close - open) !== Math.sign(raw.close - raw.open) ||
      Math.sign(close - open) !== Math.sign(listed.close - listed.open)) return "direction_difference";
  if ([raw, listed].some(ref => Math.abs(open / ref.open - 1) * 10_000 > 3)) return "open_difference";
  if ([raw, listed].some(ref => Math.abs(close / ref.close - 1) * 10_000 > 15)) return "close_difference";
  if (row.earlyClose && (!auction || auction.session !== row.session)) return "short_session_auction_missing";
  if (row.earlyClose && (open !== auction!.open || close !== auction!.close)) return "short_session_auction_difference";
  if (!issuerCovered) return "issuer_pending";
  return "matched";
}

/** A missing session, including a short day without exchange proof, breaks the adjustment basis of the window. */
export function contiguousTltWindows<T extends { day: string; status: string; boundary?: Pick<Boundary, "close">; raw: { close: number } | null }>(
  review: T[], cash: CashDistribution[],
) {
  const windows: T[][] = [];
  let current: T[] = [];
  for (const row of review) {
    const action = cash.find(r => r.session === row.day), previous = current.at(-1);
    const priorClose = previous?.boundary?.close, nativeClose = previous?.raw?.close;
    const verifiedAction = !action || (typeof priorClose === "number" && typeof nativeClose === "number" &&
      Math.abs(priorClose - nativeClose) < action.amount / 2);
    if (row.status === "matched" && verifiedAction) current.push(row);
    else if (current.length) { windows.push(current); current = []; }
  }
  if (current.length) windows.push(current);
  return windows;
}
