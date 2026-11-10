# Free signal completion implementation plan

**Goal:** Complete the existing acceptance matrix with authentic free sources, a functioning outcome/validation pipeline, and verified live releases.
**Architecture:** Keep collection separate from public reads. Add bounded, source-specific parsers and provenance contracts, immutable editions and explicit missing observations. Preserve the frozen voting engines, historical outputs, validation thresholds and holdout reservations.
**Tech stack:** Existing Next.js 16/React 19/TypeScript and native Node test runner.
**Spec:** `web/docs/VISUAL_PRODUCT.md`, owner instruction November 9: continue autonomously, free sources, whole product end to end.
**Execution:** Native in this chat. Owner's explicit autonomous continuation overrides the planning workflow's optional approval handoff. Reuse the November 9 efficiency audit.

## Constraints and review focus

- No subscriptions, paid feeds/model calls, external messages, fabricated history or retroactive as-issued predictions.
- Data access, public display and retained/model use must each match the source's actual terms.
- Never downgrade the existing prospective model gates merely to activate a model.
- Prevent duplicate publication/deployment; use the existing kernel publication lock.
- Review: absent rows versus real zero; changed licences/schemas; partial/outdated observations; historical isolation; future/unsupported outcome dates.

## Deliverable 1: free dated ETF flow integration

- [x] Add failing tests in `web/tests/consensus-etf-flows.test.ts` for the actual November 6 QQQ/IWM/TLT flows, missing SPY/DIA, held rows, duplicates, future dates, changed licence, corrupt hashes and invalid arithmetic. Prove restricted NAV/assets/share fields do not reach public signals.
- [x] Implement `collectEtfFlows(read, now): Promise<Signal[]>`, `validateEtfFlows(signal)` and `refreshEtfFlows(previous, read, now)` in `web/lib/consensus/etf-flows.ts`. Keep all horizons nonvoting. Source: https://etfiq.com/data/flows/daily/latest.json; licence: https://etfiq.com/license/ (computed fields only).
- [x] Add the reviewed host to source transport/citation allowlists; integrate full and scoped collection/publishing with stable signal order. Existing unavailable price/options/social requirements stay accurate.
- [x] Render saved per-instrument/market flow cards with dates, missing/held states, attribution and limitations. Historical editions use only their saved flow signals.
- [ ] Run focused negative tests, full tests/typecheck, a bounded actual source collection and 375/1440px interaction checks. Publish an immutable scoped edition, build, commit, deploy, and verify public JSON and rendered values.

## Deliverable 2: prices, corporate actions and outcomes

- [ ] Continue primary-source audit for free US historical/ongoing price evidence, corporate actions and retained/model rights; keep exact transport failures and controlling terms.
- [ ] Once a source qualifies, pin price basis and calendar scope before outcomes; add failing parser/calendar/adjustment/stale tests and bounded collection. Preserve the existing next-open-to-horizon-close total-return contract; alternatives require separate predeclared cohorts, never rewritten outcomes.
- [ ] Run the real evaluator under its lock and transaction journal; commit every resulting ledger/artifact/reservation consistently. Publish actual resolved/pending counts and baseline results. No qualified model is promised before genuine sufficient evidence exists.

## Deliverable 3: other remaining sources and operational completion

- [ ] Resolve options, premarket, social/retail, binary probabilities, analyst expectations, international equities and private-capital gaps against the acceptance matrix; implement each verified free route with source-specific tests and accurate coverage.
- [ ] Exercise collection → publication → forecast/outcome evaluation → deploy → reader/history as one reproducible flow. Verify outages/recovery and refresh operations; coordinate the existing publisher instead of duplicating it.
- [ ] Obtain a fresh-context whole-change review, resolve findings, and keep this goal active until the objective is achieved or a repeated external blocker is established. Maintain the handoff as the execution ledger.

Execution ruling: preserve the established analyst/TWSE/private-credit tail; insert ETF flow identities before it in both paths. The existing order regression remains unchanged. Independent review identified an all-excluded aggregate falsely presented as zero; a failing test reproduced it, and both live aggregation and saved validation now require positive observed-fund coverage. Final production receipt remains pending.
