import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import type { CashDistribution } from "../lib/consensus/corporate-adjustment.ts";
import { evaluateOutcome, outcomeTrainingRow, outcomeWindowSessions, performance, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { exchangeSession, exchangeSessions, EXCHANGE_CALENDAR } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { evaluateCandidate, planCandidate } from "../lib/consensus/learning.ts";
import { assertCommittedReservations, MINIMUM_TEST_LABELS, PROSPECTIVE_MINIMUM, promotionEvidence, readReservations, reserveEvaluation, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { ETF_SYMBOLS, MARKETPARQUET_SOURCE, marketParquetEvidence, type MarketParquetDay } from "../lib/consensus/marketparquet.ts";
import { ENGINE_VERSION, FAMILIES } from "../lib/consensus/registry.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { HORIZONS } from "../lib/consensus/types.ts";

type Issuer = { symbol: typeof ETF_SYMBOLS[number]; source: string; sha256: string; cash: CashDistribution[] };
type UnavailableDay = { session: string; httpStatus: number };
type Capture = { sessions: (MarketParquetDay | UnavailableDay)[]; distributions: Issuer[] };
type Ledger = { schemaVersion: 1; bars: MarketParquetDay[]; distributions: Issuer[] };
type HoldoutSummary = { testLabels: number; candidateBrier: number; baseRateBrier: number; coinBrier: number; passed: boolean };

function readHoldoutSummary(value: HoldoutSummary): HoldoutSummary {
  const { testLabels, candidateBrier, baseRateBrier, coinBrier, passed } = value;
  if (!Number.isInteger(testLabels) || testLabels < MINIMUM_TEST_LABELS || typeof passed !== "boolean" ||
      ![candidateBrier, baseRateBrier, coinBrier].every(metric => Number.isFinite(metric) && metric >= 0 && metric <= 1))
    throw new Error("Invalid saved MarketParquet holdout summary");
  return { testLabels, candidateBrier, baseRateBrier, coinBrier, passed };
}
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_.some(arg => !["--publish", "--scheduled"].includes(arg)))
  throw new Error("Usage: evaluate-marketparquet.ts [--publish | --scheduled]");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-marketparquet");
let credential = process.env.MARKETPARQUET_ARCHIVE_LICENSE === "confirmed" ?
  process.env.MARKETPARQUET_API_KEY : undefined;
if (!credential && arguments_[0]) {
  const path = resolve(directory, "credentials.json");
  try {
    if ((await stat(path)).mode & 0o077) throw new Error("MarketParquet credentials must be private");
    const file = JSON.parse(await readFile(path, "utf8"));
    if (file.archiveLicense !== "confirmed" || typeof file.apiKey !== "string" || !/^bt_[A-Za-z0-9_-]+$/.test(file.apiKey))
      throw new Error("Invalid MarketParquet credentials");
    credential = file.apiKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
const licensed = !!credential;
if (arguments_[0] === "--publish" && !licensed)
  throw new Error("Public results require an activated MarketParquet archive license and licensed API key");
if (arguments_[0] === "--scheduled" && !licensed) {
  console.log("MarketParquet production collection is waiting for an activated archive license");
  process.exit(0);
}

const ledgerPath = resolve(directory, licensed ? "licensed.json" : "sample.json");
const release = await acquirePublicationLock(root, "marketparquet-evaluation");
let failure: { error: unknown } | undefined;
try {
  const now = new Date().toISOString();
  const { current, snapshots } = await verifyPublicationTree(root);
  const from = newYorkDate(snapshots[0].issuedAt);
  const yesterday = new Date(Date.parse(newYorkDate(now)) - 86400000).toISOString().slice(0, 10);
  const completed = exchangeSessions(from, yesterday);
  const calendar = exchangeSessions(from, EXCHANGE_CALENDAR.through);
  const through = completed.at(-1)!;
  let old: Ledger | undefined;
  try {
    old = JSON.parse(await readFile(ledgerPath, "utf8"));
    if (old?.schemaVersion !== 1 || !Array.isArray(old.bars) || !Array.isArray(old.distributions))
      throw new Error("Invalid private MarketParquet ledger");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const saved = new Map((old?.bars ?? []).map(file => [file.session, file]));
  // A full-session file is the contract until a short session has been reconciled.
  const short = completed.filter(session => Date.parse(exchangeSession(session)!.closeAt) -
    Date.parse(exchangeSession(session)!.openAt) < 6.5 * 3600000);
  // Reconcile every available day in the evaluated range together. Daily
  // labels can use cached days, since within-day scale cancels.
  const requests = completed.filter(day => !short.includes(day) &&
    (licensed || Date.parse(through) - Date.parse(day) <= 7 * 86400000));
  const { stdout } = await promisify(execFile)("uv", ["run", "--script", resolve(root, "scripts/collect-marketparquet.py"),
    licensed ? "licensed" : "sample", ...requests], {
    timeout: 120000, maxBuffer: 2_000_000,
    env: { ...process.env, MARKETPARQUET_API_KEY: credential },
  });
  const incoming = JSON.parse(stdout) as Capture;
  const issuerBySymbol = new Map(incoming.distributions.map(issuer => [issuer.symbol, issuer]));
  if (issuerBySymbol.size !== ETF_SYMBOLS.length || ETF_SYMBOLS.some(symbol => !issuerBySymbol.has(symbol)))
    throw new Error("All five issuer histories are required");
  for (const issuer of old?.distributions ?? []) {
    const updated = issuerBySymbol.get(issuer.symbol);
    if (!updated || issuer.cash.filter(event => event.session <= through).some(event =>
      !updated.cash.some(candidate => candidate.session === event.session && candidate.amount === event.amount)))
      throw new Error(`Issuer revised a previously recorded distribution for ${issuer.symbol}`);
  }
  const fetchedDays = new Set<string>();
  for (const file of incoming.sessions) {
    if (!("bars" in file)) continue;
    fetchedDays.add(file.session);
    const previous = saved.get(file.session);
    if (previous && ETF_SYMBOLS.some(symbol =>
      Math.abs(file.bars[symbol].close / previous.bars[symbol].close - 1) > 0.02))
      throw new Error("MarketParquet changed the cached price basis. Reconcile the complete series before evaluation.");
    saved.set(file.session, file);
  }
  const bars = [...saved.values()].sort((a, b) => a.session.localeCompare(b.session));
  if (!bars.length) throw new Error("MarketParquet returned no usable completed ETF sessions");
  const cash = Object.fromEntries(incoming.distributions.map(issuer => [issuer.symbol, issuer.cash])) as
    Parameters<typeof marketParquetEvidence>[2];
  const evidence = marketParquetEvidence(calendar, bars, cash);
  // The initial issuer reconciliation covers the first five captured days.
  // A dated operator review extends this for all five ETFs after confirming
  // issuer actions and that all cash amounts share the vendor's split basis.
  let multiSessionReviewedThrough = "2026-11-10";
  try {
    const review = JSON.parse(await readFile(resolve(directory, "actions-review.json"), "utf8"));
    if (typeof review.through !== "string" || !exchangeSession(review.through) ||
        review.through < multiSessionReviewedThrough || review.through > through ||
        review.splitBasisVerified !== true || review.issuerActionsVerified !== true)
      throw new Error("Invalid MarketParquet corporate-action review");
    multiSessionReviewedThrough = review.through;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const outcomes = snapshots.flatMap(snapshot => evidence.flatMap(prices => HORIZONS.flatMap(horizon => {
    if (horizon !== "daily") {
      const window = outcomeWindowSessions(snapshot.issuedAt, horizon, calendar);
      if (!window.length || window.at(-1)! > multiSessionReviewedThrough || window.some(day => !fetchedDays.has(day)))
        return [];
    }
    const row = evaluateOutcome(snapshot, prices, horizon, now);
    return row ? [row] : [];
  })));
  const { selected, policy } = selectScoredOutcomes(outcomes);
  const reservations = await readReservations(root);
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const { models } = JSON.parse(await readFile(resolve(root, "lib/consensus/models.json"), "utf8")) as { models: ActiveModel[] };
  const cohorts = [];
  let trainingPerformed = false;
  const publish = !!arguments_[0] && fetchedDays.has(through) && selected.length > 0 &&
    (old?.bars ?? []).every(file => fetchedDays.has(file.session));
  if (publish) await assertCommittedReservations(root);
  await durableDirectory(directory, 0o700);
  for (const instrument of ETF_SYMBOLS) for (const horizon of HORIZONS) {
    const rows = selected.filter(row => row.instrument === instrument && row.horizon === horizon &&
      row.engineVersion === ENGINE_VERSION);
    const prior = reservations.filter(row => row.instrument === instrument && row.horizon === horizon)
      .sort((a, b) => b.attempt - a.attempt)[0];
    const plan = planCandidate(rows.map(row => outcomeTrainingRow(row, byId.get(row.snapshotId)!)), now, {
      engineVersion: ENGINE_VERSION, consumedThrough: prior?.consumedThrough,
      minimumSamples: PROSPECTIVE_MINIMUM, minimumTestSamples: MINIMUM_TEST_LABELS, nonOverlappingTest: true,
    });
    const stats = performance(rows, 2, ENGINE_VERSION);
    let holdout: HoldoutSummary | null = null;
    const resultPath = resolve(directory, `validation-${instrument}-${horizon}.json`);
    if (licensed) {
      try {
        const savedResult = JSON.parse(await readFile(resultPath, "utf8"));
        if (savedResult.engineVersion === ENGINE_VERSION &&
          reservations.some(record => record.datasetHash === savedResult.datasetHash &&
            record.instrument === instrument && record.horizon === horizon))
          holdout = readHoldoutSummary(savedResult.summary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (publish && plan.status === "ready") {
      const incumbent = models.find(model => model.instrument === instrument && model.horizon === horizon);
      if (incumbent) await validateActiveModelTree(root, incumbent, reservations);
      const reservation = await reserveEvaluation(root, reservations, plan, instrument, horizon, now, incumbent);
      reservations.push(reservation);
      const candidate = evaluateCandidate(plan, incumbent?.model);
      if (candidate.status !== "evaluated") throw new Error("Ready MarketParquet candidate failed to evaluate");
      const gate = promotionEvidence(plan, candidate.model, reservation, incumbent?.model);
      holdout = {
        testLabels: candidate.split.test,
        candidateBrier: candidate.candidateBrier,
        baseRateBrier: candidate.baseRateBrier,
        coinBrier: candidate.coinBrier,
        passed: candidate.promoted && gate.passes,
      };
      await durableJSON(resultPath, { engineVersion: ENGINE_VERSION, datasetHash: plan.datasetHash,
        attempt: reservation.attempt, candidate, gate, summary: holdout });
      trainingPerformed = true;
    }
    cohorts.push({ instrument, horizon, resolved: rows.length, calls: stats.calls, abstentions: stats.abstentions,
      minimumSamples: plan.minimum, eligibility: plan.status, holdout });
  }
  const daily = selected.filter(row => row.horizon === "daily" && row.engineVersion === ENGINE_VERSION);
  const readings = daily.map(row => asIssuedConsensus(byId.get(row.snapshotId)!, row.instrument, "daily").families);
  const families = FAMILIES.map(({ id }) => ({
    family: id,
    pairedVotes: readings.filter(families => families.some(family => family.id === id && family.score !== null)).length,
    pairedObservations: readings.filter(families => families.some(family => family.id === id && family.available > 0)).length,
  }));
  const missingSessions = completed.filter(day => !saved.has(day));
  const report = { schemaVersion: 1, source: MARKETPARQUET_SOURCE, engineVersion: ENGINE_VERSION,
    edition: current.id, through: bars.at(-1)!.session, scoringPolicy: policy,
    minimumTestLabels: MINIMUM_TEST_LABELS,
    missingCompletedSessions: missingSessions.length, multiSessionReviewedThrough, cohorts, families };
  await durableJSON(ledgerPath, { schemaVersion: 1, bars, distributions: incoming.distributions } satisfies Ledger);
  await durableJSON(resolve(directory, licensed ? "licensed-evaluation.json" : "sample-evaluation.json"),
    { ...report, evaluatedAt: now, missingSessions, outcomes, trainingPerformed });
  if (publish) {
    const destination = resolve(root, "public/consensus/marketparquet-validation.json");
    let prior = "";
    try { prior = await readFile(destination, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior !== JSON.stringify(report, null, 2) + "\n")
      await durableJSON(destination, report);
  }

  console.log(JSON.stringify({ mode: licensed ? "licensed" : "sample", edition: report.edition,
    through: report.through, sessions: bars.length, resolved: outcomes.length, selected: selected.length,
    missingSessions, trainingPerformed, issuerDistributions: incoming.distributions.map(({ symbol, cash }) =>
      ({ symbol, verified: cash.filter(event => event.session <= through).length })), cohorts, families }, null, 2));
  if (arguments_[0] && !publish) {
    console.error("Public aggregate preserved. MarketParquet did not refresh the required completed sessions.");
    process.exitCode = 2;
  }
} catch (error) {
  failure = { error };
  // Keep the child environment and stdout, which contains price rows, out of logs.
  if (error instanceof Error && "cmd" in error && "stderr" in error)
    throw new Error(String(error.stderr).trim() || "MarketParquet collector failed");
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}
