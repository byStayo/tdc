import { reconcileAdjustedPrices, type PriceReference } from "./corporate-adjustment.ts";
import { exchangeSession, verifyExpectedSessions } from "./exchange-calendar.ts";
import { newYorkTimestamp } from "./time.ts";

export interface FinazonReference extends PriceReference {
  timestampBasis: "session-open" | "utc-midnight" | "new-york-midnight";
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
  return reconcileAdjustedPrices("Finazon", unadjusted, reported, reference);
}
