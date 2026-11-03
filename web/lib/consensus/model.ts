import type { Horizon, Instrument, Snapshot } from "./types.ts";
import { asIssuedConsensus } from "./as-issued.ts";
import type { PromotionEvidence } from "./learning-audit.ts";
import { OUTCOME_PRICE_BASIS, requireOutcomePriceBasis } from "./price-basis.ts";

export interface LogisticModel {
  intercept: number;
  weights: number[];
  means: number[];
  scales: number[];
  regularization: number;
}
export interface ActiveModel {
  id: string;
  engineVersion: string;
  instrument: Instrument;
  horizon: Horizon;
  trainedAt: string;
  labelsThrough: string;
  datasetHash: string;
  samples: number;
  featureSchema: "family-score-plus-observation-mask-v1";
  priceAdjustment: typeof OUTCOME_PRICE_BASIS;
  model: LogisticModel;
  testBrier: number;
  baselineBrier: number;
  testSamples: number;
  promotionEvidence?: PromotionEvidence;
}
export interface Forecast {
  engineVersion: string;
  instrument: Instrument;
  horizon: Horizon;
  probabilityUp: number;
  modelId: string;
  trainedAt: string;
  target: "next-session-open-to-horizon-close";
  priceAdjustment: typeof OUTCOME_PRICE_BASIS;
}
export function predict(model: LogisticModel, features: number[]) {
  if (
    features.length !== model.weights.length ||
    model.scales.length !== features.length ||
    model.means.length !== features.length ||
    !features.every(Number.isFinite) ||
    !model.weights.every(Number.isFinite) ||
    !model.means.every(Number.isFinite) ||
    !Number.isFinite(model.intercept) ||
    !model.scales.every((n) => Number.isFinite(n) && n > 0)
  )
    throw new Error("Feature schema mismatch");
  const value =
    model.intercept +
    model.weights.reduce(
      (sum, weight, i) =>
        sum + (weight * (features[i] - model.means[i])) / model.scales[i],
      0,
    );
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}
export function forecastSnapshot(
  snapshot: Snapshot,
  models: ActiveModel[],
): Forecast[] {
  return models.map((active) => {
    requireOutcomePriceBasis(active.priceAdjustment);
    if (
      active.trainedAt > snapshot.cutoff ||
      active.engineVersion !== snapshot.engineVersion ||
      active.labelsThrough >= active.trainedAt ||
      active.featureSchema !== "family-score-plus-observation-mask-v1"
    )
      throw new Error("Model time or feature contract violation");
    const consensus = asIssuedConsensus(
      snapshot,
      active.instrument,
      active.horizon,
    );
    const features = consensus.families.flatMap((family) => [
      family.score ?? 0,
      family.score === null ? 0 : 1,
    ]);
    return {
      engineVersion: active.engineVersion,
      instrument: active.instrument,
      horizon: active.horizon,
      modelId: active.id,
      trainedAt: active.trainedAt,
      target: "next-session-open-to-horizon-close",
      priceAdjustment: active.priceAdjustment,
      probabilityUp: predict(active.model, features),
    };
  });
}
