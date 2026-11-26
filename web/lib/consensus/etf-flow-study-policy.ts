import { PREMARKET_STUDY_POLICY } from "./premarket-study-policy.ts";
import { FLOW_FUNDS } from "./etf-flow-peers.ts";

export const ETF_FLOW_STUDY_POLICY = {
  method: "prior-session-etfiq-flow-with-peer-breadth-v1", family: "capital", instruments: FLOW_FUNDS,
  target: PREMARKET_STUDY_POLICY.target,
  inputs: "Use only the immediately preceding completed exchange session's ETFIQ flow date, with the native prior NAV date equal to the session immediately before that. Match the native single-session fund row to its individual ETFIQ history in dollars, NAV date, economic date, category and identity. Candidate is the computed net flow as a percentage of prior net assets. Control is (number of inflows minus number of outflows) divided by the number of all other eligible funds in its ETFIQ Stocks or Bonds category. Keep genuine zero-flow peers in the denominator and exclude held, multi-session, missing-category and own-fund rows.",
  enrollment: "Before entry, require the final publicly witnessed morning forecast, with both native documents verified by its cutoff. Replay the saved permitted fields against the edition commitment. Only admit inputs first received after registration and the completion of their economic session. Never move a late published or revised flow into a later target. One target per fund and source date.",
  custody: PREMARKET_STUDY_POLICY.custody, partition: PREMARKET_STUDY_POLICY.partition,
  model: PREMARKET_STUDY_POLICY.model,
  inference: "Five private ETF comparisons, three baselines apiece. Require positive continuation coefficient, each Brier improvement over 0.01, all paired block-bootstrap 95% lower endpoints positive, each one-sided p at most 0.01/(5*3). No automatic vote, trade, public probability or reuse of an existing core holdout.",
  train: 300, validation: 100, test: 100, alpha: 0.01 / (5 * 3),
} as const;
