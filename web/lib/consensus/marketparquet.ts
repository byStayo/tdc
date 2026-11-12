import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
import { exchangeSession, verifyExpectedSessions } from "./exchange-calendar.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet-aggregate.ts";
import { INSTRUMENTS } from "./types.ts";

export { MARKETPARQUET_SOURCE } from "./marketparquet-aggregate.ts";
export const ETF_SYMBOLS = INSTRUMENTS.filter(symbol => symbol !== "MARKET");
type ETF = typeof ETF_SYMBOLS[number];
export type MarketParquetDay = {
  session: string;
  sha256: string;
  bars: Record<ETF, Pick<SessionPrice, "open" | "close">>;
};

export function marketParquetEvidence(
  calendar: string[], files: MarketParquetDay[], cash: Record<ETF, CashDistribution[]>,
): PriceEvidence[] {
  verifyExpectedSessions(calendar);
  const allowed = new Set(calendar);
  const byDate = new Map(files.map(file => [file.session, file]));
  if (byDate.size !== files.length || files.some(file => !allowed.has(file.session) ||
    !/^[a-f0-9]{64}$/.test(file.sha256) || Object.keys(file.bars).length !== ETF_SYMBOLS.length ||
    ETF_SYMBOLS.some(symbol => !file.bars[symbol] ||
      ![file.bars[symbol].open, file.bars[symbol].close].every(price => Number.isFinite(price) && price > 0))))
    throw new Error("Incomplete or invalid MarketParquet session evidence");

  return ETF_SYMBOLS.map(instrument => {
    const distributions = cash[instrument];
    if (!Array.isArray(distributions) ||
        new Set(distributions.map(action => action.session)).size !== distributions.length ||
        distributions.some(action => !exchangeSession(action.session) || !(action.amount > 0) ||
          !Number.isFinite(action.amount)))
      throw new Error(`Invalid issuer distributions for ${instrument}`);

    const blocks: SessionPrice[][] = [];
    let block: SessionPrice[] = [];
    for (const session of calendar) {
      const file = byDate.get(session);
      if (file) {
        if (!block.length) blocks.push(block);
        block.push({ ...exchangeSession(session)!, ...file.bars[instrument] });
      } else {
        block = [];
      }
    }
    // Each contiguous block shares one price basis. A missing date cannot be
    // bridged by a multi-session outcome. The vendor already applies splits.
    const sessions = blocks.flatMap(rows => adjustETFPrices(rows, distributions.filter(
      action => action.session >= rows[0].session && action.session <= rows.at(-1)!.session,
    ), []));
    return { instrument, source: MARKETPARQUET_SOURCE, adjustment: OUTCOME_PRICE_BASIS,
      expectedSessions: calendar, sessions };
  });
}

/** Short sessions stay out of the evidence until an operator review lists them. */
export function reviewedMarketParquetDays(files: MarketParquetDay[], reviewedEarlyCloses: Iterable<string>): MarketParquetDay[] {
  const reviewed = new Set(reviewedEarlyCloses);
  return files.filter(file => {
    const bar = exchangeSession(file.session);
    if (!bar) throw new Error("MarketParquet bar outside an exchange session");
    return Date.parse(bar.closeAt) - Date.parse(bar.openAt) >= 6.5 * 3600000 || reviewed.has(file.session);
  });
}

export type ReferenceBars = Record<ETF, { session: string; open: number; close: number }[]>;
export interface ReconciliationTolerance { openBps: number; closeBps: number }

/**
 * Compare vendor bars with an independent unadjusted reference. The reference
 * must be on the as-traded share basis, so a vendor split restatement or cash
 * adjustment appears as a price difference. Returns differences only.
 */
export function reconcileMarketParquet(
  calendar: string[], files: MarketParquetDay[], cash: Record<ETF, CashDistribution[]>,
  reference: ReferenceBars, tolerance: ReconciliationTolerance,
) {
  verifyExpectedSessions(calendar);
  if (!files.length || files.some((file, index) => !calendar.includes(file.session) ||
    (index > 0 && file.session <= files[index - 1].session)))
    throw new Error("Vendor sessions must be ordered exchange sessions");
  if (![tolerance.openBps, tolerance.closeBps].every(limit => Number.isFinite(limit) && limit > 0 && limit <= 25))
    throw new Error("Invalid reconciliation tolerance");
  const byDate = new Map(files.map(file => [file.session, file]));
  const early = files.map(file => file.session).filter(session => {
    const bar = exchangeSession(session)!;
    return Date.parse(bar.closeAt) - Date.parse(bar.openAt) < 6.5 * 3600000;
  });
  const symbols = ETF_SYMBOLS.map(symbol => {
    const rows = reference[symbol];
    if (!Array.isArray(rows) || new Set(rows.map(row => row.session)).size !== rows.length ||
        rows.some(row => ![row.open, row.close].every(price => Number.isFinite(price) && price > 0)))
      throw new Error(`Invalid independent reference for ${symbol}`);
    const independent = new Map(rows.map(row => [row.session, row]));
    const matched: string[] = [], unmatched: string[] = [], differing: string[] = [];
    let maxOpenBps = 0, maxCloseBps = 0;
    for (const file of files) {
      const expected = independent.get(file.session);
      if (!expected) { unmatched.push(file.session); continue; }
      const open = Math.abs(file.bars[symbol].open / expected.open - 1) * 10000;
      const close = Math.abs(file.bars[symbol].close / expected.close - 1) * 10000;
      maxOpenBps = Math.max(maxOpenBps, open);
      maxCloseBps = Math.max(maxCloseBps, close);
      (open <= tolerance.openBps && close <= tolerance.closeBps ? matched : differing).push(file.session);
    }
    // A cash-adjusted vendor close would sit one distribution below the
    // as-traded close. Require the two closes to agree within half of it.
    const boundaries = cash[symbol].filter(action => byDate.has(action.session)).map(action => {
      const prior = calendar[calendar.indexOf(action.session) - 1];
      const vendor = byDate.get(prior)?.bars[symbol].close, expected = independent.get(prior)?.close;
      const status = vendor === undefined || expected === undefined ? "prior-session-missing" as const :
        Math.abs(vendor - expected) < action.amount / 2 && matched.includes(action.session) && matched.includes(prior) ?
          "verified" as const : "unresolved" as const;
      return { exDate: action.session, priorSession: prior, status };
    });
    return { symbol, compared: matched.length + differing.length, matched, unmatched, differing,
      maxOpenBps, maxCloseBps, boundaries,
      earlyClosesVerified: early.filter(session => matched.includes(session)) };
  });
  const complete = (session: string) => symbols.every(row => row.matched.includes(session));
  // The share basis is verified only across an unbroken run of matched sessions.
  let verifiedThrough: string | null = null;
  for (const file of files) {
    if (!complete(file.session)) break;
    verifiedThrough = file.session;
  }
  return { sessions: files.map(file => file.session), symbols, verifiedThrough,
    passed: verifiedThrough === files.at(-1)!.session,
    earlyClosesVerified: early.filter(complete),
    boundarySymbolsVerified: symbols.filter(row => row.boundaries.some(item => item.status === "verified")).map(row => row.symbol) };
}
