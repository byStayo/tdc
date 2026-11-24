import { createHash } from "node:crypto";
import type { PublicDocument } from "./calendars.ts";
import type { Signal, Snapshot } from "./types.ts";
import { SourceChallengeError, sourceFailureKind } from "./source-failure.ts";

export const ANALYST_ID = "quantisnow-monthly-ratings";
export const ANALYST_URL = "https://www.quantisnow.com/data/analyst-ratings.json";
export const ANALYST_PAGE = "https://www.quantisnow.com/data/analyst-ratings";
const ANALYST_CSV = ANALYST_PAGE + ".csv";
export const ANALYST_LICENSE = "https://creativecommons.org/licenses/by/4.0/";
const attribution = `Quantisnow · Quantisnow Analyst Sentiment Index · ${ANALYST_PAGE}. CC BY 4.0. Counts selected and ratios recomputed by The Daily Consensus; no endorsement implied.`;
type Counts = { upgrades: number; downgrades: number; initiations: number; reiterations: number; total: number; ratio: number };
type Month = { month: string; monthToDate: boolean; values: Counts; breakdown: { label: string; values: Pick<Counts, "upgrades" | "downgrades" | "total" | "ratio"> }[] };
type Reading = Pick<Month, "month" | "monthToDate" | "values">;
function fail(): never { throw new Error("Invalid analyst aggregate document"); }
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : fail();
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 10_000_000;
const instant = (x: string) => Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const endOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5)), 0)).toISOString().slice(0,10);
const actions = ["upgrades", "downgrades", "initiations", "reiterations", "total"] as const;
const validCounts = (v: Counts) => actions.every(key => count(v[key])) &&
  v.total === v.upgrades + v.downgrades + v.initiations + v.reiterations &&
  Number.isFinite(v.ratio) && Math.abs(v.ratio - (v.downgrades ? v.upgrades / v.downgrades : 0)) <= 1e-12;

function verifyDocument(doc: PublicDocument, cutoff: string) {
  if (!instant(doc.retrievedAt) || doc.retrievedAt > cutoff || createHash("sha256").update(doc.text).digest("hex") !== doc.sha256) fail();
}

function analystMeasures(months: Reading[], updatedAt: string) {
  const closed = months.filter(m => !m.monthToDate), latest = closed.at(-1), partial = months.find(m => m.monthToDate);
  if (!latest) fail();
  const metrics = closed.slice(-2).flatMap(m => actions.map(key => ({ label: `${m.month} full month · ${key}`, value: m.values[key], unit: "rating actions", date: endOfMonth(m.month) })));
  if (partial) for (const key of actions) metrics.push({ label: `${partial.month} month to date · ${key}`, value: partial.values[key], unit: "rating actions", date: updatedAt.slice(0,10) });
  const series = closed.filter(m => m.values.upgrades + m.values.downgrades > 0).map(m =>
    ({ date: endOfMonth(m.month), value: m.values.upgrades / (m.values.upgrades + m.values.downgrades) * 100 }));
  return { latest, partial, metrics, series };
}

