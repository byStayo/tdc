import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, open, link, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { HORIZONS, INSTRUMENTS } from "./types.ts";
import type { Horizon, Instrument } from "./types.ts";
import type { ReadyCandidate } from "./learning.ts";
import { predict } from "./model.ts";
import type { LogisticModel, ActiveModel } from "./model.ts";

export const LEARNING_POLICY = "prospective-walk-forward-1";
export const PROSPECTIVE_MINIMUM = 500;
export const MINIMUM_TEST_LABELS = 100;
const COHORTS = 15;
const RESAMPLES = 19999;

export interface EvaluationReservation {
  policy: typeof LEARNING_POLICY;
  instrument: Instrument;
  horizon: Horizon;
  attempt: number;
  datasetHash: string;
  testIds: string[];
  testWindows: { id: string; issuedAt: string; labelKnownAt: string }[];
  testStarts: string;
  consumedThrough: string;
  reservedAt: string;
  alpha: number;
}
const instant = (s: string) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
export const attemptAlpha = (attempt: number) => {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid evaluation attempt");
  // Bonferroni across the 15 declared cohorts, and a summable budget across attempts.
  return 0.05 / (COHORTS * attempt * (attempt + 1));
};

export function validateReservations(records: EvaluationReservation[]) {
  const previous = new Map<string, EvaluationReservation>();
  const used = new Map<string, Set<string>>();
  for (const record of [...records].sort((a, b) => a.attempt - b.attempt)) {
    const cohort = `${record.instrument}:${record.horizon}`;
    const prior = previous.get(cohort);
    const ids = used.get(cohort) ?? new Set<string>();
    if (record.policy !== LEARNING_POLICY || !INSTRUMENTS.includes(record.instrument) ||
        record.instrument === "MARKET" || !HORIZONS.includes(record.horizon) ||
        record.attempt !== (prior?.attempt ?? 0) + 1 ||
        !/^[a-f0-9]{64}$/.test(record.datasetHash) ||
        !Array.isArray(record.testIds) || record.testIds.length < MINIMUM_TEST_LABELS ||
        record.testIds.some((id) => typeof id !== "string" || !id || ids.has(id)) ||
        new Set(record.testIds).size !== record.testIds.length ||
        !Array.isArray(record.testWindows) || record.testWindows.length !== record.testIds.length ||
        record.testWindows.some((row, i, windows) => row.id !== record.testIds[i] ||
          !instant(row.issuedAt) || !instant(row.labelKnownAt) || row.issuedAt >= row.labelKnownAt ||
          (i > 0 && row.issuedAt <= windows[i - 1].labelKnownAt)) ||
        record.testWindows[0].issuedAt !== record.testStarts ||
        record.testWindows.at(-1)!.labelKnownAt !== record.consumedThrough ||
        !instant(record.testStarts) || !instant(record.consumedThrough) || !instant(record.reservedAt) ||
        record.testStarts >= record.consumedThrough || record.consumedThrough > record.reservedAt ||
        (prior && (record.testStarts <= prior.consumedThrough || record.reservedAt < prior.reservedAt)) ||
        record.alpha !== attemptAlpha(record.attempt))
      throw new Error("Invalid or reused prospective evaluation reservation");
    record.testIds.forEach((id) => ids.add(id));
    used.set(cohort, ids);
    previous.set(cohort, record);
  }
}

