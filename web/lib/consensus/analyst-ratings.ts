import { createHash } from "node:crypto";
import type { PublicDocument } from "./calendars.ts";
import type { Signal, Snapshot } from "./types.ts";
import { sourceFailureKind } from "./source-failure.ts";

export const ANALYST_ID = "quantisnow-monthly-ratings";
export const ANALYST_URL = "https://www.quantisnow.com/data/analyst-ratings.json";
export const ANALYST_PAGE = "https://www.quantisnow.com/data/analyst-ratings";
export const ANALYST_LICENSE = "https://creativecommons.org/licenses/by/4.0/";
const attribution = `Quantisnow · Quantisnow Analyst Sentiment Index · ${ANALYST_PAGE}. CC BY 4.0. Counts selected and ratios recomputed by The Daily Consensus; no endorsement implied.`;
type Counts = { upgrades: number; downgrades: number; initiations: number; reiterations: number; total: number; ratio: number };
type Month = { month: string; monthToDate: boolean; values: Counts; breakdown: { label: string; values: Pick<Counts, "upgrades" | "downgrades" | "total" | "ratio"> }[] };
function fail(): never { throw new Error("Invalid analyst aggregate document"); }
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : fail();
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 10_000_000;
const instant = (x: string) => Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const endOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5)), 0)).toISOString().slice(0,10);

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
    for (const key of ["upgrades", "downgrades", "initiations", "reiterations", "total"]) if (!count(v[key])) fail();
    const values = v as unknown as Counts;
    if (values.total !== values.upgrades + values.downgrades + values.initiations + values.reiterations ||
        typeof values.ratio !== "number" || !Number.isFinite(values.ratio) || Math.abs(values.ratio - (values.downgrades ? values.upgrades / values.downgrades : 0)) > 1e-12) fail();
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

export async function collectAnalystRatings(read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Signal> {
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
    if (!instant(doc.retrievedAt) || doc.retrievedAt > now() || createHash("sha256").update(doc.text).digest("hex") !== doc.sha256) fail();
    const { updatedAt, months } = parseAnalystRatings(doc.text, doc.retrievedAt);
    const closed = months.filter(m => !m.monthToDate), latest = closed.at(-1)!, partial = months.find(m => m.monthToDate);
    const metrics = closed.slice(-2).flatMap(m => (["upgrades", "downgrades", "initiations", "reiterations", "total"] as const).map(key => ({ label: `${m.month} full month · ${key}`, value: m.values[key], unit: "rating actions", date: endOfMonth(m.month) })));
    if (partial) for (const key of ["upgrades", "downgrades", "initiations", "reiterations", "total"] as const) metrics.push({ label: `${partial.month} month to date · ${key}`, value: partial.values[key], unit: "rating actions", date: updatedAt.slice(0,10) });
    return { ...base, status: "available", metrics,
      series: closed.filter(m => m.values.upgrades + m.values.downgrades > 0).map(m => ({ date: endOfMonth(m.month), value: m.values.upgrades / (m.values.upgrades + m.values.downgrades) * 100 })),
      summary: `${latest.month} full month: ${latest.values.upgrades} upgrades and ${latest.values.downgrades} downgrades. ${partial ? `${partial.month} month to date: ${partial.values.upgrades} upgrades and ${partial.values.downgrades} downgrades, through provider update ${updatedAt}.` : "No current partial month supplied."} Selected US stocks; no directional vote.`,
      source: { ...base.source, retrievedAt: doc.retrievedAt, observedAt: updatedAt, releasedAt: updatedAt, sha256: doc.sha256 },
    };
  } catch (error) { return { ...base, failureKind: sourceFailureKind(error) }; }
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

export async function refreshAnalystRatings(previous: Snapshot, read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Snapshot> {
  const signal = await collectAnalystRatings(read, now), issuedAt = now();
  const signals = previous.signals.filter(s => s.id !== ANALYST_ID);
  const anchor = signals.findIndex(s => s.id.startsWith("twse-") || s.id === "fed-private-credit-loans");
  signals.splice(anchor < 0 ? signals.length : anchor, 0, signal);
  return { ...previous, id: issuedAt.replace(/[:.]/g, "-"), issuedAt, cutoff: issuedAt, consensus: undefined, forecasts: undefined,
    signals, sourcesAttempted: 1,
    collectionErrors: [...previous.collectionErrors.filter(e => !e.startsWith(`${ANALYST_ID}:`)), ...(signal.status === "unavailable" ? [`${ANALYST_ID}: ${signal.summary}`] : [])],
  };
}
