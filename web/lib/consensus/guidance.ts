import type { ReviewedGuidance } from "./reviewed.ts";
import type { Instrument, Snapshot } from "./types.ts";
import { newYorkDate } from "./time.ts";
import { REVIEWED_ISSUERS } from "./issuer-context.ts";

/** Arithmetic bounds, not a probability distribution or an earnings forecast. */
export function guidanceBounds(item: ReviewedGuidance): { low: number; high: number } {
  const range = item.revenue;
  return range.kind === "range"
    ? { low: range.low, high: range.high }
    : {
        low: range.midpoint * (1 - range.tolerancePercent / 100),
        high: range.midpoint * (1 + range.tolerancePercent / 100),
      };
}

/** Saved management context only. It never adds a directional or coverage vote. */
export function guidanceRows(snapshot: Snapshot, instrument: Instrument, reference: string) {
  if (!["MARKET", "SPY", "QQQ", "DIA"].includes(instrument)) return [];
  const packet = snapshot.review;
  return (packet?.guidance ?? []).filter((item) =>
    (REVIEWED_ISSUERS[item.ticker].instruments as Instrument[]).includes(instrument),
  ).map((item) => {
    const source = packet!.sources.find((s) => s.id === item.sourceId)!;
    const report = packet!.earningsSchedule?.find(
      (s) => s.ticker === item.ticker && s.fiscalPeriod === item.fiscalPeriod,
    );
    const reported = snapshot.signals.find((s) => s.id === `earnings-${item.ticker}`);
    const laterResults = reported?.status === "available" &&
      reported.metrics.some((m) => m.label === "Quarter revenue") && reported.source.observedAt &&
      reported.source.observedAt.slice(0, 10) >= source.publishedAt.slice(0, 10);
    const scheduledDayReached = report && report.reportDate <= newYorkDate(reference);
    const ageDays = (Date.parse(reference) - Date.parse(source.publishedAt)) / 86400000;
    const reviewDue = laterResults
      ? "A later reported quarter is available. Recheck this earlier guidance."
      : scheduledDayReached
        ? "The scheduled results day has arrived. Recheck this earlier guidance."
        : ageDays > 120
          ? "This guidance is more than 120 days old and needs a new source review."
          : null;
    return { ...item, ...guidanceBounds(item), source, reviewDue };
  });
}
