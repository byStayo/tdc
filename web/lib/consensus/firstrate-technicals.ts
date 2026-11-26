import { createHash } from "node:crypto";
import { exchangeSession, hasReviewedCalendarRange } from "./exchange-calendar.ts";
import type { SessionPrice } from "./evaluation.ts";
import { missingSignals } from "./registry.ts";
import type { Signal } from "./types.ts";

export const FIRST_RATE_SOURCE = "https://firstratedata.com/stock-data";
export const FIRST_RATE_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA"] as const;
const prefix = "firstrate-technical-";
type ETF = typeof FIRST_RATE_SYMBOLS[number];
type Scope = ETF | "MARKET";
const attribution = "Price data from FirstRate Data. Technical calculations by The Daily Consensus.";
const usage = "Attributed derived statistics under the FirstRate Data licence. The publisher holds the underlying bars privately.";
const returnLabels = ["Regular-session change", "One-session close change", "Five-session close change",
  "Twenty-session close change", "Twenty-session daily volatility"];
const breadthLabels = ["Advancing ETFs", "Declining ETFs", "Unchanged ETFs"];
const rounded = (value: number) => Number(value.toFixed(1)) || 0;
const change = (end: number, start: number) => rounded(100 * (end / start - 1));
const breadthHash = (hashes: string[], counts: number[]) =>
  createHash("sha256").update(JSON.stringify({ hashes, counts })).digest("hex");
const instant = (value: string | undefined): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const url = (symbol: Scope) => symbol === "MARKET" ? FIRST_RATE_SOURCE : `https://firstratedata.com/i/etf/${symbol}`;

export interface TechnicalEvidence {
  symbol: ETF;
  reviewedThrough: string;
  sessions: SessionPrice[];
  expectedSessions: string[];
  retrievedAt: string;
  vintageAt: string;
  sha256: string;
}
type SourceStamp = Pick<TechnicalEvidence, "retrievedAt" | "vintageAt" | "sha256">;

function signal(scope: Scope, closeAt: string, stamp: SourceStamp, values: number[]): Signal {
  const market = scope === "MARKET";
  const day = closeAt.slice(0, 10), unit = market ? "ETFs" : "%";
  const labels = market ? breadthLabels : returnLabels;
  const title = market ? "U.S. equity ETF breadth" : `${scope} price momentum`;
  const summary = market ? `${values[0]} of four equity ETFs advanced from the previous close on ${day}.`
    : `${scope} moved ${values[0].toFixed(1)}% from the regular-session open to the close on ${day}.`;
  return { id: prefix + scope, family: "technicals", title, shortLabel: title, instruments: [scope],
    directionalInstruments: [], status: "available", summary, staleAfterDays: 5, unit,
    series: [{ date: day, value: values[0] }],
    metrics: values.map((value, i) => ({ label: labels[i], value, unit, date: day })),
    scores: { daily: null, weekly: null, monthly: null },
    methodology: market
      ? "Count advances, declines and unchanged closes across SPY, QQQ, IWM and DIA on the same two consecutive exchange sessions. Compare issuer-adjusted closes before rounding."
      : "Compare the reviewed regular-session open and close. Momentum compares consecutive issuer-adjusted closes over one, five and twenty exchange sessions. Volatility is the root mean square of twenty daily log returns. Percentages are rounded to one decimal.",
    limitation: market ? "This four-benchmark sample measures ETF participation. Predictive value remains unverified."
      : "Longer windows appear as consecutive approved bars accumulate. These historical movements have yet to qualify for a forecast vote.",
    source: { name: "FirstRate Data", url: url(scope), observedAt: closeAt, ...stamp, releasedAt: null,
      attribution, usage, frequency: "completed exchange sessions" } };
}

export function technicalSignals(inputs: TechnicalEvidence[], cutoff: string): Signal[] {
  const result: Signal[] = [];
  const moves: { day: string; direction: number; stamp: SourceStamp }[] = [];
  for (const item of inputs) {
    const { retrievedAt, vintageAt, sha256, reviewedThrough } = item;
    const last = item.sessions.at(-1);
    if (!last || last.session !== reviewedThrough) continue;
    if (!instant(cutoff) || !instant(retrievedAt) || !instant(vintageAt) || !/^[a-f0-9]{64}$/.test(sha256) ||
        vintageAt < last.closeAt || retrievedAt < vintageAt || retrievedAt > cutoff)
      throw new Error("Invalid technical source timing or provenance");
    const stamp = { retrievedAt, vintageAt, sha256 };
    const end = item.expectedSessions.indexOf(reviewedThrough);
    if (end < 0) throw new Error("Technical observation outside the reviewed exchange calendar");
    // Look back only through the most recent, uninterrupted block of approved rows.
    const rows = [last];
    for (let lag = 1; lag <= 20 && lag <= end; lag++) {
      const bar = item.sessions[item.sessions.length - 1 - lag];
      if (!bar || bar.session !== item.expectedSessions[end - lag] || !hasReviewedCalendarRange(bar.session, reviewedThrough)) break;
      rows.push(bar);
    }
    const values = [change(last.close, last.open)];
    for (const lag of [1, 5, 20]) if (rows[lag]) values.push(change(last.close, rows[lag].close));
    if (rows.length === 21) {
      const squares = rows.slice(1).map((bar, i) => Math.log(rows[i].close / bar.close) ** 2);
      values.push(rounded(100 * Math.sqrt(squares.reduce((a, b) => a + b, 0) / 20)));
    }
    result.push(signal(item.symbol, last.closeAt, stamp, values));
    if (rows[1]) {
      const prior = rows[1].close;
      const difference = last.close - prior;
      // Cash back-adjustment can shift a mathematically flat pair by a floating-point rounding unit.
      const precision = 2 * Number.EPSILON * Math.max(last.close, prior);
      moves.push({ day: last.closeAt, direction: Math.abs(difference) <= precision ? 0 : Math.sign(difference), stamp });
    }
  }
  if (moves.length === FIRST_RATE_SYMBOLS.length && moves.every(row => row.day === moves[0].day)) {
    const counts = [1, -1, 0].map(value => moves.filter(row => row.direction === value).length);
    const hash = breadthHash(moves.map(row => row.stamp.sha256), counts);
    result.unshift(signal("MARKET", moves[0].day, { sha256: hash,
      retrievedAt: moves.map(row => row.stamp.retrievedAt).sort().at(-1)!,
      vintageAt: moves.map(row => row.stamp.vintageAt).sort().at(-1)! }, counts));
  }
  return result;
}

