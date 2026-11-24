import type { TrainingRow } from "./learning.ts";
import { fitSecondary, scoreSecondary, type Fitted, type Forecast } from "./secondary-study-model.ts";
export { secondaryForecast as retailForecast } from "./secondary-study-model.ts";
export type { Fitted, Forecast, Phase } from "./secondary-study-model.ts";
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

export function fitRetailSecondary(train: TrainingRow[], validation: TrainingRow[]) {
  return fitSecondary(train, validation, JOINT_RETAIL_POLICY);
}
export function scoreRetailSecondary(fund: RetailFund, fit: Fitted, test: { id: string; prediction: Forecast; up: number }[]) {
  return scoreSecondary(fund, JOINT_RETAIL_POLICY, JOINT_RETAIL_SHA, fit, test);
}
