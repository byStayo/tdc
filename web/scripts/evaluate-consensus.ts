import {
  readFile,
  lstat,
  mkdir,
  readdir,
} from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { commitEvaluationTransaction, recoverEvaluationTransaction, type EvaluationWrite } from "../lib/consensus/evaluation-transaction.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { assertCommittedReservations, prospectiveAttemptBudget } from "../lib/consensus/learning-audit.ts";
import { digest, indexedPublications } from "../lib/consensus/history.ts";
import { evaluateOutcome, outcomeKey, outcomeTrainingRow, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { loadOutcomeAvailability, observationCutoff, outcomeAvailability, outcomeClockMap, PRIVATE_OUTCOME_AVAILABILITY } from "../lib/consensus/outcome-availability.ts";
import { loadEvaluationOutcomes, outcomeIndex, PRIVATE_OUTCOME_LEDGER, PUBLIC_OUTCOME_INDEX } from "../lib/consensus/outcome-ledger.ts";
import { permitsModelInputs } from "../lib/consensus/model.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { auditProspectiveRetailOutcomes } from "../lib/consensus/prospective-retail-outcomes.ts";
import { RETAIL_REGISTRATION } from "../lib/consensus/prospective-retail.ts";
import { nativeStudyIntake, publisherSecondaryStudies } from "../lib/consensus/secondary-studies.ts";
import { FAMILY_FEATURE_REGISTRATION } from "../lib/consensus/prospective-family-features.ts";
import { auditProspectiveFamilyOutcomes } from "../lib/consensus/prospective-family-outcomes.ts";
import { MARKETPARQUET_SOURCE } from "../lib/consensus/marketparquet.ts";
import { defaultEvaluationPrices } from "../lib/consensus/marketparquet-settlement.ts";
import { kibotPrimaryPolicy, kibotSelectedTarget, ordinaryDailyTarget, readKibotPrimaryPrices, type PrimaryPolicy } from "../lib/consensus/kibot-eod-primary.ts";
import { kibotCommitment, kibotCandidateSummary, KIBOT_MODEL_DIRECTORY, KIBOT_SUBSCRIBER_EOD_SOURCE, publicEvaluationMetrics, subscriberTestCount } from "../lib/consensus/kibot-eod-disclosure.ts";
import { MARKET_HISTORY_SOURCE } from "../lib/consensus/market-history-settlement.ts";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { planCandidate, evaluateCandidate } from "../lib/consensus/learning.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
import { readReservations, reserveEvaluation, promotionEvidence, LEARNING_POLICY,
  PROSPECTIVE_MINIMUM, MINIMUM_TEST_LABELS, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { ENGINE_VERSION } from "../lib/consensus/registry.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import type { Outcome } from "../lib/consensus/types.ts";
import type { PerformanceReport } from "../lib/consensus/performance-types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  dir = resolve(root, "public/consensus");
const now = new Date().toISOString();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--prices" || !isAbsolute(args[1])))
  throw new Error("Usage: consensus:evaluate [--prices /absolute/private/approved-prices.json]");

async function readPrices(): Promise<PriceEvidence[]> {
  if (!args.length) return defaultEvaluationPrices(root, now);
  const file = await lstat(args[1]);
  if (!file.isFile() || file.mode & 0o077) throw new Error("Approved prices require an owner-only regular file");
  const text = await readFile(args[1], "utf8");
  let supplied: PriceEvidence[];
  try { supplied = JSON.parse(text); }
  catch { throw new Error("Approved prices require valid JSON"); }
  if (!Array.isArray(supplied) || supplied.some(item => !item || !INSTRUMENTS.includes(item.instrument) || item.instrument === "MARKET") ||
      new Set(supplied.map(item => item.instrument)).size !== supplied.length)
    throw new Error("One verified price evidence set per instrument required");
  return supplied;
}
const release = await acquirePublicationLock(root, "evaluation");
let failure: {error: unknown} | undefined;
try {
  if (await recoverEvaluationTransaction(root)) {
    console.log(JSON.stringify({ status: "recovered_evaluation_transaction", retrained: false }));
  } else {
    let choice: PrimaryPolicy | null = null;
    let damagedChoice = false;
    try { choice = await kibotPrimaryPolicy(root); }
    catch { damagedChoice = true; }
    const outcomes: Outcome[] = await loadEvaluationOutcomes(root);
    const previouslySettled = outcomes.length;
    const priorAvailability = await loadOutcomeAvailability(root, outcomes, now);
    if (outcomes.some(row => row.source === KIBOT_SUBSCRIBER_EOD_SOURCE && !kibotSelectedTarget(choice, row.issuedAt, row.horizon)))
      damagedChoice = true;
    let subscriber: Awaited<ReturnType<typeof readKibotPrimaryPrices>> = [];
    if (!damagedChoice) {
      try { subscriber = await readKibotPrimaryPrices(root, choice, now); }
      catch { damagedChoice = true; }
    }
    if (damagedChoice) console.error("The subscriber source choice or approval directory needs repair. New ordinary daily targets with uncertain source selection remain pending.");
    const supplied = await readPrices();
    if (supplied.some(prices => /(?:^|\.)kibot\.com\.?$/i.test(new URL(prices.source).hostname)))
      throw Error("A Kibot primary outcome requires its original local subscriber approval");
    const primary = new Map(subscriber.map(prices => [prices.instrument + ":" + prices.sessions[0].session, prices]));
    await assertCommittedReservations(root);
    const { history, snapshots } = await indexedPublications(root, true);
    const writes: EvaluationWrite[] = [];
    const pending: NonNullable<PerformanceReport["pending"]> = [];
    for (const snapshot of snapshots)
      for (const instrument of INSTRUMENTS.filter(symbol => symbol !== "MARKET"))
        for (const horizon of HORIZONS) {
          const target = { snapshotId: snapshot.id, instrument, horizon };
          if (outcomes.some(previous => outcomeKey(previous) === outcomeKey(target))) continue;
          const selectedDay = damagedChoice ? ordinaryDailyTarget(snapshot.issuedAt, horizon) : kibotSelectedTarget(choice, snapshot.issuedAt, horizon);
          const proof = selectedDay && primary.get(instrument + ":" + selectedDay);
          const sources = selectedDay ? (proof ? [proof] : []) : supplied.filter(item => item.instrument === instrument);
          let row: Outcome | null = null;
          for (const prices of sources) {
            row = evaluateOutcome(snapshot, prices, horizon, now);
            if (row) break;
          }
          if (row) outcomes.push(row);
          else pending.push({ ...target, reason: selectedDay && damagedChoice ? "Awaiting restoration of the owner’s source choice and private approvals."
            : selectedDay ? "Awaiting the preselected Kibot subscriber and its independent daily controls." : sources.length
            ? "Awaiting verified prices or independently reviewed calendar coverage."
            : "No verified price evidence supplied for this instrument." });
        }
    const incompleteSubscriberCohorts = new Set<string>();
    for (const row of outcomes) {
      if (snapshots.find(s => s.id === row.snapshotId)?.engineVersion !== row.engineVersion)
        throw new Error("Outcome engine version differs from its immutable edition");
      if (row.source === KIBOT_SUBSCRIBER_EOD_SOURCE) {
        const target = kibotSelectedTarget(choice, row.issuedAt, row.horizon);
        const evidence = target && primary.get(row.instrument + ":" + target);
        const snapshot = snapshots.find(item => item.id === row.snapshotId)!;
        if (damagedChoice || !evidence || digest(evaluateOutcome(snapshot, evidence, row.horizon, now)) !== digest(row)) {
          // Retain the completed transaction. A damaged original prevents a new fit for its own cohort.
          incompleteSubscriberCohorts.add([row.engineVersion, row.instrument, row.horizon].join("/"));
        }
      }
    }
    // New outcomes first became usable after this run actually validated their prices. Earlier receipts keep their own clocks.
    const verifiedAt = new Date().toISOString();
    const availability = outcomeAvailability(outcomes, [...priorAvailability.knownAt, ...outcomes.slice(previouslySettled).map(row => {
      if (row.source !== KIBOT_SUBSCRIBER_EOD_SOURCE) return verifiedAt;
      const day = kibotSelectedTarget(choice, row.issuedAt, row.horizon);
      return primary.get(row.instrument + ":" + day)!.approvedAt;
    })]);
    const knownAt = outcomeClockMap(outcomes, availability);
    const selection = selectScoredOutcomes(outcomes),
      metrics = publicEvaluationMetrics(outcomes, ENGINE_VERSION),
      cohorts: PerformanceReport["cohorts"] = [],
      learning: PerformanceReport["learning"] = [];
    const registryPath = resolve(root, "lib/consensus/models.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      schemaVersion: number;
      models: ActiveModel[];
      note: string;
    };
    await mkdir(resolve(dir, "models"), { recursive: true });
    const reservations = await readReservations(root);
    const needsPriorReport = incompleteSubscriberCohorts.size || reservations.some(r => !prospectiveAttemptBudget(r.attempt + 1).available);
    const priorReport: PerformanceReport | null = needsPriorReport
      ? await readFile(resolve(root, "lib/consensus/performance.json"), "utf8").then(text => JSON.parse(text))
        .catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; }) : null;
    // Never silently restart the holdout ledger after an earlier untracked evaluation.
    for (const name of (await readdir(resolve(dir, "models"))).filter((name) => name.endsWith(".json"))) {
      const saved = JSON.parse(await readFile(resolve(dir, "models", name), "utf8"));
      if (saved.status === "evaluated" && !saved.promotionEvidence)
        throw new Error("Legacy prospective test inspection requires an explicit audit migration before further evaluation");
      if (saved.promotionEvidence && !reservations.some((record) =>
        record.instrument === saved.instrument && record.horizon === saved.horizon &&
        record.attempt === saved.promotionEvidence.attempt && record.datasetHash === saved.datasetHash))
        throw new Error("Candidate is missing its durable test reservation");
    }
    for (const model of registry.models) {
      if (model.engineVersion !== ENGINE_VERSION) throw new Error("Deactivate incompatible incumbent before evaluating a new rule version");
      await validateActiveModelTree(root, model, reservations);
    }
    const modelAsOf = await observationCutoff(verifiedAt);
    for (const instrument of INSTRUMENTS.filter((symbol) => symbol !== "MARKET"))
      for (const horizon of HORIZONS) {
        const sample = outcomes.filter(row => row.instrument === instrument && row.horizon === horizon);
        for (const engineVersion of [...new Set([ENGINE_VERSION, ...snapshots.map(s => s.engineVersion)])]) {
          const stats = publicEvaluationMetrics(sample, engineVersion);
          cohorts.push({instrument, horizon, engineVersion, resolved:stats.resolved, calls:stats.calls,
            accuracy:stats.accuracy, meanSignedReturnPct:stats.meanSignedReturnPct,
            meanBuyHoldReturnPct:stats.meanBuyHoldReturnPct, brier:stats.brier});
        }
        if (incompleteSubscriberCohorts.has([ENGINE_VERSION, instrument, horizon].join("/"))) {
          const last = priorReport?.learning.find(row => row.engineVersion === ENGINE_VERSION &&
            row.instrument === instrument && row.horizon === horizon);
          if (!last) throw Error("A previously settled cohort is missing its evaluation history");
          learning.push({ ...last, promoted: false, status: "awaiting_native_replay",
            reason: "One or more previously admitted subscriber prices could not be rechecked. The prior candidate and reservation are retained." });
          continue;
        }
        const prior = reservations.filter((record) => record.instrument === instrument && record.horizon === horizon)
          .sort((a, b) => b.attempt - a.attempt)[0];
        const nextBudget = prospectiveAttemptBudget((prior?.attempt ?? 0) + 1);
        if (prior && !nextBudget.available) {
          const previous = priorReport?.learning.find(row => row.engineVersion === ENGINE_VERSION && row.instrument === instrument && row.horizon === horizon);
          const artifact = previous?.artifact ?? `models/${instrument}-${horizon}-budget-${digest([ENGINE_VERSION, LEARNING_POLICY, prior.attempt]).slice(0,16)}.json`;
          if (!previous) writes.push({ path: "public/consensus/" + artifact, immutable: true,
            value: { instrument, horizon, engineVersion: ENGINE_VERSION, status: "evaluation_budget_exhausted", lastAttempt: prior.attempt, nextBudget } });
          learning.push({ engineVersion: ENGINE_VERSION, instrument, horizon, samples: previous?.samples ?? 0,
            minimum: PROSPECTIVE_MINIMUM, status: "evaluation_budget_exhausted", promoted: false, artifact,
            activeModelId: registry.models.find(model => model.instrument === instrument && model.horizon === horizon)?.id ?? null,
            reason: `Calibration is paused after attempt ${prior.attempt}. The next test requires ${nextBudget.required} bootstrap draws and the declared maximum is ${nextBudget.limit}. Sample count is from the last calibration. Newly verified outcomes continue to settle.` });
          continue;
        }
        const trainingRows: TrainingRow[] = [];
        const subscriberIds = new Set<string>();
        // Preserve the predeclared edition selection before checking source rights.
        for (const row of selection.selected.filter((item) =>
          item.instrument === instrument && item.horizon === horizon && item.engineVersion === ENGINE_VERSION,
        )) {
          const snapshot = snapshots.find((item) => item.id === row.snapshotId);
          if (!snapshot) throw new Error("Outcome references missing snapshot");
          if (!permitsModelInputs(snapshot, instrument, horizon)) continue;
          let labelKnownAt = knownAt.get(outcomeKey(row))!;
          if (row.source === KIBOT_SUBSCRIBER_EOD_SOURCE) {
            const day = kibotSelectedTarget(choice, snapshot.issuedAt, horizon)!;
            labelKnownAt = primary.get(instrument + ":" + day)!.approvedAt;
            if (labelKnownAt >= modelAsOf) continue;
            subscriberIds.add(outcomeKey(row));
          }
          trainingRows.push(outcomeTrainingRow(row, snapshot, labelKnownAt));
        }
        const incumbent = registry.models.find(
            (model) =>
              model.instrument === instrument && model.horizon === horizon,
          );
        const planned = planCandidate(trainingRows, modelAsOf, {
          engineVersion: ENGINE_VERSION,
          consumedThrough: prior?.consumedThrough,
          minimumSamples: PROSPECTIVE_MINIMUM,
          minimumTestSamples: MINIMUM_TEST_LABELS,
          nonOverlappingTest: true,
        });
        // Blind this dataset commitment before it reaches a public reservation or artifact name.
        // The same checked rows, dated split, alpha budget and incumbent feed the single private fit.
        const subscriberCohort = subscriberIds.size > 0;
        const plan = subscriberCohort ? { ...planned, datasetHash: await kibotCommitment(root, planned.datasetHash) } : planned;
        // Reserve before fitting/evaluating: failed candidates and crashes consume their test window too.
        const reservation = plan.status === "ready"
          ? await reserveEvaluation(root, reservations, plan, instrument, horizon, modelAsOf, incumbent) : null;
        if (reservation) reservations.push(reservation);
        const result = plan.status === "ready" ? evaluateCandidate(plan, incumbent?.model) : plan;
        const gate = plan.status === "ready" && result.status === "evaluated" && reservation
          ? promotionEvidence(plan, result.model, reservation, incumbent?.model) : null;
        const contextHash = digest({ datasetHash: result.datasetHash, policy: LEARNING_POLICY, engineVersion: ENGINE_VERSION, priceAdjustment: OUTCOME_PRICE_BASIS,
          priorAttempt: prior?.attempt ?? 0, incumbent: incumbent?.id ?? null });
        const artifact = `models/${instrument}-${horizon}-wf2-${contextHash.slice(0, 16)}.json`;
        const promote =
          result.status === "evaluated" &&
          result.promoted &&
          result.datasetHash !== incumbent?.datasetHash &&
          gate?.passes === true;
        if (promote && result.status === "evaluated" && !subscriberCohort) {
          const active: ActiveModel = {
            id: `${instrument}-${horizon}-${result.datasetHash.slice(0, 16)}`,
            instrument,
            horizon,
            engineVersion: ENGINE_VERSION,
            trainedAt: modelAsOf,
            labelsThrough: gate!.consumedThrough,
            datasetHash: result.datasetHash,
            samples: result.samples,
            featureSchema: "family-score-plus-observation-mask-v1",
            priceAdjustment: OUTCOME_PRICE_BASIS,
            model: result.model,
            testBrier: result.candidateBrier,
            baselineBrier: Math.min(result.coinBrier, result.baseRateBrier),
            testSamples: result.split.test,
            promotionEvidence: gate!,
          };
          writes.push({ path: `public/consensus/models/active-${active.id}.json`, value: active, immutable: true });
          registry.models = [
            ...registry.models.filter(
              (model) =>
                model.instrument !== instrument || model.horizon !== horizon,
            ),
            active,
          ];
          registry.note =
            "Active models passed prospective chronological gates. Previous model artifacts remain available for rollback; as-issued forecasts retain their original model identity.";
        }
        const licensedTest = subscriberCohort && plan.status === "ready" ? subscriberTestCount(plan, subscriberIds) : 0;
        const privateArtifact = KIBOT_MODEL_DIRECTORY + "/" + artifact.slice("models/".length);
        try { await readFile(resolve(dir, artifact)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const full = { ...result, promoted: promote, promotionEvidence: gate, instrument, horizon,
            engineVersion: ENGINE_VERSION, priceAdjustment: OUTCOME_PRICE_BASIS, evaluatedAt: modelAsOf,
            activated: promote && !subscriberCohort, featureSchema: "family-score-plus-observation-mask-v1" };
          if (subscriberCohort) {
            writes.push({ path: privateArtifact, immutable: true,
              value: { ...full, unblindedDatasetHash: planned.datasetHash } });
          }
          writes.push({ path: `public/consensus/${artifact}`, immutable: true, value: subscriberCohort
            ? { instrument, horizon, engineVersion: ENGINE_VERSION,
              ...kibotCandidateSummary(result, promote, reservation?.attempt ?? null, licensedTest) } : full });
        }
        learning.push({
          engineVersion: ENGINE_VERSION,
          instrument,
          horizon,
          samples: result.samples,
          minimum: result.minimum,
          status: result.status,
          promoted: promote && !subscriberCohort,
          activeModelId: registry.models.find((model) => model.instrument === instrument && model.horizon === horizon)?.id ?? null,
          reason: subscriberCohort && result.status === "evaluated" && licensedTest < MINIMUM_TEST_LABELS
            ? "The private candidate completed its reserved test. Fewer than 100 subscriber test labels permit only aggregate counts."
            : subscriberCohort && result.status === "evaluated" ? (promote
            ? "The private candidate passed the reserved statistical gates. Its fitted parameters remain private under the subscriber licence."
            : "The private candidate did not pass all reserved statistical gates.") : promote ? "Candidate passed the reserved prospective gates and is active for future publications."
            : gate && !gate.passes ? "Candidate failed the paired-loss uncertainty or repeated-comparison gate; its test window is consumed." : result.reason,
          artifact,
        });
      }
    const report: PerformanceReport = {
      engineVersion: ENGINE_VERSION,
      generatedAt: modelAsOf,
      status: supplied.length || outcomes.length ? "tracking" : "awaiting_price_evidence",
      resolved: metrics.resolved,
      calls: metrics.calls,
      abstentions: metrics.abstentions,
      accuracy: metrics.accuracy,
      brier: metrics.brier,
      scoringPolicy: selection.policy,
      superseded: metrics.superseded,
      pending,
      cohorts,
      learning,
      note: "The private evaluation ledger retains the original outcome values. The public outcome index records resolved edition identities. Scoring and training select the last edition before each entry open, separately per instrument and horizon. Superseded editions are retained. Performance is separated by engine version and training and activation require one version. Alpha budgets and consumed windows never restart on a methodology change. Promotion requires 100 non-overlapping, previously uninspected test labels, a durable reservation even for failures, baseline improvement and a paired block-bootstrap gate adjusted across cohorts and repeated attempts. Overlapping horizons are not a portfolio." +
        (outcomes.some(row => row.source === FIRST_RATE_SOURCE)
          ? " Price source for covered equity outcomes is FirstRate Data. See the consensus attribution file." : "") +
        (outcomes.some(row => row.source === MARKETPARQUET_SOURCE)
          ? " MarketParquet daily ETF prices and issuer distributions supply complete outcome windows. See the consensus attribution file." : "") +
        (outcomes.some(row => row.source === KIBOT_SUBSCRIBER_EOD_SOURCE)
          ? " Kibot subscriber prices contribute to private prospective calibration. Exact mixed-source returns and incremental scores remain private. Public candidate reports show rounded statistics for fully reserved test cohorts." : "") +
        (outcomes.some(row => row.source === MARKET_HISTORY_SOURCE)
          ? " Verified Market History consolidated bars and iShares distributions supply covered TLT outcome windows." : ""),
    };
    if (outcomes.length) writes.push({ path: PRIVATE_OUTCOME_LEDGER, value: outcomes }, { path: PRIVATE_OUTCOME_AVAILABILITY, value: availability });
    writes.push(
      { path: PUBLIC_OUTCOME_INDEX, value: outcomeIndex(outcomes) },
      { path: "public/consensus/outcome-selection.json", value: { policy: selection.policy, superseded: selection.superseded } },
      { path: "lib/consensus/models.json", value: registry },
      { path: "lib/consensus/performance.json", value: report },
    );
    const intake = !args.length && outcomes.length > previouslySettled
      ? { nativeStudyIntake: nativeStudyIntake(previouslySettled, history, reservations) } : undefined;
    await commitEvaluationTransaction(root, writes, intake);
    console.log(
      JSON.stringify({
        status: report.status,
        resolved: report.resolved,
        calls: report.calls,
        pending: pending.length,
        candidates: learning.length,
        trained: learning.filter((item) => item.status === "evaluated").length,
      }),
    );
  }
  // Complete previously journaled private admissions under the same lock, including after core crash recovery.
  for (const {name, study} of publisherSecondaryStudies) {
    try {
      const pending = await lstat(resolve(root, study.advanceMarker)).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (pending) console.error("Private secondary study", name, JSON.stringify(await study.status(root, true)));
    } catch (error) { console.error("Private secondary advance failed for", name, error instanceof Error ? error.message : String(error)); }
  }
} catch (error) {
  failure = {error};
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}

// The public transaction is complete. Only enrolled private research runs here.
try {
  const registered = await lstat(resolve(root, FAMILY_FEATURE_REGISTRATION)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (registered) {
    const audit = await auditProspectiveFamilyOutcomes(root);
    console.error("Private prospective family research", JSON.stringify(audit));
  }
} catch (error) {
  console.error("Private prospective family outcome audit failed.", error instanceof Error ? error.message : String(error));
}

try {
  const registered = await lstat(resolve(root, RETAIL_REGISTRATION)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (registered) console.error("Private monthly retail research", JSON.stringify(await auditProspectiveRetailOutcomes(root)));
} catch (error) {
  console.error("Private monthly retail audit failed.", error instanceof Error ? error.message : String(error));
}
