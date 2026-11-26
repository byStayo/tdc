import { PREMARKET_STUDY_POLICY } from "./premarket-study-policy.ts";

export const TWSE_SECTOR_STUDY_POLICY = {
  method: "as-issued-twse-semiconductor-minus-taiex-qqq-v1",
  family: "international",
  instruments: ["QQQ"],
  target: PREMARKET_STUDY_POLICY.target,
  source:
    "Taiwan Securities and Futures Bureau, Financial Supervisory Commission. Taiwan Stock Exchange after-market statistics (OGD 11555) and exchange holiday calendar (OGD 11761), Open Government Data License 1.0. Use the native dated catalogue CSV and dated original TWSE price index table. The two formats describe the same Taiwan closing session. https://data.gov.tw/dataset/11555 and https://data.gov.tw/dataset/11761.",
  inputs:
    "The signed semiconductor price-index daily percentage change minus the signed TAIEX price-index daily percentage change, in percentage points, is the candidate. The same dated TAIEX percentage change is the control. Reject changed identities, direction/level mismatches, special flags, missing native controls and calendar gaps.",
  enrollment:
    "Use the exact Taiwan date corresponding to the immediately preceding completed U.S. trading session. Skip a closed Taiwan date, an unknown intervening U.S. date and a shortened U.S. target. The 09:00 Asia/Taipei source session must BEGIN after the actual host registration. Receive both dated market originals after the 13:30 Asia/Taipei close, with the verified Taiwan calendar available by the original issue cutoff. Enroll the final publicly witnessed same-morning U.S. edition strictly before its open. A source date can enter once. No historical source, known November 24 exploratory result, retroactive decision or revisions can enroll.",
  custody: PREMARKET_STUDY_POLICY.custody,
  partition: PREMARKET_STUDY_POLICY.partition,
  model:
    "Use standardized logistic regression of TAIEX and semiconductor spread versus TAIEX alone, training-only prevalence and 0.50. Require strictly positive incremental spread coefficient. Use 600 gradient steps, penalties 0.01, 0.1, 1, 10, lowest validation Brier, first on ties.",
  inference:
    "Require more than 0.01 Brier improvement against all three comparators, every paired block-bootstrap 95% lower bound positive, and each one-sided p at most 0.01/(15 families * 5 funds * 3 comparisons). One fixed QQQ study. No automatic promotion or reuse of earlier core reservations.",
  train: 300,
  validation: 100,
  test: 100,
  alpha: 0.01 / (15 * 5 * 3),
} as const;
