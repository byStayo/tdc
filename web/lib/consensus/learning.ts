import { createHash } from "node:crypto";
import { predict } from "./model.ts";
import type { LogisticModel } from "./model.ts";
export { predict } from "./model.ts";
export type { LogisticModel } from "./model.ts";

export interface TrainingRow {
  id: string;
  engineVersion: string;
  issuedAt: string;
  labelKnownAt: string;
  features: number[];
  up: 0 | 1;
}
function fit(rows: TrainingRow[], regularization: number): LogisticModel {
  const width = rows[0].features.length,
    means = Array.from(
      { length: width },
      (_, i) =>
        rows.reduce((sum, row) => sum + row.features[i], 0) / rows.length,
    );
  const scales = means.map(
    (mean, i) =>
      Math.sqrt(
        rows.reduce((sum, row) => sum + (row.features[i] - mean) ** 2, 0) /
          rows.length,
      ) || 1,
  );
  const model: LogisticModel = {
    intercept: 0,
    weights: Array(width).fill(0),
    means,
    scales,
    regularization,
  };
  for (let iteration = 0; iteration < 600; iteration++) {
    let interceptGradient = 0;
    const gradients = Array(width).fill(0);
    for (const row of rows) {
      const error = predict(model, row.features) - row.up;
      interceptGradient += error;
      row.features.forEach((value, i) => {
        gradients[i] += (error * (value - means[i])) / scales[i];
      });
    }
    model.intercept -= (0.08 * interceptGradient) / rows.length;
    model.weights.forEach((weight, i) => {
      model.weights[i] -=
        0.08 *
        (gradients[i] / rows.length + (regularization * weight) / rows.length);
    });
  }
  return model;
}
const brier = (
  rows: TrainingRow[],
  probability: (row: TrainingRow) => number,
) =>
  rows.reduce((sum, row) => sum + (probability(row) - row.up) ** 2, 0) /
  rows.length;
export function chronologicalSplit(rows: TrainingRow[]) {
  const sorted = [...rows].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  const validationAt = sorted[Math.floor(sorted.length * 0.6)]?.issuedAt,
    testAt = sorted[Math.floor(sorted.length * 0.8)]?.issuedAt;
  // Purge overlapping labels by actual resolution time, not an assumed number of calendar days.
  return {
    train: sorted.filter(
      (row) => row.issuedAt < validationAt && row.labelKnownAt < validationAt,
    ),
    validation: sorted.filter(
      (row) =>
        row.issuedAt >= validationAt &&
        row.issuedAt < testAt &&
        row.labelKnownAt < testAt,
    ),
    test: sorted.filter((row) => row.issuedAt >= testAt),
  };
}
export interface EvaluationPolicy {
  engineVersion?: string;
  consumedThrough?: string;
  minimumSamples?: number;
  minimumTestSamples?: number;
  nonOverlappingTest?: boolean;
}

