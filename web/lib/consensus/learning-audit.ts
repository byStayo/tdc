import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, open, link, unlink, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { HORIZONS, INSTRUMENTS } from "./types.ts";
import type { Horizon, Instrument } from "./types.ts";
import type { ReadyCandidate } from "./learning.ts";
import { predict } from "./model.ts";
import type { LogisticModel, ActiveModel } from "./model.ts";

export const LEARNING_POLICY = "prospective-walk-forward-2";
export const PROSPECTIVE_MINIMUM = 500;
export const MINIMUM_TEST_LABELS = 100;
const COHORTS = 15;
const RESAMPLES = 19999;
export function resamplesForAlpha(alpha: number) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 0.05) throw new Error("Invalid bootstrap alpha");
  const count = Math.max(RESAMPLES, Math.ceil(4 / alpha) - 1);
  if (count > 1_999_999) throw new Error("Bootstrap resolution exceeds the declared computation budget; no test may be inspected");
  return count;
}

export interface EvaluationReservation {
  policy: typeof LEARNING_POLICY;
  engineVersion: string;
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
  previousHash: string | null;
  incumbentId: string | null;
  incumbentModelHash: string | null;
}
export interface EvaluationAnchor { instrument: Instrument; horizon: Horizon; attempt: number; sha256: string; }
const reservationHash = (record: EvaluationReservation) => createHash("sha256").update(JSON.stringify(record)).digest("hex");
const modelHash = (model: LogisticModel) => createHash("sha256").update(JSON.stringify(model)).digest("hex");
export function reservationAnchors(records: EvaluationReservation[]): EvaluationAnchor[] {
  const heads = new Map<string, EvaluationReservation>();
  for (const record of records) {
    const key = `${record.instrument}:${record.horizon}`;
    if ((heads.get(key)?.attempt ?? 0) < record.attempt) heads.set(key, record);
  }
  return [...heads.values()].map(record => ({ instrument: record.instrument, horizon: record.horizon, attempt: record.attempt, sha256: reservationHash(record) }))
    .sort((a,b)=>`${a.instrument}:${a.horizon}`.localeCompare(`${b.instrument}:${b.horizon}`));
}
export function validateReservationAnchors(records: EvaluationReservation[], anchors: EvaluationAnchor[]) {
  if (!Array.isArray(anchors) || new Set(anchors.map(a=>`${a.instrument}:${a.horizon}`)).size !== anchors.length)
    throw new Error("Invalid reservation anchors");
  for (const anchor of anchors) {
    const match = records.find(r=>r.instrument===anchor.instrument && r.horizon===anchor.horizon && r.attempt===anchor.attempt);
    if (!match || reservationHash(match) !== anchor.sha256)
      throw new Error("Reservation ledger is shorter than or differs from its durable anchor");
  }
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
    if (record.policy !== LEARNING_POLICY || !/^consensus-rules-\d+\.\d+\.\d+$/.test(record.engineVersion ?? "") || record.previousHash !== (prior ? reservationHash(prior) : null) ||
        !((record.incumbentId === null && record.incumbentModelHash === null) ||
          (typeof record.incumbentId === "string" && /^[A-Za-z0-9_-]+$/.test(record.incumbentId) && /^[a-f0-9]{64}$/.test(record.incumbentModelHash ?? ""))) || !INSTRUMENTS.includes(record.instrument) ||
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
    else throw error;
  }
  const records = await Promise.all(files.filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8")) as EvaluationReservation));
  validateReservations(records);
  let local: EvaluationAnchor[] = [];
  try { local = JSON.parse(await readFile(resolve(root, ".consensus/learning-ledger-head.json"), "utf8")); }
  catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  validateReservationAnchors(records, local);
  let index: {id:string}[] = [];
  try { index = JSON.parse(await readFile(resolve(root, "public/consensus/index.json"), "utf8")); }
  catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const entry of index) {
    if (!/^[0-9TZ-]{20,30}$/.test(entry.id)) throw new Error("Invalid history anchor path");
    const snapshot = JSON.parse(await readFile(resolve(root, "public/consensus", `${entry.id}.json`), "utf8"));
    validateReservationAnchors(records, snapshot.evaluationAnchors ?? []);
  }
  return records;
}

