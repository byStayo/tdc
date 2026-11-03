import type { PerformanceReport } from "./performance-types.ts";
import { INSTRUMENTS } from "./types.ts";
import type { Instrument, Horizon } from "./types.ts";

/** MARKET has no traded outcome. Its display summarizes only the selected horizon's instrument cohorts. */
export function performanceView(report: PerformanceReport, instrument: Instrument, horizon: Horizon) {
  const targets = instrument === "MARKET" ? INSTRUMENTS.filter((id) => id !== "MARKET") : [instrument];
  const cohorts = targets.map((id) => report.cohorts.find((row) => row.instrument === id && row.horizon === horizon));
  if (cohorts.some((row) => !row)) return { resolved: null, calls: null, accuracy: null };
  const rows = cohorts.map((row) => row!);
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  return {
    resolved: rows.reduce((sum, row) => sum + row.resolved, 0), calls,
    accuracy: calls && rows.every((row) => !row.calls || row.accuracy !== null)
      ? rows.reduce((sum, row) => sum + (row.accuracy ?? 0) * row.calls, 0) / calls : null,
  };
}