export async function readReservations(root: string): Promise<EvaluationReservation[]> {
  const directory = resolve(root, "public/consensus/evaluations");
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(files.filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8")) as EvaluationReservation));
  validateReservations(records);
  return records;
}

/** Under the publication lock, append and fsync BEFORE examining any test result.
 * A crash or failed candidate still consumes this window. Never delete its reservation. */
export async function reserveEvaluation(
  root: string, records: EvaluationReservation[], plan: ReadyCandidate,
  instrument: Instrument, horizon: Horizon, now: string,
): Promise<EvaluationReservation> {
  const prior = records.filter((r) => r.instrument === instrument && r.horizon === horizon)
    .sort((a, b) => b.attempt - a.attempt)[0];
  if (plan.split.test.some((row, i, rows) => i > 0 && row.issuedAt <= rows[i - 1].labelKnownAt))
    throw new Error("Prospective test label windows overlap");
  const attempt = (prior?.attempt ?? 0) + 1;
  const reservation: EvaluationReservation = {
    policy: LEARNING_POLICY, instrument, horizon, attempt, datasetHash: plan.datasetHash,
    testIds: plan.split.test.map((row) => row.id),
    testWindows: plan.split.test.map(({ id, issuedAt, labelKnownAt }) => ({ id, issuedAt, labelKnownAt })),
    testStarts: plan.split.test[0].issuedAt,
    consumedThrough: plan.split.test.map((row) => row.labelKnownAt).sort().at(-1)!,
    reservedAt: now, alpha: attemptAlpha(attempt),
  };
  validateReservations([...records, reservation]);
  const directory = resolve(root, "public/consensus/evaluations");
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, `${instrument}-${horizon}-${String(attempt).padStart(6, "0")}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(reservation, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, destination); // Cannot replace an already consumed attempt.
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
  return reservation;
}

function random(seed: string) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired loss differences preserve a common outcome. Circular blocks retain local
 * serial dependence; the block length and seed do not depend on observed skill. */
export function pairedLossEvidence(differences: number[], seed: string) {
  if (differences.length < MINIMUM_TEST_LABELS || differences.some((n) => !Number.isFinite(n) || Math.abs(n) > 1))
    throw new Error("At least 100 bounded paired losses required");
  const count = differences.length;
  const mean = differences.reduce((sum, value) => sum + value, 0) / count;
  const blockLength = Math.ceil(Math.cbrt(count));
  const rng = random(seed);
  const distribution: number[] = [];
  let nullExceeds = 0;
  for (let sample = 0; sample < RESAMPLES; sample++) {
    let sum = 0;
    for (let at = 0; at < count;) {
      const start = Math.floor(rng() * count);
      for (let j = 0; j < blockLength && at < count; j++, at++)
        sum += differences[(start + j) % count];
    }
    const resampled = sum / count;
    distribution.push(resampled);
    if (resampled - mean >= mean) nullExceeds++;
  }
  distribution.sort((a, b) => a - b);
  // Basic bootstrap interval: invert the centered sampling errors.
  const low = 2 * mean - distribution[Math.floor(0.975 * (RESAMPLES - 1))];
  const high = 2 * mean - distribution[Math.floor(0.025 * (RESAMPLES - 1))];
  return { meanImprovement: mean, interval95: [low, high] as [number, number],
    pValue: (nullExceeds + 1) / (RESAMPLES + 1), blockLength, resamples: RESAMPLES };
}

export function promotionEvidence(plan: ReadyCandidate, model: LogisticModel,
  reservation: EvaluationReservation, incumbent?: LogisticModel) {
  if (reservation.datasetHash !== plan.datasetHash ||
      JSON.stringify(reservation.testIds) !== JSON.stringify(plan.split.test.map((row) => row.id)))
    throw new Error("Test plan differs from its durable reservation");
  const rate = plan.split.train.reduce((sum, row) => sum + row.up, 0) / plan.split.train.length;
  const baselines = [
    { name: "base-rate", probability: () => rate },
    { name: "coin", probability: () => 0.5 },
    ...(incumbent ? [{ name: "incumbent", probability: (features: number[]) => predict(incumbent, features) }] : []),
  ];
  const comparisons = baselines.map((baseline) => ({
    baseline: baseline.name,
    ...pairedLossEvidence(plan.split.test.map((row) =>
      (baseline.probability(row.features) - row.up) ** 2 - (predict(model, row.features) - row.up) ** 2,
    ), `${LEARNING_POLICY}:${plan.datasetHash}:${baseline.name}`),
  }));
  const passes = comparisons.every((item) => item.meanImprovement > 0.01 &&
    item.interval95[0] > 0 && item.pValue <= reservation.alpha);
  return {
    policy: LEARNING_POLICY, attempt: reservation.attempt, alpha: reservation.alpha,
    consumedThrough: reservation.consumedThrough,
    nonOverlappingTestLabels: plan.split.test.length, comparisons, passes,
    method: "Paired circular-block basic bootstrap; Bonferroni across 15 cohorts with a summable alpha budget across attempts. Approximate evidence under temporal dependence, not a probability of profit.",
  };
}

export type PromotionEvidence = ReturnType<typeof promotionEvidence>;

export function validateActivePromotion(model: ActiveModel, reservations: EvaluationReservation[]) {
  const gate = model.promotionEvidence;
  const reservation = reservations.find((record) => record.instrument === model.instrument &&
    record.horizon === model.horizon && record.datasetHash === model.datasetHash && record.attempt === gate?.attempt);
  if (!gate || !reservation || gate.policy !== LEARNING_POLICY || !gate.passes ||
      gate.alpha !== reservation.alpha || gate.consumedThrough !== reservation.consumedThrough ||
      model.labelsThrough !== reservation.consumedThrough || model.trainedAt < reservation.reservedAt ||
      model.labelsThrough >= model.trainedAt || model.testSamples !== reservation.testIds.length ||
      gate.nonOverlappingTestLabels !== model.testSamples ||
      !Array.isArray(gate.comparisons) || gate.comparisons.length < 2 ||
      !gate.comparisons.some((item) => item.baseline === "coin") ||
      !gate.comparisons.some((item) => item.baseline === "base-rate") ||
      gate.comparisons.some((item) => !Number.isFinite(item.meanImprovement) || item.meanImprovement <= 0.01 ||
        !Number.isFinite(item.interval95?.[0]) || item.interval95[0] <= 0 ||
        !Number.isFinite(item.pValue) || item.pValue < 1 / (RESAMPLES + 1) || item.pValue > gate.alpha ||
        item.resamples !== RESAMPLES))
    throw new Error("Active model has no valid reserved prospective promotion evidence");
}
