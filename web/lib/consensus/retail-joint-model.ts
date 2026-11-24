import { brierScore, fitLogisticModel, type TrainingRow } from "./learning.ts";
import { pairedLossEvidence } from "./learning-audit.ts";
import { predict, type LogisticModel } from "./model.ts";
import { RETAIL_ID, RETAIL_RULES } from "./prospective-retail.ts";
import { RETAIL_POLICY_SHA256 } from "./prospective-family-features.ts";
import { digest } from "./history.ts";

export const JOINT_RETAIL_POLICY = {
  method: "nyfed-sce-before-open-joint-secondary-v2",
  originalFeaturePolicy: RETAIL_POLICY_SHA256,
  feature: RETAIL_ID,
  instruments: RETAIL_RULES.map((r) => r.instrument),
  purposes:
    "One private secondary test per fund, alongside the unchanged core evaluation. No public scores, fitted weights, core input, promotion or interim test inspection.",
  intake:
    "Only releases after registration, sealed from the original immediately preceding/current SCE measures and a same-day preopen public witness. Each ETF-month counts once, final as-issued daily edition only. Exclude pre-existing overlapping production reservations. Future core reservations independently retain every ordinary eligible window.",
  price:
    "Only the first native core settlement of an enrolled ordinary ETF session, using independently approved FirstRate, licensed MarketParquet, or paid Kibot EOD. No manual evidence or replay of previously settled core labels.",
  partition:
    "Train on the first 300 distinct qualified enrollments ordered by entry at the training freeze. Start validation only after this freeze; lock the first 100 qualified validation enrollments and fitted models before admitting any test forecast. Sign every test prediction before its target opens. Seal the first 100 qualified test identities before reading those signs. Late settlements cannot rewrite a frozen group. No repeat attempts.",
  model:
    "Standardized logistic loss, 600 gradient steps, penalties 0.01, 0.1, 1, 10 selected by minimum validation Brier (first wins ties). Compare level+preceding-level with preceding-level only, training rate, and coin. Expect positive coefficient for the current level.",
  evidence:
    "One preregistered private descriptive study per ETF. Require all three mean improvements >0.01, lower paired 95% block interval >0, and one-sided p<=0.01/(4*3). Standalone secondary family. No alpha is borrowed from production and no confirmation or promotion in the primary family.",
  train: 300,
  validation: 100,
  test: 100,
  alpha: 0.01 / (4 * 3),
} as const;
export const JOINT_RETAIL_SHA = "d23860a3de41238ef72c7555256b7e49c1076c97a9f6187581a68a5aba050f19";
if (digest(JOINT_RETAIL_POLICY) !== JOINT_RETAIL_SHA)
  throw Error("Changed joint retail policy requires a separately registered version");
export type RetailFund = (typeof RETAIL_RULES)[number]["instrument"];
export type Phase = "train" | "validation" | "test";
export type Forecast = { signal: number; control: number; base: number; coin: number };
export type Fitted = { candidate: LogisticModel; control: LogisticModel; base: number };

export function fitRetailSecondary(train: TrainingRow[], validation: TrainingRow[]): Fitted {
  if (
    train.length !== JOINT_RETAIL_POLICY.train ||
    validation.length !== JOINT_RETAIL_POLICY.validation ||
    new Set(train.map((r) => r.up)).size !== 2 ||
    train.at(-1)!.labelKnownAt >= validation[0].issuedAt
  )
    throw Error("The locked retail training and validation cohorts are ineligible");
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

export function retailForecast(model: Fitted, control: number, candidate: number): Forecast {
  return {
    signal: predict(model.candidate, [control, candidate]),
    control: predict(model.control, [control]),
    base: model.base,
    coin: 0.5,
  };
}

export function scoreRetailSecondary(
  fund: RetailFund,
  fit: Fitted,
  test: { id: string; prediction: Forecast; up: number }[],
) {
  if (
    test.length !== JOINT_RETAIL_POLICY.test ||
    new Set(test.map((r) => r.id)).size !== test.length ||
    test.some(
      (r) => ![0, 1].includes(r.up) || Object.values(r.prediction).some((p) => !Number.isFinite(p) || p < 0 || p > 1),
    )
  )
    throw Error("Invalid sealed joint retail test");
  const mean = (name: keyof Forecast) => test.reduce((s, r) => s + (r.up - r.prediction[name]) ** 2, 0) / test.length;
  const comparators = (["control", "base", "coin"] as const).map((name) => ({
    name,
    brier: mean(name),
    ...pairedLossEvidence(
      test.map((r) => (r.up - r.prediction[name]) ** 2 - (r.up - r.prediction.signal) ** 2),
      JOINT_RETAIL_SHA + ":" + fund + ":" + name,
      JOINT_RETAIL_POLICY.alpha,
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
        (c) => c.meanImprovement > 0.01 && c.interval95[0] > 0 && c.pValue <= JOINT_RETAIL_POLICY.alpha,
      ),
    promoted: false,
  };
}
