import type { Horizon, Instrument, Snapshot } from "./types.ts";
import { asIssuedConsensus } from "./as-issued.ts";

export interface LogisticModel {
  intercept: number;
  weights: number[];
  means: number[];
  scales: number[];
  regularization: number;
}
export interface ActiveModel {
  id: string;
  instrument: Instrument;
  horizon: Horizon;
  trainedAt: string;
  labelsThrough: string;
  datasetHash: string;
  samples: number;
  featureSchema: "family-score-plus-observation-mask-v1";
  model: LogisticModel;
  testBrier: number;
  baselineBrier: number;
  testSamples: number;
}
export interface Forecast {
  instrument: Instrument;
  horizon: Horizon;
  probabilityUp: number;
  modelId: string;
  trainedAt: string;
  target: "next-session-open-to-horizon-close";
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
    if (
      active.trainedAt > snapshot.cutoff ||
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
      instrument: active.instrument,
      horizon: active.horizon,
      modelId: active.id,
      trainedAt: active.trainedAt,
      target: "next-session-open-to-horizon-close",
      probabilityUp: predict(active.model, features),
    };
  });
}
