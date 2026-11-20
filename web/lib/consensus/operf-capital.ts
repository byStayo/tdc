import { INSTRUMENTS, type Signal } from "./types.ts";

export const OPERF_ID = "oregon-perf-equity-capital";
export const OPERF_INDEX = "https://www.oregon.gov/treasury/invested-for-oregon/Pages/Performance-Holdings.aspx";
export const OPERF_UNIT = "$m";
const documentPath = "/treasury/invested-for-oregon/Documents/Invested-for-OR-Performance-and-Holdings/";
const endings = ["03-31", "06-30", "09-30", "12-31"];
const labels = ["Change in reported capital contributed", "Change in reported capital distributed"];
export type OperfQuarter = { period: string; url: string };
type Document = OperfQuarter & { sha256: string };
export type OperfEvidence = {
  previous: Document; current: Document; firstObservedAt: string;
  previousFunds: number; currentFunds: number; commonFunds: number;
  decreasingContributions: number; decreasingDistributions: number;
};
const validSha = (s: string) => /^[a-f0-9]{64}$/.test(s);
export const validInstant = (s: string) => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const quarterIndex = (day: string) => /^(?:19|20)\d{2}-/.test(day) && endings.includes(day.slice(5))
  ? Number(day.slice(0, 4)) * 4 + endings.indexOf(day.slice(5)) : NaN;
function official(url: string) {
  const u = new URL(url);
  return u.origin === "https://www.oregon.gov" && !u.username && !u.password && !u.port && !u.search && !u.hash &&
    u.pathname.startsWith(documentPath) && /^20\d{2}\/[A-Za-z0-9_.() -]+\.pdf$/i.test(decodeURI(u.pathname.slice(documentPath.length)));
}
export function operfPeriods(html: string, cutoff: string): [OperfQuarter, OperfQuarter] {
  if (!validInstant(cutoff) || html.length > 2_000_000) throw Error("Invalid Oregon holdings index or cutoff");
  const found = new Map<number, OperfQuarter>();
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = anchor[2].replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;|\s+/gi, " ").trim();
    if (!/^OPERF Private Equity Portfolio\b/i.test(label)) continue;
    const m = /^OPERF Private Equity Portfolio\s*[-–]\s*Quarter\s*([1-4]),?\s+(20\d{2})$/i.exec(label);
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(anchor[1])?.[1];
    if (!m || !href) throw Error("Unrecognized Oregon private-equity report listing");
    const period = m[2] + "-" + endings[Number(m[1]) - 1], url = new URL(href, OPERF_INDEX).href;
    const n = quarterIndex(period);
    if (!official(url) || period > cutoff.slice(0, 10) || (found.has(n) && found.get(n)!.url !== url))
      throw Error("Invalid or conflicting Oregon quarter");
    found.set(n, { period, url });
  }
  const latest = Math.max(...found.keys());
  const prior = found.get(latest - 1), current = found.get(latest);
  if (!prior || !current || prior.url === current.url) throw Error("Two adjacent Oregon private-equity schedules are required");
  return [prior, current];
}

export function operfSignal(at: string, evidence?: OperfEvidence, changes?: [number, number]): Signal {
  const signal: Signal = {
    id: OPERF_ID, family: "capital", title: "Oregon pension private-equity capital", shortLabel: "Oregon pension capital",
    instruments: [...INSTRUMENTS], directionalInstruments: [], status: "unavailable",
    summary: "Two comparable Oregon public pension private-equity schedules are unavailable.",
    methodology: "Compare cumulative capital contributed and distributed across adjacent quarter ends for partnerships with the same reported name and vintage year. Availability begins when both schedules were observed. The original publication time is unknown.",
    limitation: "One public limited partner. Changes in reported balances can reflect revisions, currency translation or secondary sales. Gross cash calls and market-wide flows cannot be inferred.",
    source: {name: "Oregon State Treasury", url: OPERF_INDEX, observedAt: null, releasedAt: null, retrievedAt: at,
      frequency: "quarterly", attribution: "Oregon State Treasury, Oregon Public Employees Retirement Fund. Calculations by The Daily Consensus.",
      usage: "Two independently calculated aggregate facts from the publicly posted schedules. Partnership tables, valuations and performance measures are excluded.", sha256: null},
    scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 210, unit: OPERF_UNIT, series: [], metrics: [],
  };
  if (!evidence || !changes) return signal;
  const { previous, current, previousFunds, currentFunds, commonFunds } = evidence;
  const amount = (n: number) => (n < 0 ? "−" : "+") + "$" + Math.abs(n).toLocaleString("en-US", {maximumFractionDigits: 1}) + "m";
  return { ...signal, status: "available", operfCapital: evidence,
    source: {...signal.source, url: current.url, observedAt: current.period, sha256: current.sha256},
    summary: previous.period + " to " + current.period + " across " + commonFunds + " matched partnerships (" + previousFunds +
      " previously and " + currentFunds + " currently). Cumulative contributions changed by " + amount(changes[0]) +
      " and distributions by " + amount(changes[1]) + ".",
    metrics: labels.map((label, i) => ({ label, date: current.period, value: changes[i], unit: OPERF_UNIT })),
    series: [{date: current.period, value: changes[0]}],
  };
}

