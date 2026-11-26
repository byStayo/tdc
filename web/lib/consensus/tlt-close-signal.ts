import { exchangeSession, trailingExchangeSessions } from "./exchange-calendar.ts";
import { RANGE_SOURCE as STOCKS_SOURCE } from "./regular-session-range.ts";
import { HORIZONS, type Signal } from "./types.ts";

export const TLT_CLOSE_ID = "market-history-tlt-closes";
const SOURCE = "https://getmarkethistory.com/docs/bars/";
const ATTRIBUTION = "Market History consolidated hourly bars and iShares TLT distributions. Calculations by The Daily Consensus.";
const USAGE = "Market History permits distribution of derived research. The underlying hourly prices stay private.";
const RECONCILED_FREQUENCY = "reconciled regular-session closes";
const RECONCILED_METHOD = "Compare the last consolidated trade in the hour ending at the regular close across consecutive full sessions. The settlement review verifies the session boundaries and split basis, then adjusts the closes for each iShares cash distribution on its ex-dividend date.";
const RECONCILED_LIMIT = "The consolidated closing trade can differ from the Nasdaq closing auction. Longer lookbacks appear as consecutive verified closes accumulate.";
const LABELS = ["One-session close change", "Five-session close change", "Twenty-session close change"];
export const TLT_CLOSE_STALE_DAYS = 5;
export const roundTltCloseChange = (value: number) => Number(value.toFixed(1)) || 0;
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const onlyKeys = (object: object, keys: string[]) => Object.keys(object).length === keys.length &&
  keys.every(key => Object.hasOwn(object, key));

export function pendingSettledTltInputs(reading: Signal, rangeSession?: string) {
  const day = reading.series[0].date;
  const pending = ["opening range"];
  if (rangeSession !== day) pending.push("full-session range");
  if (reading.metrics.length < 2) pending.push("five-session trend");
  if (reading.metrics.length < 3) pending.push("twenty-session trend");
  const list = new Intl.ListFormat("en", {type: "conjunction"}).format(pending);
  return `TLT has verified regular-session opens and closes through ${day}. The ${list} ${pending.length === 1 ? "remains" : "remain"} pending for that session.`;
}

export function tltCloseSignal(session: string, returns: number[], retrievedAt: string, sha256: string, approvedAt?: string): Signal {
  const clock = exchangeSession(session);
  if (!clock || returns.some(value => !Number.isFinite(value) || value < -100)) throw new Error("Invalid TLT closing returns");
  const values = returns.map(roundTltCloseChange);
  const signal: Signal = { id: TLT_CLOSE_ID, family: "technicals", instruments: ["TLT"], directionalInstruments: [],
    title: "TLT closing trend", shortLabel: "TLT closing trend", status: "available", staleAfterDays: TLT_CLOSE_STALE_DAYS, unit: "%",
    summary: `TLT’s dividend-adjusted closing-hour price changed ${values[0]}% from the previous session through ${session}.`,
    methodology: approvedAt ? RECONCILED_METHOD : "Use the last trade in the consolidated hourly bar ending at the scheduled regular close. Compare consecutive verified closes over one, five and twenty exchange sessions. Apply issuer cash on its ex-dividend date and round the changes to one decimal.",
    limitation: approvedAt ? RECONCILED_LIMIT : "The free feed is delayed. Its morning bucket starts before 9:30 a.m. The calculation measures closing trends only. The official Nasdaq closing auction can differ from the last trade in the hour.",
    scores: { daily: null, weekly: null, monthly: null },
    metrics: values.map((value, i) => ({ label: LABELS[i], value, unit: "%", date: session })),
    series: [{ date: session, value: values[0] }],
    source: { name: "Market History and iShares", url: approvedAt ? STOCKS_SOURCE : SOURCE, attribution: ATTRIBUTION, usage: USAGE,
      frequency: approvedAt ? RECONCILED_FREQUENCY : "completed regular-session closing hours", observedAt: clock.closeAt,
      releasedAt: null, retrievedAt, ...(approvedAt !== undefined ? { approvedAt } : {}), sha256 } };
  validateTltCloseSignal(signal);
  return signal;
}

export function validateTltCloseSignal(signal: Signal, cutoff?: string) {
  if (signal.id !== TLT_CLOSE_ID) return;
  const { source, metrics, series } = signal;
  const observed = source.observedAt, session = observed?.slice(0, 10);
  const reconciled = source.url === STOCKS_SOURCE;
  if (!onlyKeys(signal, ["id", "family", "instruments", "directionalInstruments", "title", "shortLabel", "status", "staleAfterDays",
        "unit", "summary", "methodology", "limitation", "scores", "metrics", "series", "source"]) ||
      !onlyKeys(source, ["name", "url", "attribution", "usage", "frequency", "observedAt", "releasedAt", "retrievedAt", "sha256",
        ...(reconciled ? ["approvedAt"] : [])]) ||
      !onlyKeys(signal.scores, [...HORIZONS]) || signal.family !== "technicals" || signal.instruments.length !== 1 || signal.instruments[0] !== "TLT" ||
      !signal.directionalInstruments || signal.directionalInstruments.length || signal.status !== "available" ||
      HORIZONS.some(h => signal.scores[h] !== null) ||
      signal.staleAfterDays !== TLT_CLOSE_STALE_DAYS || signal.unit !== "%" || (!reconciled && source.url !== SOURCE) || source.attribution !== ATTRIBUTION ||
      source.usage !== USAGE || source.name !== "Market History and iShares" ||
      source.frequency !== (reconciled ? RECONCILED_FREQUENCY : "completed regular-session closing hours") ||
      (reconciled && (!instant(source.approvedAt) || source.approvedAt < source.retrievedAt || (cutoff !== undefined && source.approvedAt > cutoff) ||
        signal.methodology !== RECONCILED_METHOD || signal.limitation !== RECONCILED_LIMIT)) ||
      !session || !instant(observed) || exchangeSession(session)?.closeAt !== observed || !instant(source.retrievedAt) ||
      source.retrievedAt < observed || source.releasedAt !== null || !/^[a-f0-9]{64}$/.test(source.sha256 ?? "") ||
      metrics.length < 1 || metrics.length > LABELS.length ||
      metrics.some((m, i) => Object.keys(m).length !== 4 || m.label !== LABELS[i] || m.unit !== "%" || m.date !== session || !Number.isFinite(m.value) ||
        m.value < -100 || roundTltCloseChange(m.value) !== m.value) ||
      series.length !== 1 || !onlyKeys(series[0], ["date", "value"]) || series[0].date !== session || series[0].value !== metrics[0].value)
    throw new Error("Invalid closing-hour observation for TLT");
  const earlier = new Date(Date.parse(session) - 40 * 86_400_000).toISOString().slice(0, 10);
  const window = [1, 5, 20][metrics.length - 1] + 1;
  const dates = trailingExchangeSessions(earlier, session).slice(-window);
  if (dates.length !== window || dates.some(day => {
    const clock = exchangeSession(day)!;
    return Date.parse(clock.closeAt) - Date.parse(clock.openAt) !== 390 * 60_000;
  })) throw new Error("TLT closing trend requires full sessions throughout its reported lookback");
}