/** CSV contains month totals. It can corroborate the published chart and counts, but carries no provider vintage or sector detail. */
function csvConfirms(doc: PublicDocument, previous: Signal, cutoff: string) {
  verifyDocument(doc, cutoff);
  validateAnalystRatings(previous);
  const vintage = previous.source.observedAt;
  if (!vintage || !instant(vintage) || !instant(previous.source.retrievedAt) || previous.source.retrievedAt > doc.retrievedAt ||
      !/^[a-f0-9]{64}$/.test(previous.source.sha256 ?? "") || doc.text.length > 100_000) fail();
  const [header, ...lines] = doc.text.trimEnd().split(/\r?\n/);
  if (header !== "month,month_to_date,upgrades,downgrades,ratio,initiations,reiterations,total" ||
      !lines.length || lines.length > 240) fail();
  let prevMonth = "";
  const months = lines.map(line => {
    const fields = line.split(",");
    const [month, partial, up, down, ratio, initiated, repeated, total] = fields;
    if (fields.length !== 8 || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || month <= prevMonth || month > vintage.slice(0,7) ||
        partial !== String(month === vintage.slice(0,7)) || ![up,down,initiated,repeated,total].every(s => /^(?:0|[1-9]\d*)$/.test(s)) ||
        !/^\d+(?:\.\d+)?$/.test(ratio)) fail();
    prevMonth = month;
    const values = { upgrades: Number(up), downgrades: Number(down), initiations: Number(initiated),
      reiterations: Number(repeated), total: Number(total), ratio: Number(ratio) };
    if (!validCounts(values)) fail();
    return { month, monthToDate: partial === "true", values };
  });
  const { metrics, series } = analystMeasures(months, vintage);
  return metrics.length === previous.metrics.length && series.length === previous.series.length &&
    metrics.every((m,i) => m.label === previous.metrics[i].label && m.date === previous.metrics[i].date &&
      m.value === previous.metrics[i].value && m.unit === previous.metrics[i].unit) &&
    series.every((p,i) => p.date === previous.series[i].date && p.value === previous.series[i].value);
}

async function originalAnalystObservation(previous: Snapshot, cutoff: string, archiveRoot?: string) {
  const prior = previous.signals.find(s => s.id === ANALYST_ID);
  if (prior?.status === "available") return prior;
  if (!archiveRoot || previous.issuedAt > cutoff) return;
  const { digest, verifyPublicationTree } = await import("./history.ts");
  const { current, snapshots } = await verifyPublicationTree(archiveRoot);
  if (current.id !== previous.id || digest(current) !== digest(previous)) return;
  // Check the newest accepted state only. Never search older vintages for numbers that happen to match the CSV.
  const earlier = snapshots.slice(0, -1).reverse().map(edition => edition.signals.find(s => s.id === ANALYST_ID));
  const latest = earlier.find(s => s?.status === "available");
  if (!latest?.source.observedAt || Date.parse(cutoff) - Date.parse(latest.source.observedAt) > latest.staleAfterDays * 86_400_000) return;
  return earlier.find(s => s?.status === "available" && !s.collectionNote && s.source.sha256 === latest.source.sha256 &&
    s.source.retrievedAt === latest.source.retrievedAt && s.source.observedAt === latest.source.observedAt);
}

/** The licence covers these monthly datasets, not Quantisnow's personal-use news feeds. */
export function parseAnalystRatings(text: string, cutoff: string) {
  if (text.length > 2_000_000 || !instant(cutoff)) fail();
  const raw = obj(JSON.parse(text));
  if (raw.name !== "Quantisnow Analyst Sentiment Index" || raw.creator !== "Quantisnow" || raw.url !== ANALYST_PAGE || raw.license !== ANALYST_LICENSE ||
      typeof raw.updatedAt !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw.updatedAt)) fail();
  // Provider documentation explicitly defines the update clock as UTC.
  const updatedAt = raw.updatedAt.replace(" ", "T") + ".000Z";
  if (!instant(updatedAt) || updatedAt > cutoff || !Array.isArray(raw.months) || !raw.months.length || raw.months.length > 240) fail();
  const months = raw.months.map((input): Month => {
    const row = obj(input), v = obj(row.values);
    if (typeof row.month !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.month) || row.month > updatedAt.slice(0,7) ||
        row.monthToDate !== (row.month === updatedAt.slice(0,7)) || !Array.isArray(row.breakdown) || !row.breakdown.length || row.breakdown.length > 100) fail();
    const values = v as unknown as Counts;
    if (!validCounts(values)) fail();
    const labels = new Set<string>();
    const breakdown = row.breakdown.map(input => {
      const sector = obj(input), counts = obj(sector.values);
      if (typeof sector.label !== "string" || !sector.label.trim() || sector.label.length > 100 || labels.has(sector.label)) fail();
      labels.add(sector.label);
      for (const key of ["upgrades", "downgrades", "total"]) if (!count(counts[key])) fail();
      const c = counts as unknown as Month["breakdown"][number]["values"];
      if (c.upgrades + c.downgrades > c.total || typeof c.ratio !== "number" || !Number.isFinite(c.ratio) || Math.abs(c.ratio - (c.downgrades ? c.upgrades / c.downgrades : 0)) > 1e-12) fail();
      return { label: sector.label, values: c };
    });
    for (const key of ["upgrades", "downgrades", "total"] as const) if (breakdown.reduce((n, s) => n + s.values[key], 0) !== values[key]) fail();
    return { month: row.month, monthToDate: row.monthToDate as boolean, values, breakdown };
  }).sort((a,b) => a.month.localeCompare(b.month));
  if (new Set(months.map(m => m.month)).size !== months.length || !months.some(m => !m.monthToDate)) fail();
  const expectedClosed = new Date(Date.UTC(Number(updatedAt.slice(0,4)), Number(updatedAt.slice(5,7)) - 1, 0)).toISOString().slice(0,7);
  if (months.filter(m => !m.monthToDate).at(-1)!.month !== expectedClosed) fail();
  return { updatedAt, months };
}

