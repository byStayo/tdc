import { PREMARKET_STUDY_POLICY } from "./premarket-study-policy.ts";

export const ANALYST_STUDY_POLICY = {
  method: "prospective-us-rating-action-breadth-spy-v1", family: "analysts", instruments: ["SPY"],
  target: "SPY same full regular session from open to close. A strictly positive total return is up, zero is down.",
  inputs: "Quantisnow's independently dated US-stock rating-action counts, published as CC BY 4.0 market aggregates. Compare two consecutive calendar mornings in the same UTC reporting month, each an ordinary 390-minute exchange session. Require the fund's current morning and the preceding morning to have separate publicly witnessed editions containing that morning's native release. Use the last pre-open edition on the prior session. All four cumulative action counts must be nondecreasing. Candidate equals (added upgrades minus added downgrades) divided by their sum. Control is (prior month-to-date upgrades minus downgrades) divided by their sum. Both denominators must be positive. Exclude holiday, weekend, early-close and month-boundary intervals. These count differences can include provider revisions and describe its covered US stocks; they do not identify individual rating actions or SPY holdings.",
  enrollment: "The target morning's provider update must follow registration. Verify both original JSON responses against the issued archive hashes and published figures, first captured by their respective edition cutoffs. Sign the candidate before entry. One source pair per SPY target. A newly downloaded older release cannot add a past example.",
  custody: PREMARKET_STUDY_POLICY.custody, partition: PREMARKET_STUDY_POLICY.partition, model: PREMARKET_STUDY_POLICY.model,
  inference: "One fixed positive-direction SPY hypothesis. Compare against prior cumulative rating breadth, the training prevalence and 0.5. Require all three Brier improvements above 0.01, all paired block-bootstrap 95% lower endpoints above zero and one-sided p values at most 0.01/(15*3), allowing for fifteen families. This research has no automatic effect on the consensus.",
  train: 300, validation: 100, test: 100, alpha: 0.01 / (15 * 3),
} as const;
