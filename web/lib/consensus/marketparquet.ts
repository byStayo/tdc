import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
import { exchangeSession, verifyExpectedSessions } from "./exchange-calendar.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { INSTRUMENTS } from "./types.ts";

export const MARKETPARQUET_SOURCE = "https://marketparquet.com/data/etfs";
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