export function validateOperfCapital(signal: Signal, cutoff: string) {
  const e = signal.operfCapital;
  if (signal.id !== OPERF_ID) {
    if (e) throw Error("Oregon pension evidence attached to another signal");
    return;
  }
  if (signal.family !== "capital" || signal.unit !== OPERF_UNIT || signal.staleAfterDays !== 210 ||
      !signal.directionalInstruments || signal.directionalInstruments.length ||
      Object.values(signal.scores).some(value => value !== null) || signal.source.releasedAt !== null ||
      signal.source.vintageAt || signal.source.approvedAt || !validInstant(signal.source.retrievedAt) ||
      signal.source.retrievedAt > cutoff) throw Error("Invalid Oregon pension scope or clock");
  if (signal.status === "unavailable") {
    if (e || signal.metrics.length || signal.series.length || signal.source.observedAt || signal.source.sha256 || signal.source.url !== OPERF_INDEX)
      throw Error("Unavailable Oregon pension source contains data");
    return;
  }
  if (!e || Object.keys(e).sort().join(",") !== "commonFunds,current,currentFunds,decreasingContributions,decreasingDistributions,firstObservedAt,previous,previousFunds" ||
      !["available", "stale"].includes(signal.status) || !validInstant(e.firstObservedAt) ||
      e.firstObservedAt > signal.source.retrievedAt || e.current.period > e.firstObservedAt.slice(0, 10) ||
      quarterIndex(e.current.period) - quarterIndex(e.previous.period) !== 1 || e.previous.url === e.current.url ||
      [e.current, e.previous].some(d => Object.keys(d).sort().join(",") !== "period,sha256,url" || !official(d.url) || !validSha(d.sha256)) ||
      e.current.sha256 === e.previous.sha256 ||
      signal.source.url !== e.current.url || signal.source.sha256 !== e.current.sha256 || signal.source.observedAt !== e.current.period ||
      ![e.commonFunds, e.previousFunds, e.currentFunds].every(n => Number.isSafeInteger(n) && n > 0) ||
      e.commonFunds > Math.min(e.previousFunds, e.currentFunds) ||
      ![e.decreasingContributions, e.decreasingDistributions].every(n => Number.isSafeInteger(n) && n >= 0 && n <= e.commonFunds) ||
      signal.metrics.length !== 2 || signal.metrics.some((m, i) => m.label !== labels[i] || m.unit !== OPERF_UNIT ||
        m.date !== e.current.period || !Number.isSafeInteger(Math.round(m.value * 10)) || m.value !== Math.round(m.value * 10) / 10) ||
      signal.series.length !== 1 || signal.series[0].date !== e.current.period || signal.series[0].value !== signal.metrics[0].value)
    throw Error("Invalid Oregon pension comparison");
  const expected = operfSignal(signal.source.retrievedAt, e, [signal.metrics[0].value, signal.metrics[1].value]);
  if (signal.summary !== expected.summary || signal.methodology !== expected.methodology || signal.limitation !== expected.limitation ||
      signal.source.attribution !== expected.source.attribution || signal.source.usage !== expected.source.usage)
    throw Error("Altered Oregon pension attribution or aggregate scope");
}
