import { reconcileAdjustedPrices, type PriceReference } from "./corporate-adjustment.ts";
import { exchangeSession, verifyExpectedSessions } from "./exchange-calendar.ts";

const price = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Reconcile a supplied daily response against independent regular-session prints and issuer actions. */
export function prepareTiingoSeries(value: unknown, reference: PriceReference) {
  const { sessions, distributions, splits } = reference;
  if (!Array.isArray(sessions) || sessions.length < 2 || !Array.isArray(distributions) || !Array.isArray(splits))
    throw new Error("Missing independent price and corporate-action reference");
  verifyExpectedSessions(sessions.map(row => row.session));
  if (!Array.isArray(value) || value.length !== sessions.length)
    throw new Error("Tiingo session coverage differs from the reference");
  const bars = new Map<string, Record<string, unknown>>();
  for (const row of value) {
    if (!row || typeof row.date !== "string" || !/^\d{4}-\d\d-\d\d(?:T00:00:00(?:\.0{1,9})?(?:Z|\+00:00))?$/.test(row.date))
      throw new Error("Invalid Tiingo trading date");
    const day = row.date.slice(0, 10);
    if (bars.has(day)) throw new Error("Duplicate Tiingo trading date");
    bars.set(day, row);
  }
  const dividendByDate = new Map(distributions.map(row => [row.session, row.amount]));
  const splitByDate = new Map(splits.map(row => [row.session, row.ratio]));
  const reconciled = sessions.map(session => {
    const scheduled = exchangeSession(session.session);
    if (!scheduled || session.openAt !== scheduled.openAt || session.closeAt !== scheduled.closeAt)
      throw new Error("Reference does not match reviewed regular session");
    const row = bars.get(session.session);
    if (!row) throw new Error("Tiingo trading date differs from the reviewed session");
    const { open, close, adjOpen, adjClose, divCash, splitFactor } = row;
    if (!price(open) || !price(close) || !price(adjOpen) || !price(adjClose))
      throw new Error("Invalid Tiingo raw or adjusted opening or closing price");
    if (typeof divCash !== "number" || !Number.isFinite(divCash) || divCash < 0 ||
        Math.abs(divCash - (dividendByDate.get(session.session) ?? 0)) > 0.00001)
      throw new Error("Tiingo cash distribution differs from the issuer reference");
    if (!price(splitFactor) || Math.abs(splitFactor - (splitByDate.get(session.session) ?? 1)) > 0.000001)
      throw new Error("Tiingo split factor differs from the issuer reference");
    return { raw: { open, close }, adjusted: { open: adjOpen, close: adjClose } };
  });
  const adjusted = reconciled.map(row => row.adjusted);
  const check = reconcileAdjustedPrices("Tiingo", reconciled.map(row => row.raw), adjusted, reference);
  return { check, sessions: sessions.map(({ session, openAt, closeAt }, i) => ({ session, openAt, closeAt, ...adjusted[i] })) };
}

export function checkTiingoSeries(value: unknown, reference: PriceReference) {
  return prepareTiingoSeries(value, reference).check;
}
