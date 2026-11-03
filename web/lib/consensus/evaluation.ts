import type { Horizon, Instrument, Outcome, Snapshot } from "./types.ts";
import { asIssuedConsensus } from "./as-issued.ts";
import { newYorkDate } from "./time.ts";
import { publicDate } from "../public-normalization.ts";
import { INSTRUMENTS } from "./types.ts";
import { requireOutcomePriceBasis } from "./price-basis.ts";

const canonicalInstant = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sessionDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && publicDate(value) === value;

export const SESSION_HORIZONS: Record<Horizon, number> = {
  daily: 1,
  weekly: 5,
  monthly: 21,
};
export interface SessionPrice {
  session: string;
  openAt: string;
  closeAt: string;
  open: number;
  close: number;
}
export interface PriceEvidence {
  instrument: Instrument;
  source: string;
  adjustment: string;
  sessions: SessionPrice[];
  expectedSessions: string[];
}
export function evaluateOutcome(
  snapshot: Snapshot,
  prices: PriceEvidence,
  horizon: Horizon,
  now: string,
): Outcome | null {
  if (!prices.source || !prices.adjustment || !prices.expectedSessions.length)
    throw new Error("Price provenance and exchange calendar required");
  requireOutcomePriceBasis(prices.adjustment);
  if (
    !INSTRUMENTS.includes(prices.instrument) ||
    prices.instrument === "MARKET" ||
    !canonicalInstant(now) ||
    !canonicalInstant(snapshot.issuedAt)
  )
    throw new Error("Invalid outcome instrument or timestamp");
  const sourceURL = new URL(prices.source);
  if (
    sourceURL.protocol !== "https:" ||
    sourceURL.username ||
    sourceURL.password ||
    /(?:token|api[_-]?key|password|secret)=/i.test(sourceURL.search) ||
    !["unadjusted", "split-adjusted", "total-return-adjusted"].includes(
      prices.adjustment,
    )
  )
    throw new Error("Public price citation or adjustment basis invalid");
  const sessions = [...prices.sessions].sort((a, b) =>
    a.openAt.localeCompare(b.openAt),
  );
  if (new Set(sessions.map((row) => row.session)).size !== sessions.length)
    throw new Error("Duplicate price session");
  if (
    new Set(prices.expectedSessions).size !== prices.expectedSessions.length ||
    prices.expectedSessions.some(
      (day, i) =>
        !sessionDate(day) || (i > 0 && day <= prices.expectedSessions[i - 1]),
    )
  )
    throw new Error("Exchange calendar must be ordered and unique");
  for (const row of sessions) {
    if (
      ![row.open, row.close].every((n) => Number.isFinite(n) && n > 0) ||
      !canonicalInstant(row.openAt) ||
      !canonicalInstant(row.closeAt) ||
      row.openAt >= row.closeAt ||
      newYorkDate(row.openAt) !== row.session ||
      newYorkDate(row.closeAt) !== row.session ||
      !prices.expectedSessions.includes(row.session)
    )
      throw new Error("Invalid price session");
  }
  const local = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(snapshot.issuedAt))
      .map((part) => [part.type, part.value]),
  );
  const issueDay = `${local.year}-${local.month}-${local.day}`,
    beforeOpen = Number(local.hour) * 60 + Number(local.minute) < 570;
  if (prices.expectedSessions[0] > issueDay)
    throw new Error("Exchange calendar does not cover issue time");
  const startDate = prices.expectedSessions.find(
    (day) => day > issueDay || (day === issueDay && beforeOpen),
  );
  const start = sessions.find((row) => row.session === startDate);
  if (!start) return null;
  // The feed calendar determines expected dates; missing rows cannot silently shorten a horizon.
  const expectedIndex = prices.expectedSessions.indexOf(start.session),
    dates = prices.expectedSessions.slice(
      expectedIndex,
      expectedIndex + SESSION_HORIZONS[horizon],
    );
  if (dates.length !== SESSION_HORIZONS[horizon]) return null;
  const rows = dates.map((day) => sessions.find((row) => row.session === day));
  if (rows.some((row) => !row)) return null;
  const exit = rows.at(-1)!;
  if (!exit || exit.closeAt > now || start.openAt <= snapshot.issuedAt)
    return null;
  const consensus = asIssuedConsensus(
      snapshot,
      prices.instrument,
      horizon,
    ),
    returnPct = (exit.close / start.open - 1) * 100;
  const forecast = snapshot.forecasts?.find(
      (item) =>
        item.instrument === prices.instrument && item.horizon === horizon,
    ),
    score = forecast ? forecast.probabilityUp * 2 - 1 : consensus.score;
  const called = !consensus.abstain && score !== null && Math.abs(score) > 0.1;
  if (forecast && (forecast.priceAdjustment !== prices.adjustment || forecast.engineVersion !== snapshot.engineVersion))
      throw new Error("Forecast and outcome price basis or engine version differ");
  return {
    engineVersion: snapshot.engineVersion,
    snapshotId: snapshot.id,
    instrument: prices.instrument,
    horizon,
    issuedAt: snapshot.issuedAt,
    entryAt: start.openAt,
    exitAt: exit.closeAt,
    entry: start.open,
    exit: exit.close,
    predictedScore: score,
    predictedProbability: forecast?.probabilityUp ?? null,
    abstained: !called,
    returnPct,
    directionCorrect: called
      ? Math.sign(score!) === Math.sign(returnPct)
      : null,
    source: prices.source,
    adjustment: prices.adjustment,
  };
}
export const SCORING_POLICY = "last-edition-before-entry-open-v1";

