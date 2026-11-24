import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INSTRUMENTS, type Snapshot } from "../lib/consensus/types.ts";
import { asIssuedOutcomeCall } from "../lib/consensus/evaluation.ts";
import { permitsModelInputs } from "../lib/consensus/model.ts";
import type { PerformanceReport } from "../lib/consensus/performance-types.ts";
import { assertEvaluationReleaseState } from "../lib/consensus/evaluation-transaction.ts";
import { auditOutcomeCoverage, recentDailySettlements } from "../lib/consensus/outcome-coverage-audit.ts";
import { PUBLIC_OUTCOME_INDEX, validateOutcomeIndex } from "../lib/consensus/outcome-ledger.ts";
import { QUARTERLY_PRICE_FILE, validateQuarterlyPriceCheck } from "../lib/consensus/quarterly-price-check.ts";
import { publisherSecondaryStudies } from "../lib/consensus/secondary-studies.ts";
import { INSTRUMENT_REPORTS } from "../lib/instrument-reports.ts";
import { getPublishedBrief } from "../lib/published-brief.ts";
import { getPublishedInstrumentBrief } from "../lib/published-instrument-reports.ts";

/** The latest operating results have their own clock and must never appear inside an as-issued report. */
export async function connectionProductStatus(root: string, current: Snapshot, snapshots: Snapshot[]) {
  await assertEvaluationReleaseState(root);
  const json = async (file: string) => JSON.parse(await readFile(join(root, file), "utf8"));
  const [outcomes, report, registry, research, price] = await Promise.all([
    json(PUBLIC_OUTCOME_INDEX), json("lib/consensus/performance.json") as Promise<PerformanceReport>,
    json("lib/consensus/models.json"), json("public/consensus/kibot-research.json"), json("public" + QUARTERLY_PRICE_FILE),
  ]);
  validateOutcomeIndex(outcomes);
  validateQuarterlyPriceCheck(price);
  const cutoff = { asOf: report.generatedAt, ledgerObservedAt: report.generatedAt };
  const coverage = auditOutcomeCoverage(snapshots, outcomes, report.pending, report.engineVersion, cutoff);
  const editions = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const dailySessions = recentDailySettlements(snapshots, outcomes, report.generatedAt).map(row => {
    const issued = editions.get(row.edition)!;
    return { session: row.session, edition: row.edition, funds: INSTRUMENTS.filter(symbol => symbol !== "MARKET").map(symbol => ({
      symbol, settled: row.settled.includes(symbol), call: asIssuedOutcomeCall(issued, symbol, "daily").call,
      eligibleInputs: issued.engineVersion === report.engineVersion && permitsModelInputs(issued, symbol, "daily"),
    })) };
  });
  const forwardFamilies = [...new Set(publisherSecondaryStudies.map(({ name }) => name === "fund-flows" ? "capital" : name))];
  const evaluated = Date.parse(report.generatedAt);
  const briefs = [getPublishedBrief(evaluated), ...INSTRUMENT_REPORTS.map(({symbol}) => getPublishedInstrumentBrief(symbol, evaluated))];
  return {
    asOf: report.generatedAt, editions: snapshots.length, measurements: current.signals.reduce((n, s) => n + s.metrics.length, 0),
    targets: coverage.expectedTargets, settledRecords: outcomes.length, selected: report.resolved,
    calls: report.calls, abstentions: report.abstentions, due: coverage.pendingByStatus.priceEvidenceDue,
    future: coverage.pendingByStatus.awaitingHorizon, calendarMissing: coverage.pendingByStatus.calendarCoverageMissing,
    unaccounted: coverage.unaccountedTargets, completeDailyCohorts: coverage.eligibleFiveEtfDaily.completedSessions, dailySessions,
    priceDueByInstrument: coverage.priceDueByInstrument, historicalStudies: research.studies.length as number,
    activeModels: registry.models.length as number, candidates: report.learning.length, forwardFamilies, price,
    editorial: { checked: briefs.length, current: briefs.filter(b => b.status === "ok").length,
      citedSources: new Set(briefs.flatMap(b => (b.sources ?? []).map(s => s.url))).size },
  };
}
