import type { SessionPrice } from "./evaluation.ts";

export interface CashDistribution { session: string; amount: number }
export interface ShareSplit { session: string; ratio: number }
export interface PriceReference {
  sessions: SessionPrice[];
  distributions: CashDistribution[];
  splits: ShareSplit[];
}

export function reconcileAdjustedPrices(
  provider: string,
  raw: Pick<SessionPrice, "open" | "close">[],
  reported: Pick<SessionPrice, "open" | "close">[],
  { sessions, distributions, splits }: PriceReference,
) {
  const expected = adjustETFPrices(sessions, distributions, splits);
  // Later corporate actions can rescale a whole window. Compare both fields on one basis.
  const scale = reported.at(-1)!.close / expected.at(-1)!.close;
  for (const [i, row] of sessions.entries()) {
    for (const field of ["open", "close"] as const) {
      if (Math.abs(raw[i][field] - row[field]) > 0.0001)
        throw new Error(`${provider} raw ${field} price differs from the independent reference`);
      if (Math.abs(reported[i][field] / scale / expected[i][field] - 1) > 0.000001)
        throw new Error(`${provider} ${field} adjustment differs from the issuer-based reference`);
    }
  }
  return { sessions: sessions.length, cashDistributions: distributions.length, splits: splits.length };
}

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