export async function assertCommittedReservations(root: string) {
  const {stdout} = await promisify(execFile)("git", ["status", "--porcelain", "--", "public/consensus/evaluations"], {cwd:root});
  if (stdout.trim()) throw new Error("Commit the pending evaluation reservations before another evaluator run");
}

/** Under the publication lock, append and fsync BEFORE examining any test result.
 * A crash or failed candidate still consumes this window. Never delete its reservation. */
export async function reserveEvaluation(
  root: string, records: EvaluationReservation[], plan: ReadyCandidate,
  instrument: Instrument, horizon: Horizon, now: string, incumbent?: ActiveModel,
): Promise<EvaluationReservation> {
  const actual = await readReservations(root);
  if (incumbent && incumbent.engineVersion !== plan.engineVersion)
    throw new Error("Incumbent engine version differs from candidate features");
  if (JSON.stringify(reservationAnchors(actual)) !== JSON.stringify(reservationAnchors(records)))
    throw new Error("Stale reservation input does not match the durable ledger");
  const prior = records.filter((r) => r.instrument === instrument && r.horizon === horizon)
    .sort((a, b) => b.attempt - a.attempt)[0];
  if (plan.split.test.some((row, i, rows) => i > 0 && row.issuedAt <= rows[i - 1].labelKnownAt))
    throw new Error("Prospective test label windows overlap");
  const attempt = (prior?.attempt ?? 0) + 1;
  resamplesForAlpha(attemptAlpha(attempt));
  const reservation: EvaluationReservation = {
    policy: LEARNING_POLICY, engineVersion: plan.engineVersion, instrument, horizon, attempt, datasetHash: plan.datasetHash,
    testIds: plan.split.test.map((row) => row.id),
    testWindows: plan.split.test.map(({ id, issuedAt, labelKnownAt }) => ({ id, issuedAt, labelKnownAt })),
    testStarts: plan.split.test[0].issuedAt,
    consumedThrough: plan.split.test.map((row) => row.labelKnownAt).sort().at(-1)!,
    reservedAt: now, alpha: attemptAlpha(attempt), previousHash: prior ? reservationHash(prior) : null,
    incumbentId: incumbent?.id ?? null, incumbentModelHash: incumbent ? modelHash(incumbent.model) : null,
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
  // Independent of Git: a checkout/reset of an uncommitted failed attempt must
  // not erase the consumed window. The next publication also freezes these heads.
  const privateDir = resolve(root, ".consensus");
  await mkdir(privateDir, {recursive:true, mode:0o700});
  const head = resolve(privateDir, "learning-ledger-head.json"), pending = `${head}.${randomUUID()}.tmp`;
  try {
    const file = await open(pending,"wx",0o600);
    try { await file.writeFile(JSON.stringify(reservationAnchors([...records,reservation]))); await file.sync(); }
    finally { await file.close(); }
    await rename(pending,head);
    const dir=await open(privateDir,"r");try {await dir.sync();}finally{await dir.close();}
  } finally {await unlink(pending).catch(()=>undefined);}
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
export function pairedLossEvidence(differences: number[], seed: string, alpha = attemptAlpha(1)) {
  if (differences.length < MINIMUM_TEST_LABELS || differences.some((n) => !Number.isFinite(n) || Math.abs(n) > 1))
    throw new Error("At least 100 bounded paired losses required");
  const count = differences.length;
  const resamples = resamplesForAlpha(alpha);
  const mean = differences.reduce((sum, value) => sum + value, 0) / count;
  const blockLength = Math.ceil(Math.cbrt(count));
  const rng = random(seed);
  const distribution: number[] = [];
  let nullExceeds = 0;
  for (let sample = 0; sample < resamples; sample++) {
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
  const low = 2 * mean - distribution[Math.floor(0.975 * (resamples - 1))];
  const high = 2 * mean - distribution[Math.floor(0.025 * (resamples - 1))];
  return { meanImprovement: mean, interval95: [low, high] as [number, number],
    pValue: (nullExceeds + 1) / (resamples + 1), blockLength, resamples };
}

export function promotionEvidence(plan: ReadyCandidate, model: LogisticModel,
  reservation: EvaluationReservation, incumbent?: LogisticModel) {
  if (reservation.engineVersion !== plan.engineVersion || reservation.datasetHash !== plan.datasetHash ||
      JSON.stringify(reservation.testIds) !== JSON.stringify(plan.split.test.map((row) => row.id)))
    throw new Error("Test plan differs from its durable reservation");
  if ((incumbent ? modelHash(incumbent) : null) !== reservation.incumbentModelHash)
    throw new Error("Incumbent comparison differs from its pre-evaluation reservation");
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
    ), `${LEARNING_POLICY}:${plan.datasetHash}:${baseline.name}`, reservation.alpha),
  }));
  const passes = comparisons.every((item) => item.meanImprovement > 0.01 &&
    item.interval95[0] > 0 && item.pValue <= reservation.alpha);
  return {
    policy: LEARNING_POLICY, engineVersion: reservation.engineVersion, attempt: reservation.attempt, alpha: reservation.alpha,
    incumbentId: reservation.incumbentId, candidateModelHash: modelHash(model),
    consumedThrough: reservation.consumedThrough,
    nonOverlappingTestLabels: plan.split.test.length, comparisons, passes,
    method: "Paired circular-block basic bootstrap; Bonferroni across 15 cohorts with a summable alpha budget across attempts. Approximate evidence under temporal dependence, not a probability of profit.",
  };
}