/** Select by publication time only, before inspecting returns or whether a call was made. */
export function selectScoredOutcomes(outcomes: Outcome[]) {
  const keys = outcomes.map(
    (row) => `${row.snapshotId}:${row.instrument}:${row.horizon}`,
  );
  if (new Set(keys).size !== keys.length)
    throw new Error("Duplicate outcome would inflate performance");
  const winners = new Map<string, Outcome>();
  const group = (row: Outcome) => `${row.instrument}:${row.horizon}:${row.entryAt}`;
  for (const row of outcomes) {
    requireOutcomePriceBasis(row.adjustment);
    if (!/^consensus-rules-\d+\.\d+\.\d+$/.test(row.engineVersion ?? ""))
      throw new Error("Outcome requires its recorded engine version");
    if (!canonicalInstant(row.issuedAt) || !canonicalInstant(row.entryAt) ||
        !canonicalInstant(row.exitAt) || row.issuedAt >= row.entryAt || row.exitAt <= row.entryAt)
      throw new Error("Outcome must follow its publication and entry timestamps");
    const prior = winners.get(group(row));
    if (prior?.issuedAt === row.issuedAt)
      throw new Error("Ambiguous same-time editions for one outcome session");
    if (!prior || row.issuedAt > prior.issuedAt) winners.set(group(row), row);
  }
  return {
    policy: SCORING_POLICY,
    selected: [...winners.values()].sort((a, b) => a.entryAt.localeCompare(b.entryAt) ||
      a.instrument.localeCompare(b.instrument) || a.horizon.localeCompare(b.horizon)),
    superseded: outcomes.filter((row) => winners.get(group(row)) !== row).map((row) => ({
      snapshotId: row.snapshotId,
      instrument: row.instrument,
      horizon: row.horizon,
      entryAt: row.entryAt,
      selectedSnapshotId: winners.get(group(row))!.snapshotId,
    })),
  };
}

export function performance(outcomes: Outcome[], costBps = 2, engineVersion?: string) {
  const selection = selectScoredOutcomes(outcomes);
  if (!engineVersion && new Set(selection.selected.map(row => row.engineVersion)).size > 1)
    throw new Error("Performance must select one engine version");
  const selected = selection.selected.filter(row => !engineVersion || row.engineVersion === engineVersion);
  const superseded = selection.superseded;
  const called = selected.filter(
      (row) => !row.abstained && row.directionCorrect !== null,
    ),
    probabilities = selected.filter((row) => row.predictedProbability !== null);
  return {
    resolved: selected.length,
    superseded: superseded.length,
    scoringPolicy: SCORING_POLICY,
    calls: called.length,
    abstentions: selected.length - called.length,
    accuracy: called.length
      ? called.filter((row) => row.directionCorrect).length / called.length
      : null,
    meanSignedReturnPct: called.length
      ? called.reduce(
          (sum, row) =>
            sum +
            Math.sign(row.predictedScore!) * row.returnPct -
            costBps / 100,
          0,
        ) / called.length
      : null,
    meanBuyHoldReturnPct: called.length
      ? called.reduce((sum, row) => sum + row.returnPct - costBps / 100, 0) /
        called.length
      : null,
    brier: probabilities.length
      ? probabilities.reduce(
          (sum, row) =>
            sum +
            (row.predictedProbability! - (row.returnPct > 0 ? 1 : 0)) ** 2,
          0,
        ) / probabilities.length
      : null,
    costBps,
    note: "One scored edition per instrument, horizon and entry session: the last publication before the entry open. Earlier editions remain in the audit ledger. Overlapping horizons are not a portfolio equity curve. Missing outcomes and abstentions are excluded from accuracy, never counted as wins.",
  };
}
