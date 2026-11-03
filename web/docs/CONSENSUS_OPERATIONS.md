# Visual consensus publication and evaluation

This extends the prior editorial publication. The full user goal remains open. A responsive interface and unconnected feed cards are not completion of the requested product.

## Commands

- `npm run consensus:collect`: bounded official-source collection into private `.consensus/last-collection.json`; no public change.
- `npm run consensus:publish`: validate, attach any qualified active model, archive a new immutable snapshot, and atomically replace the current edition. Re-fetching identical observations does not create an edition. Shares `.editorial/publish.lock` with editorial publishing and evaluation.
- `npm run consensus:review`: attach the saved, source-checked editorial review to the existing data without refetching providers. Publish only if the facts or interpretations changed. Source observation/retrieval dates remain intact; this is not a new market-data collection.
- `npm run consensus:evaluate`: preserve existing outcomes; calculate per-target performance and candidate eligibility. With no price evidence it records an explicit pending state.
- `npm run consensus:evaluate -- --prices /absolute/private/approved-prices.json`: score new resolved outcomes using a reviewed price feed and complete exchange-calendar evidence. File is an array of `PriceEvidence` contracts from `lib/consensus/evaluation.ts`. Source must be a public HTTPS citation without credentials; adjustment is unadjusted, split-adjusted or total-return-adjusted. Keep the raw evidence private and record the provider's actual display and training permissions before use.
- `npm run consensus:research-fx`: optional fixed research experiment from the official ECB historical XML saved privately as `.consensus/ecb-history.xml`. Uses approximately 3,000 recent reference fixes. This is latest-vintage reconstruction, never an as-issued equity track record. Do not tune against the held-out test after seeing its results.
- `npm run consensus:finra-private`: authenticated private verification after secure free-Public credential setup. No public publication. See `FINRA_SETUP.md` for the distribution boundary.
- `npm test`, `npm run typecheck`, `npm run build`: build automatically verifies current/archived snapshot hashes, chronology and active model artifacts.

## Promotion and rollback

The subscription publisher maintains `lib/consensus/reviewed-developments.json` after reading actual primary releases. Each source keeps its URL, original publication date (date-only where no time is supplied), actual retrieval time and SHA256 of the privately retrieved document. Save short factual paraphrases and separately labelled instrument-specific transmission channels, with explicit unknowns. Never infer a market reaction or analyst beat from positive company growth. Keep source documents private; do not copy full releases. A future timestamp, unapproved source host, missing citation, mismatched company or conflicting same-quarter revenue blocks publication.

The morning view displays up to three scoped developments. News reviews carry no directional score, avoiding an extra vote for the same earnings or rates fact. Seven-day freshness controls coverage; older reviews remain dated context. A newer company quarterly statement may supersede an older SEC revenue observation and add GAAP EPS. Its chart contains only the current and comparable year-earlier quarter. A later-period SEC filing supersedes that saved release; a conflicting same-period value requires factual review. Review timestamps alone do not create an edition. Historical snapshots retain their original evidence and are never enriched retroactively.

Prospective models are separate for each supported instrument and horizon. At least 120 resolved observations are required. Chronological 60/20/20 splits purge labels extending across a boundary. Normalization is trained only on the training split. Regularization is selected using validation; test data evaluates the fixed choice. Candidates must beat the base rate, 50/50 and incumbent by 0.01 Brier. Replacing an incumbent requires at least 20 newly resolved labels. Historical FX experiments cannot activate these models.

The evaluator archives candidate and active-model artifacts and updates the registry only when gates pass. Future snapshots freeze model ID, training time and probability. Historical outcomes retain their original model and price basis. To roll back, select a previously archived compatible active model, record the reason and change the registry under the shared publication lock; do not rewrite old snapshots or outcomes.

## Release discipline

The restoration and weekday publisher share one chat. Do not deploy a dirty or concurrently edited tree. Collect/evaluate, inspect changed evidence, run relevant checks and real-browser QA, commit the authorized branch, deploy with the existing Vercel project, then verify normal public HTTPS and the browser. Record deployment ID, commit, health, coverage and limitations in `../VISUAL_BUILD_STATUS.md`.

Private collection probes, historical experiment models, raw prices and backups stay outside Git/deployment. `.consensus` is excluded by both Git and Vercel. Original recovery backups remain outside `web/`. No page view calls a provider or model to generate a consensus. The weekday automation uses the Codex subscription for editorial review; the public server serves saved artifacts.

## Current verification boundary

The November3 reviewed-news increment has65tracked inputs:52current observations, one stale SEC private-equity aggregate and12missing inputs. Weighted requested coverage is about53%; the consensus abstains. Cross-border Treasury flows, GDELT financial-news tone, three reviewed primary developments and BLS/FOMC/Treasury/OCC calendars are connected. Missing US prices/options, social/retail, analyst estimates, off-exchange and actual private-equity investment flows remain material gaps. FINRA private integration is tested with fixtures but awaits the user's free Public credential; it is not live coverage. Nine real ECB currency-history candidates were evaluated; none passed the declared improvement threshold. No prospective outcome or active model is claimed.

After a provider failure, the collector can retain a previously verified numeric series or news batch. It preserves the observation/retrieval dates, source hash and methodology, adds a visible refresh notice, and retains the collection error. Existing stale limits continue to apply. Calendar events are not revived through this fallback. A failed refresh alone cannot create a new edition. Outcome evidence requires canonical UTC timestamps aligned with the named New York session date; mixed-offset string comparisons cannot silently assign a wrong outcome.
