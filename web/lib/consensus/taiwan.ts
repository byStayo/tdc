import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import { INSTRUMENTS, type Point, type Signal, type Snapshot } from "./types.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { missingSignals } from "./registry.ts";

export const TWSE_SERIES = [
  { id: "twse-taiex-price", title: "TAIEX price index", path: "MI_5MINS_HIST", catalog: "11755", field: "ClosingIndex" },
  { id: "twse-taiex-return", title: "TAIEX total-return index", path: "MFI94U", catalog: "11871", field: "TAIEXTotalReturnIndex" },
] as const;
type Spec = (typeof TWSE_SERIES)[number];
export const twseURL = (spec: Spec) => `https://openapi.twse.com.tw/v1/indicesReport/${spec.path}`;
const UNIT = "index points";
const frequency = "daily Taiwan end of day";
const usage = "Open Government Data License 1.0: https://data.gov.tw/en/license. Attributed reuse, retention and derived analysis permitted; no endorsement implied.";

function rocDate(value: unknown, cutoff: string): string {
  if (typeof value !== "string" || !/^\d{7}$/.test(value)) throw new Error("Invalid TWSE ROC date");
  const date = `${Number(value.slice(0, 3)) + 1911}-${value.slice(3, 5)}-${value.slice(5, 7)}`;
  if (publicDate(date) !== date || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > cutoff.slice(0, 10))
    throw new Error("Invalid or future TWSE observation date");
  return date;
}
function indexValue(value: unknown): number {
  if (typeof value !== "string" || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value))
    throw new Error("Invalid TWSE index value");
  const n = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid TWSE index value");
  return n;
}

/** Documented latest-month API rows. ROC years are converted, never observation ages. */
export function taiwanObservations(text: string, spec: Spec, cutoff: string) {
  if (!publicDate(cutoff) || new Date(cutoff).toISOString() !== cutoff || text.length > 2_000_000)
    throw new Error("Invalid TWSE document boundary");
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw) || !raw.length || raw.length > 31) throw new Error("Invalid TWSE monthly rows");
  const keys = spec.field === "ClosingIndex"
    ? ["Date", "OpeningIndex", "HighestIndex", "LowestIndex", "ClosingIndex"]
    : ["Date", "TAIEXTotalReturnIndex"];
  const rows = raw.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join() !== [...keys].sort().join())
      throw new Error("Unexpected TWSE schema");
    const fields = row as Record<string, unknown>;
    const date = rocDate(fields.Date, cutoff), value = indexValue(fields[spec.field]);
    if (spec.field === "ClosingIndex") {
      const open = indexValue(fields.OpeningIndex), high = indexValue(fields.HighestIndex), low = indexValue(fields.LowestIndex);
      if (low > Math.min(open, value) || high < Math.max(open, value) || low > high)
        throw new Error("Inconsistent TWSE OHLC range");
      return { date, value, open, high, low };
    }
    return { date, value };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(rows.map(row => row.date)).size !== rows.length || new Set(rows.map(row => row.date.slice(0, 7))).size !== 1)
    throw new Error("Duplicate dates or mixed TWSE months");
  return rows;
}

