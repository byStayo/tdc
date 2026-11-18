import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { evaluateOutcome, outcomeKey, outcomeWindowSessions, selectScoredOutcomes, type PriceEvidence, type SessionPrice } from "./evaluation.ts";
import { EXCHANGE_CALENDAR, exchangeSessions } from "./exchange-calendar.ts";
import { ETF_SYMBOLS, marketParquetEvidence, reconcileMarketParquet, reviewedMarketParquetDays, type MarketParquetDay, type ReferenceBars } from "./marketparquet.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { newYorkDate } from "./time.ts";
import { HORIZONS, type Outcome, type Snapshot } from "./types.ts";

type ETF = typeof ETF_SYMBOLS[number];
type IssuerCash = Record<ETF, CashDistribution[]>;
const MATCH_TOLERANCE = { openBps: 3, closeBps: 15 };
const ADJUSTMENT_TOLERANCE_BPS = 0.5;
const isFullSession = (row: SessionPrice) => Date.parse(row.closeAt) - Date.parse(row.openAt) === 6.5 * 3600000;

export function kibotIssuerCollectionStart(cash: IssuerCash, through: string): string {
  const latest = ETF_SYMBOLS.map(symbol => {
    const dates = cash[symbol].map(action => action.session).filter(date => date <= through).sort();
    const last = dates.at(-1);
    if (!last) throw new Error("A latest issuer distribution is required for each ETF");
    return last;
  });
  const prior = exchangeSessions(EXCHANGE_CALENDAR.from, latest.sort()[0]).at(-2);
  if (!prior) throw new Error("Previous issuer session outside the reviewed calendar");
  return prior;
}

function findSeries(prices: PriceEvidence[], symbol: ETF, adjustment: string): PriceEvidence {
  const found = prices.filter(series => series.instrument === symbol && series.adjustment === adjustment);
  if (found.length !== 1) throw new Error("Missing or duplicate Kibot price basis");
  return found[0];
}

function issuerCorrected(series: PriceEvidence, cash: CashDistribution[]): SessionPrice[] {
  const actions = cash.filter(action => action.session >= series.expectedSessions[0] &&
    action.session <= series.expectedSessions.at(-1)!);
  return adjustETFPrices(series.sessions, actions, []);
}

export function reviewIssuerBoundaries(raw: PriceEvidence[], advertised: PriceEvidence[], cash: IssuerCash) {
  return ETF_SYMBOLS.flatMap(symbol => {
    const rawSeries = findSeries(raw, symbol, "unadjusted");
    const advertisedSeries = findSeries(advertised, symbol, OUTCOME_PRICE_BASIS);
    const corrected = issuerCorrected(rawSeries, cash[symbol]);
    const adjusted = new Map(advertisedSeries.sessions.map(row => [row.session, row]));
    return cash[symbol].flatMap(action => {
      const index = rawSeries.sessions.findIndex(row => row.session === action.session);
      if (index < 1) return [];
      const prior = rawSeries.sessions[index - 1], exDate = rawSeries.sessions[index];
      if (!isFullSession(prior) || !isFullSession(exDate)) return [];
      const adjustedPrior = adjusted.get(prior.session), adjustedEx = adjusted.get(exDate.session);
      if (!adjustedPrior || !adjustedEx) throw new Error("Kibot price bases have different issuer sessions");
      // Normalize each raw-to-adjusted ratio by its ex-date ratio so later cash
      // actions that rescale both endpoints cancel.
      const expectedFactor = (corrected[index - 1].close / prior.close) / (corrected[index].close / exDate.close);
      const openFactor = (adjustedPrior.open / prior.open) / (adjustedEx.open / exDate.open);
      const closeFactor = (adjustedPrior.close / prior.close) / (adjustedEx.close / exDate.close);
      const openErrorBps = (openFactor - expectedFactor) * 10000, closeErrorBps = (closeFactor - expectedFactor) * 10000;
      const toleranceBps = Math.min(ADJUSTMENT_TOLERANCE_BPS, (1 - expectedFactor) * 10000 / 4);
      const matches = (factor: number) => [openFactor, closeFactor].every(
        observed => Math.abs(observed - factor) * 10000 <= toleranceBps,
      );
      return [{ symbol, exDate: action.session, priorSession: prior.session, issuerAmount: action.amount,
        expectedFactor, toleranceBps,
        observed: { openFactor, closeFactor, openErrorBps, closeErrorBps,
          impliedOpenAmount: prior.close * (1 - openFactor), impliedCloseAmount: prior.close * (1 - closeFactor) },
        status: matches(expectedFactor) ? "matches-issuer" as const : matches(1) ? "missing" as const : "different" as const }];
    });
  });
}

type SampleCapture = "same-run" | "cached";
type WindowCapture = SampleCapture | "mixed";
type OutcomePair = { sample: Outcome; reference: Outcome; capture: WindowCapture };

