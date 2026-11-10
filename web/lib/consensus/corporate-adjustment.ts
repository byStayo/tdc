import type { SessionPrice } from "./evaluation.ts";

export interface CashDistribution { session: string; amount: number }
export interface ShareSplit { session: string; ratio: number }

/** Back-adjust both prices onto the final session's share and distribution basis. */
export function adjustETFPrices(
  rows: SessionPrice[],
  distributions: CashDistribution[],
  splits: ShareSplit[],
): SessionPrice[] {
  const sessions = new Set(rows.map(row => row.session));
  if (rows.length !== sessions.size || rows.some((row, index) =>
    ![row.open, row.close].every(price => Number.isFinite(price) && price > 0) ||
    (index > 0 && row.session <= rows[index - 1].session)))
    throw new Error("Invalid ordered price sessions");

  const cash = new Map(distributions.map(action => [action.session, action.amount]));
  const ratios = new Map(splits.map(action => [action.session, action.ratio]));
  if (cash.size !== distributions.length || ratios.size !== splits.length)
    throw new Error("Duplicate corporate action session");
  for (const [session, amount] of cash) {
    if (!sessions.has(session)) throw new Error("Cash distribution outside a price session");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid cash dividend");
    if (ratios.has(session)) throw new Error("Cash dividend and split in the same session need an explicit share basis");
  }
  for (const [session, ratio] of ratios) {
    if (!sessions.has(session)) throw new Error("Share split outside a price session");
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) throw new Error("Invalid share split");
  }

  let factor = 1;
  const adjusted = rows.slice();
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const open = row.open * factor, close = row.close * factor;
    if (![open, close].every(price => Number.isFinite(price) && price > 0))
      throw new Error("Corporate actions produced an invalid price");
    adjusted[index] = { ...row, open, close };
    const split = ratios.get(row.session);
    if (split !== undefined) factor /= split;
    const amount = cash.get(row.session);
    if (amount !== undefined && index > 0) {
      const priorClose = rows[index - 1].close;
      if (amount >= priorClose) throw new Error("Cash dividend exceeds or equals prior close");
      factor *= (priorClose - amount) / priorClose;
    }
  }
  return adjusted;
}
