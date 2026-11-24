import { exchangeSession } from "./exchange-calendar.ts";
import type { Horizon, Instrument } from "./types.ts";

/** Daily context kept outside the signal and model feature counts. */
export const RANGE_FUNDS = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
export type RangeFund = (typeof RANGE_FUNDS)[number];
export const RANGE_SOURCE = "https://getmarkethistory.com/docs/guides/historical-stock-market-data/";
export const RANGE_ATTRIBUTION =
  "Market History consolidated US equities. Regular-session calculation by The Daily Consensus.";
export const RANGE_POLICY = "regular-session-close-fifth-v1";
export const RANGE_MAX_AGE = 5 * 86_400_000;
export type SessionRange = {
  fund: RangeFund;
  session: string;
  closeFifth: number;
  observedAt: string;
  verifiedAt: string;
  receiptSha256: string;
};
export type SessionRanges = {
  method: typeof RANGE_POLICY;
  url: typeof RANGE_SOURCE;
  attribution: typeof RANGE_ATTRIBUTION;
  rows: SessionRange[];
};
export const rangeInstant = (s: unknown): s is string =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const exact = (v: object, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

export function validateSessionRanges(evidence: SessionRanges, cutoff: string) {
  if (
    !rangeInstant(cutoff) ||
    !evidence ||
    !exact(evidence, ["method", "url", "attribution", "rows"]) ||
    evidence.method !== RANGE_POLICY ||
    evidence.url !== RANGE_SOURCE ||
    evidence.attribution !== RANGE_ATTRIBUTION ||
    !Array.isArray(evidence.rows) ||
    !evidence.rows.length ||
    evidence.rows.length > RANGE_FUNDS.length ||
    new Set(evidence.rows.map((r) => r.fund)).size !== evidence.rows.length
  )
    throw Error("Invalid public session range");
  let previous = -1;
  for (const row of evidence.rows) {
    const index = RANGE_FUNDS.indexOf(row.fund),
      clock = exchangeSession(row.session);
    if (
      !exact(row, ["fund", "session", "closeFifth", "observedAt", "verifiedAt", "receiptSha256"]) ||
      index <= previous ||
      !clock ||
      Date.parse(clock.closeAt) - Date.parse(clock.openAt) !== 390 * 60_000 ||
      row.observedAt !== clock.closeAt ||
      !rangeInstant(row.verifiedAt) ||
      row.verifiedAt < clock.closeAt ||
      row.verifiedAt > cutoff ||
      Date.parse(cutoff) - Date.parse(clock.closeAt) > RANGE_MAX_AGE ||
      !/^[a-f0-9]{64}$/.test(row.receiptSha256) ||
      !Number.isInteger(row.closeFifth) ||
      row.closeFifth < 1 ||
      row.closeFifth > 5
    )
      throw Error("Invalid dated ETF close location");
    previous = index;
  }
}
export function visibleSessionRanges(
  evidence: SessionRanges | undefined,
  instrument: Instrument,
  horizon: Horizon,
  at: string,
) {
  if (!evidence || horizon !== "daily" || !rangeInstant(at)) return [];
  return evidence.rows.filter(
    (row) =>
      (instrument === "MARKET" || row.fund === instrument) &&
      row.verifiedAt <= at &&
      Date.parse(at) - Date.parse(row.observedAt) <= RANGE_MAX_AGE,
  );
}
