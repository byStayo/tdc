export const PREMARKET_STUDY_POLICY = {
  method: "prior-full-session-premarket-continuation-v1",
  instruments: ["SPY", "QQQ", "IWM", "DIA", "TLT"],
  family: "premarket",
  target: "Same ETF, next ordinary 390-minute session, binary regular open-to-close total return strictly positive; zero is down.",
  inputs: "Use the immediately preceding ordinary session and require an ordinary target session. Candidate is the as-issued 04:00 through 09:29 Eastern change rounded to one decimal percent. Control is that same session's regular close-position quintile minus three. No target-day tape, proxy instrument, raw prices or later revisions.",
  enrollment: "Use the original as-issued edition verified publicly on the target morning. Replay both inputs from the exact native private originals available at the edition cutoff. Record and witness the forward decision after registration on the target morning and before the entry open, including when the source or original public issue preceded study registration. Settle only the final qualifying public edition before that open. Each fund and target date counts once.",
  custody: "Only the first independently qualified native core settlement, with actual intake time, private only. FirstRate for the four equity funds, Market History for TLT, or authorized licensed MarketParquet or subscriber Kibot. Exclude guest and manual prices, legacy label replay, and pre-existing overlapping core reservations. Later core reservations remain intact.",
  partition: "For each ETF, freeze the first 300 qualified training targets ordered by session among those known at freeze. Accept validation decisions after that freeze only. Freeze 100 qualified validation targets and the fitted models before any test decision. Sign every test probability before its entry open. Select 100 session-ordered test windows with each next study decision strictly after the prior accepted label. Freeze all test identities before opening any test labels. Each partition is immutable and has one attempt.",
  model: "Compare standardized logistic regression of control and candidate against control alone, the training prevalence, and 0.5. Use 600 gradient steps, regularization 0.01, 0.1, 1, 10, lowest validation Brier, first on ties. Preregister a strictly positive candidate coefficient for continuation. No feature, sign, or fund substitution.",
  inference: "One private secondary study per fund, three paired comparisons each. Require all three Brier improvements above 0.01, paired block-bootstrap 95% lower endpoints above zero and one-sided p at most 0.01/(5*3). No automatic promotion, public predictions, intervening test inspection or change to production alpha or holdout reservations.",
  train: 300, validation: 100, test: 100, alpha: 0.01 / (5 * 3),
} as const;

export const PREMARKET_STUDY_SHA = "31f248e25d4fc9e2071c6790a0ede56075a0dab664fc6ef317ba9030a064517c";