export function planCandidate(
  input: TrainingRow[],
  asOf: string,
  policy: EvaluationPolicy = {},
) {
  const engineVersion = policy.engineVersion ?? input[0]?.engineVersion ?? null;
  if (input.some(row => !row.engineVersion || row.engineVersion !== engineVersion))
    throw new Error("Training rows must share one declared engine version");
  if (!Number.isFinite(Date.parse(asOf)) ||
      (policy.consumedThrough && (!Number.isFinite(Date.parse(policy.consumedThrough)) ||
        new Date(policy.consumedThrough).toISOString() !== policy.consumedThrough)))
    throw new Error("Invalid evaluation cutoff");
  const rows = input.filter((row) => row.labelKnownAt < new Date(asOf).toISOString())
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some(
      (row) =>
        !Number.isFinite(Date.parse(row.issuedAt)) ||
        !Number.isFinite(Date.parse(row.labelKnownAt)) ||
        new Date(row.issuedAt).toISOString() !== row.issuedAt ||
        new Date(row.labelKnownAt).toISOString() !== row.labelKnownAt ||
        row.labelKnownAt <= row.issuedAt ||
        !row.features.length ||
        !row.features.every(Number.isFinite) ||
        ![0, 1].includes(row.up) ||
        row.features.length !== rows[0].features.length,
    )
  )
    throw new Error("Invalid training evidence");
  const datasetHash = createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
  const minimum = policy.minimumSamples ?? 120;
  if (rows.length < minimum)
    return {
      status: "insufficient_data" as const,
      engineVersion,
      samples: rows.length,
      minimum,
      datasetHash,
      promoted: false,
      reason:
        `At least ${minimum} resolved, source-backed observations per instrument and horizon are required.`,
    };
  const split = chronologicalSplit(rows);
  if (policy.consumedThrough) {
    split.test = split.test.filter((row) => row.issuedAt > policy.consumedThrough!);
  }
  if (policy.nonOverlappingTest) {
    let knownThrough = "";
    split.test = split.test.filter((row) => {
      if (row.issuedAt <= knownThrough) return false;
      knownThrough = row.labelKnownAt;
      return true;
    });
  }
  const minimumTestSamples = policy.minimumTestSamples ?? 20;
  const freshLabels = policy.consumedThrough
    ? rows.filter((row) => row.labelKnownAt > policy.consumedThrough!).length
    : rows.length;
  if (
    split.train.length < 50 ||
    split.validation.length < 20 ||
    split.test.length < minimumTestSamples ||
    freshLabels < 20 ||
    new Set(split.train.map((row) => row.up)).size < 2
  )
    return {
      status: "insufficient_data" as const,
      engineVersion,
      samples: rows.length,
      minimum,
      datasetHash,
      promoted: false,
      reason:
        `The purged split needs 50 training rows with both outcomes, 20 validation rows, ${minimumTestSamples} ${policy.nonOverlappingTest ? "non-overlapping, previously uninspected " : ""}test labels and 20 fresh resolved labels.`,
    };
  return { status: "ready" as const, engineVersion: engineVersion!, samples: rows.length, minimum, datasetHash, split };
}

export type ReadyCandidate = Extract<ReturnType<typeof planCandidate>, { status: "ready" }>;

/** Caller must durably reserve a prospective test window before invoking this evaluator. */
export function evaluateCandidate(plan: ReadyCandidate, incumbent?: LogisticModel) {
  const { samples, minimum, datasetHash, split } = plan;
  const candidates = [0.01, 0.1, 1, 10].map((lambda) =>
    fit(split.train, lambda),
  );
  candidates.sort(
    (a, b) =>
      brier(split.validation, (row) => predict(a, row.features)) -
      brier(split.validation, (row) => predict(b, row.features)),
  );
  const model = candidates[0],
    rate =
      split.train.reduce((sum, row) => sum + row.up, 0) / split.train.length;
  const candidateBrier = brier(split.test, (row) =>
    predict(model, row.features),
  );
  const baseRateBrier = brier(split.test, () => rate),
    coinBrier = brier(split.test, () => 0.5),
    incumbentBrier = incumbent
      ? brier(split.test, (row) => predict(incumbent, row.features))
      : null;
  const promoted =
    candidateBrier <
    Math.min(baseRateBrier, coinBrier, incumbentBrier ?? 1) - 0.01;
  const calibration = Array.from({ length: 5 }, (_, bin) => {
    const members = split.test.filter(
      (row) =>
        Math.min(4, Math.floor(predict(model, row.features) * 5)) === bin,
    );
    return {
      lower: bin / 5,
      upper: (bin + 1) / 5,
      count: members.length,
      predicted: members.length
        ? members.reduce((sum, row) => sum + predict(model, row.features), 0) /
          members.length
        : null,
      actual: members.length
        ? members.reduce((sum, row) => sum + row.up, 0) / members.length
        : null,
    };
  });
  return {
    status: "evaluated" as const,
    engineVersion: plan.engineVersion,
    samples,
    minimum,
    datasetHash,
    promoted,
    reason: promoted
      ? "Candidate clears chronological holdout gates; reviewed publication is required for activation."
      : "Candidate did not improve on all declared baselines by at least 0.01 Brier.",
    split: {
      train: split.train.length,
      validation: split.validation.length,
      test: split.test.length,
      trainEnds: split.train.at(-1)!.labelKnownAt,
      testStarts: split.test[0].issuedAt,
      testEnds: split.test.map((row) => row.labelKnownAt).sort().at(-1)!,
    },
    model,
    candidateBrier,
    baseRateBrier,
    coinBrier,
    incumbentBrier,
    calibration,
  };
}

/** Single historical research evaluation. Prospective activation additionally uses a persisted reservation and significance gate. */
export function trainCandidate(input: TrainingRow[], asOf: string, incumbent?: LogisticModel) {
  const plan = planCandidate(input, asOf);
  return plan.status === "ready" ? evaluateCandidate(plan, incumbent) : plan;
}
