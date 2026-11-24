import { brierScore, fitLogisticModel, type TrainingRow } from "./learning.ts";
import { pairedLossEvidence } from "./learning-audit.ts";
import { predict, type LogisticModel } from "./model.ts";
import type { Instrument } from "./types.ts";

export type StudyFund = Exclude<Instrument, "MARKET">;
export type StudyPolicy = {
  method: string;
  instruments: readonly StudyFund[];
  train: 300;
  validation: 100;
  test: 100;
  alpha: number;
};
export type Phase = "train" | "validation" | "test";
export type Forecast = { signal: number; control: number; base: number; coin: number };
export type Fitted = { candidate: LogisticModel; control: LogisticModel; base: number };

export function fitSecondary(train: TrainingRow[], validation: TrainingRow[], policy: StudyPolicy): Fitted {
  if (
    train.length !== policy.train ||
    validation.length !== policy.validation ||
    new Set(train.map((r) => r.up)).size !== 2 ||
    train.some(row => row.labelKnownAt >= validation[0].issuedAt) ||
    validation.some(row => row.issuedAt < validation[0].issuedAt)
  )
    throw Error("The locked secondary training and validation cohorts are ineligible");
  function fit(controlOnly: boolean) {
    const feature = (r: TrainingRow) => (controlOnly ? [r.features[0]] : r.features);
    const training = train.map((r) => ({ ...r, features: feature(r) }));
    return [0.01, 0.1, 1, 10]
      .map((lambda) => fitLogisticModel(training, lambda))
      .map((model) => ({ model, brier: brierScore(validation, (r) => predict(model, feature(r))) }))
      .sort((a, b) => a.brier - b.brier)[0].model;
  }
  return { candidate: fit(false), control: fit(true), base: train.reduce((s, r) => s + r.up, 0) / train.length };
}

export function secondaryForecast(model: Fitted, control: number, candidate: number): Forecast {
  return {
    signal: predict(model.candidate, [control, candidate]),
    control: predict(model.control, [control]),
    base: model.base,
    coin: 0.5,
  };
}

export function scoreSecondary(
  fund: StudyFund,
  policy: StudyPolicy,
  policySha: string,
  fit: Fitted,
  test: { id: string; prediction: Forecast; up: number }[],
) {
  if (
    test.length !== policy.test ||
    new Set(test.map((r) => r.id)).size !== test.length ||
    test.some(
      (r) => ![0, 1].includes(r.up) || Object.values(r.prediction).some((p) => !Number.isFinite(p) || p < 0 || p > 1),
    )
  )
    throw Error("Invalid sealed secondary test");
  const mean = (name: keyof Forecast) => test.reduce((s, r) => s + (r.up - r.prediction[name]) ** 2, 0) / test.length;
  const comparators = (["control", "base", "coin"] as const).map((name) => ({
    name,
    brier: mean(name),
    ...pairedLossEvidence(
      test.map((r) => (r.up - r.prediction[name]) ** 2 - (r.up - r.prediction.signal) ** 2),
      policySha + ":" + fund + ":" + name,
      policy.alpha,
    ),
  }));
  return {
    sampleCount: 500,
    testCount: test.length,
    testBrier: mean("signal"),
    coefficient: fit.candidate.weights[1],
    comparators,
    passes:
      fit.candidate.weights[1] > 0 &&
      comparators.every(
        (c) => c.meanImprovement > 0.01 && c.interval95[0] > 0 && c.pValue <= policy.alpha,
      ),
    promoted: false,
  };
}