export async function collectTaiwan(read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Signal[]> {
  return Promise.all(TWSE_SERIES.map(async (spec): Promise<Signal> => {
    const signal: Signal = {
      id: spec.id, title: `Taiwan · ${spec.title}`, shortLabel: spec.title, family: "international",
      instruments: [...INSTRUMENTS], directionalInstruments: [], status: "unavailable",
      summary: "No usable Taiwan end-of-day index observation returned.",
      source: { name: `Taiwan Stock Exchange · ${spec.title}`, url: twseURL(spec), retrievedAt: now(), observedAt: null, releasedAt: null,
        frequency, attribution: "Taiwan Stock Exchange (TWSE); Securities and Futures Bureau, FSC", usage, sha256: null },
      methodology: `${spec.field === "ClosingIndex" ? "Taiwan listed-equity price index; opening, high, low and closing levels." : "Taiwan listed-equity total-return index with distributions reinvested, as defined by TWSE."} Latest-month daily observations; session change compares the last two returned observations. ROC dates converted to Gregorian dates. No forward fill or directional vote. Dataset https://data.gov.tw/dataset/${spec.catalog}.`,
      limitation: "Taiwan only. These related indices are not independent directional evidence, US ETF prices, executable returns or broad global equity coverage. Latest-month data can contain just one session; prior-month history is not supplied by this endpoint. Release clock time is not supplied.",
      series: [], metrics: [], scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 7, unit: UNIT,
    };
    try {
      const doc = await read(twseURL(spec));
      if (!publicDate(doc.retrievedAt) || new Date(doc.retrievedAt).toISOString() !== doc.retrievedAt || doc.retrievedAt > now() ||
          createHash("sha256").update(doc.text).digest("hex") !== doc.sha256)
        throw new Error("Invalid TWSE provenance");
      const rows = taiwanObservations(doc.text, spec, doc.retrievedAt), latest = rows.at(-1)!;
      const series: Point[] = rows.map(({ date, value }) => ({ date, value }));
      const metrics = [{ label: "Index level", value: latest.value, unit: UNIT, date: latest.date }];
      if ("open" in latest) for (const [label, value] of [["Open", latest.open!], ["High", latest.high!], ["Low", latest.low!]] as const)
        metrics.push({ label, value, unit: UNIT, date: latest.date });
      if (rows.length > 1) metrics.push({ label: "Observed-session change", value: (latest.value / rows.at(-2)!.value - 1) * 100, unit: "%", date: latest.date });
      return { ...signal, status: "available", series, metrics,
        summary: `${spec.title}: ${latest.value.toFixed(2)} index points on ${latest.date} (Taiwan session). ${rows.length} dated observation${rows.length === 1 ? "" : "s"}; Taiwan context only, no directional vote.`,
        source: { ...signal.source, observedAt: latest.date, retrievedAt: doc.retrievedAt, sha256: doc.sha256,
          attribution: `${signal.source.attribution}; ${latest.date.slice(0, 4)} ${spec.title}; Open Government Data License 1.0. Date conversion, charts and changes by The Daily Consensus.` },
      };
    } catch (error) { return { ...signal, failureKind: sourceFailureKind(error) }; }
  }));
}

/** New feeds never silently become votes, US price inputs or an invented release timestamp. */
export function validateTaiwan(signal: Signal): void {
  if (!signal.id.startsWith("twse-")) return;
  const spec = TWSE_SERIES.find(s => s.id === signal.id);
  if (!spec || signal.family !== "international" || signal.unit !== UNIT || signal.staleAfterDays !== 7 ||
      signal.source.url !== twseURL(spec) || signal.source.frequency !== frequency || signal.source.releasedAt !== null ||
      signal.source.usage !== usage || !signal.directionalInstruments || signal.directionalInstruments.length ||
      Object.values(signal.scores).some(v => v !== null) || signal.instruments.join() !== INSTRUMENTS.join())
    throw new Error("Invalid TWSE scope, licence, units or voting contract");
  if (signal.status === "unavailable") {
    if (signal.series.length || signal.metrics.length || signal.source.observedAt || signal.source.sha256)
      throw new Error("Unavailable TWSE source contains observations");
    return;
  }
  const latest = signal.series.at(-1), isPrice = spec.field === "ClosingIndex";
  if (!latest || signal.series.length > 31 || signal.series.some(p => p.value <= 0) ||
      new Set(signal.series.map(p => p.date.slice(0, 7))).size !== 1 || signal.source.observedAt !== latest.date ||
      !signal.source.attribution.includes(`${latest.date.slice(0, 4)} ${spec.title}`)) throw new Error("Invalid TWSE observations");
  const labels = ["Index level", ...(isPrice ? ["Open", "High", "Low"] : []), ...(signal.series.length > 1 ? ["Observed-session change"] : [])];
  if (signal.metrics.map(m => m.label).join() !== labels.join() || signal.metrics.some(m => m.date !== latest.date || m.unit !== (m.label === "Observed-session change" ? "%" : UNIT)) ||
      signal.metrics[0].value !== latest.value) throw new Error("Invalid TWSE index metrics");
  if (isPrice) {
    const [, open, high, low] = signal.metrics.map(m => m.value);
    if (low <= 0 || low > Math.min(open, latest.value) || high < Math.max(open, latest.value)) throw new Error("Invalid TWSE saved OHLC");
  }
  if (signal.series.length > 1 && Math.abs(signal.metrics.at(-1)!.value - (latest.value / signal.series.at(-2)!.value - 1) * 100) > 1e-12)
    throw new Error("Invalid TWSE session change");
}

export async function refreshTaiwan(previous: Snapshot, read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Snapshot> {
  const collected = await collectTaiwan(read, now), issuedAt = now();
  const ids = new Set(collected.map(s => s.id));
  const gap = missingSignals(issuedAt).find(s => s.id === "global-equities")!;
  const signals = previous.signals.filter(s => !ids.has(s.id)).map(s => s.id === gap.id ? { ...s, title: gap.title, shortLabel: gap.shortLabel, reason: gap.summary, summary: gap.summary, limitation: gap.limitation } : s);
  // Keep the same order as full collection, including the existing scoped Fed tail.
  const anchor = signals.findIndex(s => s.id === "fed-private-credit-loans");
  signals.splice(anchor < 0 ? signals.length : anchor, 0, ...collected);
  return { ...previous, id: issuedAt.replace(/[:.]/g, "-"), issuedAt, cutoff: issuedAt, consensus: undefined, forecasts: undefined,
    signals, sourcesAttempted: TWSE_SERIES.length,
    collectionErrors: [...previous.collectionErrors.filter(s => !collected.some(c => s.startsWith(`${c.id}:`))), ...collected.filter(s => s.status === "unavailable").map(s => `${s.id}: ${s.summary}`)],
  };
}