export async function collectAnalystRatings(read: (url: string) => Promise<PublicDocument>,
  now = () => new Date().toISOString(), previous?: Snapshot, archiveRoot?: string): Promise<Signal> {
  const base: Signal = {
    id: ANALYST_ID, family: "analysts", title: "US analyst rating actions · monthly sample", shortLabel: "Monthly analyst rating actions",
    instruments: ["MARKET"], directionalInstruments: [], status: "unavailable", summary: "No verified monthly analyst aggregate returned.",
    source: { name: "Quantisnow · monthly analyst ratings", url: ANALYST_URL, retrievedAt: now(), observedAt: null, releasedAt: null,
      frequency: "monthly counts; current month to date", attribution, usage: `Monthly dataset reuse under CC BY 4.0: ${ANALYST_LICENSE}. Attribution, source link and changes disclosed.`, sha256: null },
    methodology: "Counts of rating actions received by Quantisnow, grouped by UTC calendar month. Closed-month chart shows upgrades as a percentage of upgrades plus downgrades. Initiations and reiterations are separate counts. Current month-to-date counts are separate; no partial/full-month change or directional vote. Provider update time is not the original time of any rating action.",
    limitation: "Selected US-listed stocks captured by one provider, not index holdings or per-company earnings estimates. MARKET context only; no ETF-specific inference, target-price forecast, earnings surprise or validated sentiment/return probability. Historical aggregates can be revised. Month-to-date counts are incomplete and cannot be compared directly with a full month.",
    series: [], metrics: [], scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 7, unit: "% of upgrade/downgrade actions",
  };
  try {
    const doc = await read(ANALYST_URL);
    verifyDocument(doc, now());
    const { updatedAt, months } = parseAnalystRatings(doc.text, doc.retrievedAt);
    const { latest, partial, metrics, series } = analystMeasures(months, updatedAt);
    return { ...base, status: "available", metrics, series,
      summary: `${latest.month} full month: ${latest.values.upgrades} upgrades and ${latest.values.downgrades} downgrades. ${partial ? `${partial.month} month to date: ${partial.values.upgrades} upgrades and ${partial.values.downgrades} downgrades, through provider update ${updatedAt}.` : "No current partial month supplied."} Selected US stocks; no directional vote.`,
      source: { ...base.source, retrievedAt: doc.retrievedAt, observedAt: updatedAt, releasedAt: updatedAt, sha256: doc.sha256 },
    };
  } catch (error) {
    if (error instanceof SourceChallengeError && previous) {
      try {
        const original = await originalAnalystObservation(previous, now(), archiveRoot);
        if (original && csvConfirms(await read(ANALYST_CSV), original, now()))
          return { ...original, collectionNote: "Quantisnow’s CSV confirms every published chart point and count. The original verified JSON dates apply." };
      } catch { /* A missing or inconsistent alternate leaves the observation unavailable. */ }
    }
    return { ...base, failureKind: sourceFailureKind(error) };
  }
}

