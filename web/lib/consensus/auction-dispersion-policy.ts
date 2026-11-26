import { PREMARKET_STUDY_POLICY } from "./premarket-study-policy.ts";

export const AUCTION_DISPERSION_POLICY = {
  method: "prospective-tlt-treasury-award-dispersion-v1",
  family: "events",
  instruments: ["TLT"],
  target: PREMARKET_STUDY_POLICY.target,
  inputs:
    "One fixed-rate US Treasury nominal 2-, 3-, 5-, 7-, 10-, 20- or 30-year note or bond auction followed by the next full TLT session. Candidate equals minus the change in the high-minus-median competitive accepted yield spread (basis points) relative to the median of the three immediately preceding monthly auctions of the same original tenor. Control equals the change in the bid-to-cover ratio versus the median of those same three auctions. Retain new issues and reopenings, exclude FRNs, TIPS, bills, noncompetitive releases and shared target dates. Yield dispersion describes successful bids within one auction. It is neither a when-issued tail nor a traded probability.",
  source:
    "Identify the complete eligible issue set in the first admissible TreasuryDirect announcement catalogue. Reconcile auction identity, dates, competitive close, original tenor, reopening and result-file identity against a second official result delivery; reparse the four native competitive result XMLs, including the actual publication time or evidenced contemporaneous release ceiling. Normalize the two documented XML generations and reject a changed source fingerprint. Capture clocks are actual and distinct from publication. Official sources https://www.treasurydirect.gov/auctions/announcements-data-results/ and https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/.",
  enrollment:
    "Freeze features before reading any TLT targets and before acquiring this panel of auction results. Enrollment can only occur after policy registration in the first scheduled 390-minute target session strictly after the auction date. Skip exchange holidays and shortened sessions, never skip unknown calendar dates. The auction and its original publication must precede the target opening bell. A previously released auction can inform a still-future session only if its selection and private source receipt are prospectively sealed after study registration and before the selected public issue cutoff. Confirm the exact public morning edition and its matching contemporaneous announcement-catalogue receipt before entry. An omitted recent auction, multiple eligible auctions sharing the same target, a later clock, revision or incomplete baseline cannot shift the target.",
  custody: PREMARKET_STUDY_POLICY.custody,
  partition: PREMARKET_STUDY_POLICY.partition,
  model:
    "At a given bid-to-cover change, a wider-than-recent upper award-yield spread is hypothesized to precede softer TLT performance. Require a positive fitted coefficient on the negatively signed spread change. Compare the combined model against the same-tenor coverage control, training prevalence and 0.5. Use 600 gradient steps and the fixed validation-selected penalties 0.01, 0.1, 1 and 10. Do not reverse the sign or select a tenor after seeing labels.",
  inference:
    "For all three comparators require more than 0.01 held-out Brier improvement, strictly positive paired block-bootstrap 95% lower bounds and each one-sided p <= 0.01/(15*5*3). Preserve all core reservations and all other studies. One private prospective TLT test, no automatic vote or public prediction.",
  train: 300,
  validation: 100,
  test: 100,
  alpha: 0.01 / (15 * 5 * 3),
} as const;