function summarize(pairs: OutcomePair[]) {
  const errors = pairs.map(({ sample, reference }) => Math.abs(sample.returnPct - reference.returnPct) * 100);
  return { selected: pairs.length,
    labelDisagreements: pairs.filter(({ sample, reference }) => (sample.returnPct > 0) !== (reference.returnPct > 0)).length,
    meanAbsReturnErrorBps: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null,
    maxAbsReturnErrorBps: errors.length ? Math.max(...errors) : null };
}

export function scorePriceSensitivity({ snapshots, files, cash, raw, sameRunSessions, now }: {
  snapshots: Snapshot[]; files: MarketParquetDay[]; cash: IssuerCash; raw: PriceEvidence[];
  sameRunSessions: string[]; now: string;
}) {
  const first = snapshots[0], lastFile = files.at(-1);
  if (!first || !lastFile) throw new Error("Sensitivity requires an archive and sample sessions");
  const expectedSessions = exchangeSessions(newYorkDate(first.issuedAt), lastFile.session);
  const fullFiles = reviewedMarketParquetDays(files, []);
  const reference = Object.fromEntries(ETF_SYMBOLS.map((symbol): [ETF, ReferenceBars[ETF]] =>
    [symbol, findSeries(raw, symbol, "unadjusted").sessions])) as ReferenceBars;
  // Retain missing days on the exchange calendar even though they cannot
  // supply a price. The reconciler reports differences against as-traded bars.
  const reconciliationCalendar = exchangeSessions(files[0].session, lastFile.session);
  const reconciliation = reconcileMarketParquet(reconciliationCalendar, fullFiles, cash, reference, MATCH_TOLERANCE);
  const matched = fullFiles.filter(file => expectedSessions.includes(file.session) &&
    reconciliation.symbols.every(series => series.matched.includes(file.session)));
  const matchedDays = new Set(matched.map(file => file.session));
  const fresh = new Set(sameRunSessions);
  const matchedSessions = matched.map(({ session, sha256 }) => ({
    session, sha256, capture: fresh.has(session) ? "same-run" as const : "cached" as const,
  }));
  const samplePrices = marketParquetEvidence(expectedSessions, matched, cash);
  const referencePrices = ETF_SYMBOLS.map(symbol => {
    const series = findSeries(raw, symbol, "unadjusted");
    return { ...series, adjustment: OUTCOME_PRICE_BASIS, expectedSessions,
      sessions: issuerCorrected(series, cash[symbol]).filter(row => matchedDays.has(row.session)) };
  });
  const unresolved = new Map(reconciliation.symbols.map(series => [series.symbol,
    new Set(series.boundaries.filter(boundary => boundary.status !== "verified").map(boundary => boundary.exDate))]));

  function score(prices: PriceEvidence[]) {
    const outcomes: Outcome[] = [];
    for (const snapshot of snapshots) for (const horizon of HORIZONS) {
      const window = outcomeWindowSessions(snapshot.issuedAt, horizon, expectedSessions);
      if (!window.length || window.some(day => !matchedDays.has(day))) continue;
      for (const series of prices) {
        const blocked = unresolved.get(series.instrument as ETF);
        if (window.slice(1).some(day => blocked?.has(day))) continue;
        const row = evaluateOutcome(snapshot, series, horizon, now);
        if (row) outcomes.push(row);
      }
    }
    return selectScoredOutcomes(outcomes);
  }

  const sample = score(samplePrices);
  const comparison = score(referencePrices);
  const byKey = new Map(comparison.selected.map(row => [outcomeKey(row), row]));
  if (byKey.size !== sample.selected.length) throw new Error("Sensitivity coverage differs between price sources");
  const pairs = sample.selected.map(sample => {
    const reference = byKey.get(outcomeKey(sample));
    if (!reference || reference.entryAt !== sample.entryAt || reference.exitAt !== sample.exitAt)
      throw new Error("Sensitivity selected unequal outcome windows");
    const days = outcomeWindowSessions(sample.issuedAt, sample.horizon, expectedSessions);
    const freshDays = days.filter(day => fresh.has(day)).length;
    const capture: WindowCapture = freshDays === days.length ? "same-run" : freshDays ? "mixed" : "cached";
    return { sample, reference, capture };
  });
  const cohorts = Object.fromEntries(HORIZONS.map(horizon => {
    const rows = pairs.filter(row => row.sample.horizon === horizon);
    return [horizon, { ...summarize(rows), byCapture: {
      "same-run": summarize(rows.filter(row => row.capture === "same-run")),
      cached: summarize(rows.filter(row => row.capture === "cached")),
      mixed: summarize(rows.filter(row => row.capture === "mixed")),
    } }];
  })) as Record<typeof HORIZONS[number], ReturnType<typeof summarize> &
    { byCapture: Record<WindowCapture, ReturnType<typeof summarize>> }>;
  return { expectedSessions, matchedSessions, scoringPolicy: sample.policy, cohorts,
    excludedEarlyCloses: files.length - fullFiles.length, reconciliation: {
      tolerance: MATCH_TOLERANCE, symbols: reconciliation.symbols.map(({ earlyClosesVerified: _earlyCloses, ...row }) => row),
    } };
}
