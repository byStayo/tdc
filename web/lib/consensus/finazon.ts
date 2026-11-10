import { adjustETFPrices, type CashDistribution, type ShareSplit } from "./corporate-adjustment.ts";
import type { SessionPrice } from "./evaluation.ts";
import { exchangeSession, verifyExpectedSessions } from "./exchange-calendar.ts";
import { newYorkTimestamp } from "./time.ts";

export interface FinazonReference {
  timestampBasis: "session-open" | "utc-midnight" | "new-york-midnight";
  sessions: SessionPrice[];
  distributions: CashDistribution[];
  splits: ShareSplit[];
}

function readBars(value: unknown, stamps: number[]) {
  const data = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== stamps.length)
    throw new Error("Finazon session coverage differs from the reference");
  const bars = new Map<number, { open: number; close: number }>();
  for (const row of data) {
    if (!row || !Number.isSafeInteger(row.t) || bars.has(row.t))
      throw new Error("Invalid or duplicate Finazon timestamp");
    if (![row.o, row.c].every(price => typeof price === "number" && Number.isFinite(price) && price > 0))
      throw new Error("Invalid Finazon opening or closing price");
    bars.set(row.t, { open: row.o, close: row.c });
  }
  return stamps.map(stamp => {
    const bar = bars.get(stamp);
    if (!bar) throw new Error("Finazon timestamp differs from the reviewed session basis");
    return bar;
  });
}

/** A sample check against independent price prints and issuer corporate actions. */
export function checkFinazonSeries(raw: unknown, adjusted: unknown, reference: FinazonReference) {
  const { sessions, timestampBasis, distributions, splits } = reference;
  if (!Array.isArray(sessions) || sessions.length < 2 || !Array.isArray(distributions) || !Array.isArray(splits))
    throw new Error("Missing independent price and corporate-action reference");
  const days = sessions.map(row => row.session);
  verifyExpectedSessions(days);
  const stamps = sessions.map(row => {
    const session = exchangeSession(row.session);
    if (!session || row.openAt !== session.openAt || row.closeAt !== session.closeAt)
      throw new Error("Reference does not match reviewed regular session");
    switch (timestampBasis) {
      case "session-open": return Date.parse(session.openAt) / 1_000;
      case "utc-midnight": return Date.parse(row.session + "T00:00:00Z") / 1_000;
      case "new-york-midnight": return Date.parse(newYorkTimestamp(row.session.replaceAll("-", "") + "T000000")!) / 1_000;
      default: throw new Error("Unverified daily timestamp basis");
    }
  });
  const unadjusted = readBars(raw, stamps), reported = readBars(adjusted, stamps);
  const expected = adjustETFPrices(sessions, distributions, splits);
  // A later action can change the level of every reported price in this window.
  // Normalize the final close and compare both fields on that common basis.
  const scale = reported.at(-1)!.close / expected.at(-1)!.close;
  for (const [i, row] of sessions.entries()) {
    for (const field of ["open", "close"] as const) {
      if (Math.abs(unadjusted[i][field] - row[field]) > 0.0001)
        throw new Error("Finazon raw " + field + " price differs from the independent reference");
      if (Math.abs(reported[i][field] / scale / expected[i][field] - 1) > 0.000001)
        throw new Error("Finazon " + field + " adjustment differs from the issuer-based reference");
    }
  }
  return { sessions: sessions.length, cashDistributions: distributions.length, splits: splits.length };
}