export function validateAnalystRatings(s: Signal): void {
  if (s.id !== ANALYST_ID) return;
  if (s.family !== "analysts" || s.instruments.join() !== "MARKET" || !s.directionalInstruments || s.directionalInstruments.length ||
      Object.values(s.scores).some(v => v !== null) || s.source.url !== ANALYST_URL || s.source.attribution !== attribution ||
      !s.source.usage.includes(ANALYST_LICENSE) || s.source.frequency !== "monthly counts; current month to date" || s.staleAfterDays !== 7 || s.unit !== "% of upgrade/downgrade actions") throw new Error("Invalid analyst scope, licence or voting contract");
  if (s.status === "unavailable") {
    if (s.series.length || s.metrics.length || s.source.observedAt || s.source.releasedAt || s.source.sha256) throw new Error("Unavailable analyst input contains observations");
    return;
  }
  if (!s.source.observedAt || s.source.observedAt !== s.source.releasedAt || s.source.observedAt > s.source.retrievedAt ||
      !s.series.length || s.series.some(p => p.value < 0 || p.value > 100 || p.date !== endOfMonth(p.date.slice(0,7)) || p.date.slice(0,7) >= s.source.observedAt!.slice(0,7)) ||
      s.metrics.some(m => !count(m.value) || m.unit !== "rating actions" || !/^\d{4}-\d\d (?:full month|month to date) · (?:upgrades|downgrades|initiations|reiterations|total)$/.test(m.label))) throw new Error("Invalid saved analyst observations");
  const groups = new Map<string, Map<string, number>>();
  for (const metric of s.metrics) {
    const [period, key] = metric.label.split(" · "), month = period.slice(0,7), partial = period.endsWith("month to date");
    if (month > s.source.observedAt.slice(0,7) || partial !== (month === s.source.observedAt.slice(0,7)) ||
        metric.date !== (partial ? s.source.observedAt.slice(0,10) : endOfMonth(month))) throw new Error("Invalid analyst period date");
    const values = groups.get(period) ?? new Map<string, number>();
    if (values.has(key)) throw new Error("Duplicate analyst metric");
    values.set(key, metric.value); groups.set(period, values);
  }
  const closed = [...groups].filter(([period]) => period.endsWith("full month"));
  if (!closed.length || closed.length > 2 || groups.size > 3) throw new Error("Invalid analyst metric groups");
  for (const [period, values] of groups) {
    if (values.size !== 5 || values.get("total") !== ["upgrades", "downgrades", "initiations", "reiterations"].reduce((n,k) => n + (values.get(k) ?? NaN), 0)) throw new Error("Invalid analyst count reconciliation");
    if (period.endsWith("full month")) {
      const upgrades = values.get("upgrades")!, downgrades = values.get("downgrades")!;
      const point = s.series.find(p => p.date === endOfMonth(period.slice(0,7)));
      if (upgrades + downgrades && (!point || Math.abs(point.value - upgrades / (upgrades + downgrades) * 100) > 1e-12)) throw new Error("Invalid analyst chart arithmetic");
    }
  }
}

export async function refreshAnalystRatings(previous: Snapshot, read: (url: string) => Promise<PublicDocument>,
  now = () => new Date().toISOString(), archiveRoot?: string): Promise<Snapshot> {
  const signal = await collectAnalystRatings(read, now, previous, archiveRoot), issuedAt = now();
  const signals = previous.signals.filter(s => s.id !== ANALYST_ID);
  const anchor = signals.findIndex(s => s.id.startsWith("twse-") || s.id === "fed-private-credit-loans");
  signals.splice(anchor < 0 ? signals.length : anchor, 0, signal);
  return { ...previous, id: issuedAt.replace(/[:.]/g, "-"), issuedAt, cutoff: issuedAt, consensus: undefined, forecasts: undefined,
    signals, sourcesAttempted: 1,
    collectionErrors: [...previous.collectionErrors.filter(e => !e.startsWith(`${ANALYST_ID}:`)), ...(signal.status === "unavailable" ? [`${ANALYST_ID}: ${signal.summary}`] : [])],
  };
}