export type PromotionEvidence = ReturnType<typeof promotionEvidence>;

export function validateActivePromotion(model: ActiveModel, reservations: EvaluationReservation[], predecessor?: ActiveModel) {
  if (model.priceAdjustment !== "total-return-adjusted") throw new Error("Active model price basis is not qualified");
  const gate = model.promotionEvidence;
  const reservation = reservations.find((record) => record.instrument === model.instrument &&
    record.horizon === model.horizon && record.datasetHash === model.datasetHash && record.attempt === gate?.attempt);
  if (!gate || !reservation || gate.policy !== LEARNING_POLICY || !gate.passes ||
      model.engineVersion !== reservation.engineVersion || gate.engineVersion !== model.engineVersion ||
      gate.candidateModelHash !== modelHash(model.model) || gate.incumbentId !== reservation.incumbentId ||
      (reservation.incumbentId !== null && (!predecessor || predecessor.id !== reservation.incumbentId ||
        predecessor.instrument !== model.instrument || predecessor.horizon !== model.horizon || predecessor.engineVersion !== model.engineVersion ||
        predecessor.trainedAt > reservation.reservedAt || modelHash(predecessor.model) !== reservation.incumbentModelHash)) ||
      gate.alpha !== reservation.alpha || gate.consumedThrough !== reservation.consumedThrough ||
      model.labelsThrough !== reservation.consumedThrough || model.trainedAt < reservation.reservedAt ||
      model.labelsThrough >= model.trainedAt || model.testSamples !== reservation.testIds.length ||
      gate.nonOverlappingTestLabels !== model.testSamples ||
      !Array.isArray(gate.comparisons) || gate.comparisons.length < 2 ||
      !gate.comparisons.some((item) => item.baseline === "coin") ||
      !gate.comparisons.some((item) => item.baseline === "base-rate") ||
      (reservation.incumbentId !== null && !gate.comparisons.some(item=>item.baseline === "incumbent")) ||
      gate.comparisons.some((item) => !Number.isFinite(item.meanImprovement) || item.meanImprovement <= 0.01 ||
        !Number.isFinite(item.interval95?.[0]) || item.interval95[0] <= 0 ||
        !Number.isFinite(item.pValue) || item.pValue < 1 / (item.resamples + 1) || item.pValue > gate.alpha ||
        item.resamples !== resamplesForAlpha(gate.alpha)))
    throw new Error("Active model has no valid reserved prospective promotion evidence");
}

/** Verify immutable predecessors, including the coefficients actually compared. */
export async function validateActiveModelTree(root: string, model: ActiveModel, records: EvaluationReservation[], seen = new Set<string>()) {
  if (seen.has(model.id)) throw new Error("Cyclic model predecessor chain");
  seen.add(model.id);
  const id = model.promotionEvidence?.incumbentId;
  let predecessor: ActiveModel | undefined;
  if (id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid predecessor identity");
    predecessor = JSON.parse(await readFile(resolve(root,"public/consensus/models",`active-${id}.json`),"utf8"));
    await validateActiveModelTree(root,predecessor!,records,seen);
  }
  validateActivePromotion(model,records,predecessor);
}
