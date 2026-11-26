import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { performance, selectScoredOutcomes } from "./evaluation.ts";
import { type evaluateCandidate, type planCandidate, type ReadyCandidate } from "./learning.ts";
import { MINIMUM_TEST_LABELS } from "./learning-audit.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import type { Outcome } from "./types.ts";

export const KIBOT_SUBSCRIBER_EOD_SOURCE = "https://www.kibot.com/subscribe.html#eod";
export const KIBOT_MODEL_DIRECTORY = ".consensus/private-kibot/production-daily/candidates";

/** A public hash of a single new training label would admit a two-value dictionary check. */
export async function kibotCommitment(root: string, inputHash: string) {
  const folder = resolve(root, ".consensus/private-kibot/production-daily");
  const path = resolve(folder, "dataset-commitment.json");
  const key = await readResearchReceipt<string>(path);
  if (!key || !/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{64}$/.test(inputHash))
    throw Error("Missing the original private subscriber cohort commitment key");
  return createHmac("sha256", Buffer.from(key, "hex")).update(inputHash).digest("hex");
}

export async function createKibotCommitment(root: string) {
  const folder = resolve(root, ".consensus/private-kibot/production-daily");
  const path = resolve(folder, "dataset-commitment.json");
  await durableDirectory(folder, 0o700);
  try { await durableJSON(path, randomBytes(32).toString("hex"), true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await kibotCommitment(root, "0".repeat(64));
}

/** Preserve the normal metric unless an included licensed label could be inferred by differencing editions. */
export function publicEvaluationMetrics(outcomes: Outcome[], engineVersion: string) {
  const stats = performance(outcomes, 2, engineVersion);
  const privateRows = selectScoredOutcomes(outcomes).selected.filter(row =>
    row.engineVersion === engineVersion && row.source === KIBOT_SUBSCRIBER_EOD_SOURCE);
  if (privateRows.some(row => !row.abstained && row.directionCorrect !== null)) {
    stats.meanSignedReturnPct = null;
    stats.meanBuyHoldReturnPct = null;
    stats.accuracy = null;
  }
  if (privateRows.some(row => row.predictedProbability !== null)) stats.brier = null;
  return stats;
}

type Result = Exclude<ReturnType<typeof planCandidate>, { status: "ready" }> | ReturnType<typeof evaluateCandidate>;

/** Edition selection and the non-overlap reservation ensure each member represents a distinct ETF session. */
export function subscriberTestCount(plan: ReadyCandidate, licensedIds: ReadonlySet<string>) {
  return new Set(plan.split.test.filter(row => licensedIds.has(row.id)).map(row => row.id)).size;
}

/** One immutable rounded summary per wholly reserved test. Identities, outcomes, weights and small bins stay private. */
export function kibotCandidateSummary(result: Result, gatePassed: boolean, attempt: number | null, licensedTest: number) {
  const base = { scope: "kibot-subscriber-aggregate", samples: result.samples, minimum: result.minimum,
    source: "https://www.kibot.com/license.html", activated: false };
  if (result.status !== "evaluated") return { ...base, status: "insufficient_data" };
  if (result.split.test < MINIMUM_TEST_LABELS || !Number.isSafeInteger(attempt) || attempt! < 1 ||
      !Number.isSafeInteger(licensedTest) || licensedTest < 0 || licensedTest > result.split.test)
    throw Error("A public subscriber statistic requires the complete reserved prospective test");
  const counts = { ...base, status: "evaluated_privately", attempt,
    train: result.split.train, validation: result.split.validation, test: result.split.test, licensedTest };
  // A mostly public 100-row benchmark can reveal the only restricted sign by subtracting its known losses.
  if (licensedTest < MINIMUM_TEST_LABELS) return counts;
  const rounded = (value: number) => Number(value.toFixed(4));
  return { ...counts,
    candidateBrier: rounded(result.candidateBrier), baseRateBrier: rounded(result.baseRateBrier),
    coinBrier: rounded(result.coinBrier), incumbentBrier: result.incumbentBrier === null ? null : rounded(result.incumbentBrier),
    passedStatisticalGates: gatePassed };
}
