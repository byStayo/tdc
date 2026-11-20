import { isDeepStrictEqual } from "node:util";
import { effectiveStatus } from "./engine.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { FIRST_RATE_SYMBOLS } from "./firstrate-technicals.ts";
import { missingSignals } from "./registry.ts";
import type { Signal } from "./types.ts";

const prefix = "firstrate-premarket-";
const dayMs = 86_400_000;
type ETF = (typeof FIRST_RATE_SYMBOLS)[number];
export type PremarketSample = { symbol: ETF; session: string; changePct: number; activeMinutes: number;
  retrievedAt: string; vintageAt: string; sha256: string };
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function nextOpen(day: string) {
  for (let at = Date.parse(day) + dayMs; ; at += dayMs) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (!hasReviewedCalendar(date)) throw new Error("Next premarket expiry is outside the reviewed exchange calendar");
    const session = exchangeSession(date);
    if (session) return session.openAt;
  }
}

export function firstRatePremarketSignal(sample: PremarketSample, approvedAt: string, cutoff: string): Signal {
  const { symbol, session, activeMinutes, vintageAt, retrievedAt, sha256 } = sample;
  const change = sample.changePct || 0;
  const clock = exchangeSession(session);
  if (!clock || !FIRST_RATE_SYMBOLS.includes(symbol) || !Number.isFinite(sample.changePct) ||
      change < -100 || Number(change.toFixed(1)) !== change || !Number.isInteger(activeMinutes) ||
      activeMinutes < 2 || activeMinutes > 330 || !/^[a-f0-9]{64}$/.test(sha256) ||
      ![vintageAt, retrievedAt, approvedAt, cutoff].every(instant) || vintageAt < clock.closeAt ||
      retrievedAt < vintageAt || approvedAt < retrievedAt || cutoff < approvedAt)
    throw new Error("Invalid approved premarket observation");
  const expiry = nextOpen(session);
  // The 09:29 bar includes the last millisecond before the core open. Coverage expires at the following core open.
  const observedAt = new Date(Date.parse(clock.openAt) - 1).toISOString();
  const title = `${symbol} premarket on ${session}`;
  return { id: prefix + symbol, family: "premarket", title, shortLabel: title, instruments: [symbol], directionalInstruments: [],
    status: cutoff < expiry ? "available" : "stale", staleAfterDays: (Date.parse(expiry) - Date.parse(clock.openAt)) / dayMs,
    summary: `On ${session}, ${symbol} changed ${change.toFixed(1)}% from the 4:00 a.m. open to the close of the 9:29 a.m. New York bar. The archive records volume in ${activeMinutes} of 330 minutes.`,
    methodology: "Use the first open and final close in the same dated, split-adjusted premarket window. Count distinct observed minutes with positive volume. Display the price change to one decimal place.",
    limitation: "This historical window supplies prior-session context through the next regular open. The archive omits zero-volume bars. The minute count describes the source’s coverage. The change carries no forecast vote.",
    scores: { daily: null, weekly: null, monthly: null }, unit: "%", series: [{ date: session, value: change }],
    metrics: [{ label: "Premarket change", unit: "%", date: session, value: change },
      { label: "Recorded minutes out of 330", unit: "minutes", date: session, value: activeMinutes }],
    source: { name: "FirstRate Data", url: `https://firstratedata.com/i/etf/${symbol}`, observedAt, vintageAt, retrievedAt,
      approvedAt, sha256, releasedAt: null, frequency: "completed premarket sessions",
      attribution: "Price data from FirstRate Data. Premarket calculations by The Daily Consensus.",
      usage: "Attributed derived statistics under the FirstRate Data licence. The underlying minute bars stay private." } };
}

export function validateFirstRatePremarket(signal: Signal, cutoff: string) {
  if (!signal.id.startsWith(prefix)) return;
  const { source, metrics } = signal;
  const canonical = firstRatePremarketSignal({ symbol: signal.id.slice(prefix.length) as ETF,
    session: source.observedAt?.slice(0, 10) ?? "", changePct: metrics[0]?.value, activeMinutes: metrics[1]?.value,
    vintageAt: source.vintageAt!, retrievedAt: source.retrievedAt, sha256: source.sha256! }, source.approvedAt!, cutoff);
  if (!isDeepStrictEqual(signal, canonical)) throw new Error("Invalid premarket observation, scope or public fields");
}

export function replaceFirstRatePremarket(signals: Signal[], readings: Signal[] | undefined, cutoff: string): Signal[] {
  const ids = ["premarket-bars", "previous-premarket-bars"];
  const saved = signals.filter(row => row.id.startsWith(prefix));
  if (readings === undefined && !saved.length && !signals.some(s => s.id === "previous-premarket-bars")) return signals;
  const dated = (readings ?? saved).map(row => effectiveStatus(row, cutoff) === "stale" ? { ...row, status: "stale" as const } : row);
  const [current, missing] = missingSignals(cutoff).filter(row => ids.includes(row.id));
  const covered = dated.filter(row => row.status === "available").flatMap(row => row.instruments);
  missing.instruments = missing.instruments.filter(symbol => !covered.includes(symbol));
  const owns = (s: Signal) => ids.includes(s.id) || s.id.startsWith(prefix);
  const index = signals.findIndex(owns);
  const rest = signals.filter(s => !owns(s));
  const currentReading = signals.find(s => s.id === current.id && s.status !== "unavailable") ?? current;
  rest.splice(index < 0 ? rest.length : index, 0, currentReading, ...dated, ...(missing.instruments.length ? [missing] : []));
  return rest;
}