export function replaceTechnicalSignals(signals: Signal[], readings: Signal[], cutoff: string): Signal[] {
  const missing = missingSignals(cutoff).find(s => s.id === "daily-prices")!;
  const covered = new Set(readings.flatMap(s => s.instruments));
  missing.instruments = missing.instruments.filter(symbol => !covered.has(symbol));
  const owns = (s: Signal) => s.id === missing.id || s.id.startsWith(prefix);
  const index = signals.findIndex(owns);
  const rest = signals.filter(s => !owns(s));
  rest.splice(index < 0 ? rest.length : index, 0, ...readings, ...(missing.instruments.length ? [missing] : []));
  return rest;
}

export function validateFirstRateTechnical(signal: Signal) {
  if (!signal.id.startsWith(prefix)) return;
  const scope = signal.id.slice(prefix.length) as Scope;
  const { source, metrics, series } = signal;
  const market = scope === "MARKET", observed = source.observedAt;
  if ((!market && !FIRST_RATE_SYMBOLS.some(symbol => symbol === scope)) || signal.family !== "technicals" ||
      signal.instruments.length !== 1 || signal.instruments[0] !== scope || signal.status !== "available" ||
      !signal.directionalInstruments || signal.directionalInstruments.length ||
      Object.values(signal.scores).some(score => score !== null) || signal.staleAfterDays !== 5 ||
      source.url !== url(scope) || source.attribution !== attribution || source.usage !== usage ||
      source.frequency !== "completed exchange sessions" || source.name !== "FirstRate Data" ||
      !observed || !instant(observed) || exchangeSession(observed.slice(0, 10))?.closeAt !== observed ||
      !instant(source.vintageAt) || !instant(source.retrievedAt) || source.releasedAt !== null ||
      source.vintageAt < observed || source.retrievedAt < source.vintageAt)
    throw new Error("Invalid technical observation scope or source timing");
  const day = observed.slice(0, 10), labels = market ? breadthLabels : returnLabels;
  if (signal.unit !== (market ? "ETFs" : "%") || series.length !== 1 || series[0].date !== day ||
      series[0].value !== metrics[0]?.value || (market ? metrics.length !== 3 : ![1, 2, 3, 5].includes(metrics.length)) ||
      metrics.some((m, i) => m.date !== day || m.unit !== signal.unit || m.label !== labels[i] ||
        !Number.isFinite(m.value) || (market ? !Number.isInteger(m.value) || m.value < 0 :
          rounded(m.value) !== m.value || m.value < (i === 4 ? 0 : -100))) ||
      (market && metrics.reduce((sum, m) => sum + m.value, 0) !== FIRST_RATE_SYMBOLS.length))
    throw new Error("Invalid technical metrics or breadth counts");
}

export function validateFirstRateBreadth(signals: Signal[]) {
  const market = signals.find(row => row.id === prefix + "MARKET");
  if (!market) return;
  const etfs = FIRST_RATE_SYMBOLS.map(symbol => signals.find(row => row.id === prefix + symbol));
  if (!etfs.every(row => row !== undefined && row.metrics.length >= 2 && row.source.observedAt === market.source.observedAt))
    throw new Error("Market breadth lacks four dated ETF comparisons");
  const changes = etfs.map(row => row!.metrics[1].value);
  if (market.source.sha256 !== breadthHash(etfs.map(row => row!.source.sha256!), market.metrics.map(m => m.value)) ||
      market.source.retrievedAt !== etfs.map(row => row!.source.retrievedAt).sort().at(-1) ||
      market.source.vintageAt !== etfs.map(row => row!.source.vintageAt).sort().at(-1) ||
      market.metrics[0].value < changes.filter(value => value > 0).length ||
      market.metrics[1].value < changes.filter(value => value < 0).length)
    throw new Error("Market breadth differs from its ETF evidence");
}
