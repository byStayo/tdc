# The visual morning consensus product

The user wants to open the site with morning coffee and understand the complete market setup visually, without a separate preparation session. The original Bias Report is the semantic reference. Build an interactive product, not a screenshot, prose archive or chatbot.

## Acceptance matrix

| Domain | Required behavior |
| --- | --- |
| Social | Separate X, Instagram and retail-community samples; sentiment distribution, volume, disagreement, date and sample limitations; no claim of platform-wide sentiment from selected posts. |
| Institutions | CFTC category positioning, original filings and off-exchange flow where authorized; category positions are not named-investor intent. |
| Options | Put/call context, OI, volume, IV/term/skew, gamma assumptions, OPEX and expiry timing; dealer positioning never inferred as known from unsigned OI. |
| Binary events | Dated catalysts and prediction-market probabilities with volume/liquidity and outcome wording; prices are not certain probabilities. |
| Analysts/news | Source-linked analyst revisions and news clusters, sampled sentiment and deduplication; no copyrighted full-article republication. |
| Price/technicals | Premarket gap/range, trend, momentum, breadth, volatility, Fibonacci, pivots/support/resistance, and completed opening range; wait for required sessions/observations. |
| Earnings | Company dates, filings, financial changes, expectations versus actual when available and guidance; sample coverage explicit. |
| Macro/flows | Rates, Treasury curve, bond context, liquidity components, capital/private-equity flows and source lags. |
| International | FX, international market context and central-bank policy/news with local release calendars. |
| Consensus | Separate independent source families, cap correlated technical votes, visible weights, disagreement, completeness and abstention. Do not call heuristic agreement a probability of profit. |
| History | Immutable as-issued snapshots with versions, source hashes and cutoff; historical reconstruction separately labelled and never backdated as issued. |
| Evaluation | Realized daily/weekly/monthly outcomes against predeclared horizon/baseline; direction accuracy, calibration, abstention and sample count. |
| Improvement | Chronological training/validation/test, embargo overlapping horizons, baseline comparison, minimum samples, versioned promotion gates and rollback. No claim that retraining guarantees improvement. |
| Operations | Subscription publication loop, bounded collection/retries, locks, atomic writes, source outages, reproducible builds and production verification. |

## UI constraints
Existing Next16/React19 stack, local design tokens and brand. Dense enough to scan, spacious enough to understand. Original visual primitives become accessible SVG charts, contribution bars, sparklines and source details. Daily default; weekly/monthly and historical dates are first-class views. Missing inputs stay distinguishable from neutral observations. A single morning verdict must show its coverage beside it. Readers may inspect every contribution. Preserve reduced motion, contrast,390px layout,44px controls and keyboard access.

## Current evidence ledger · November3

| Requirement | Actual evidence | Remaining boundary |
| --- | --- | --- |
| Visual morning view | Responsive live board, six instruments, three horizons, source drawers, Treasury/liquidity/FX/positioning/news charts, calendar and history. Jev decisions saved. | Price levels/options/social panels need real permitted inputs. |
| Social/retail | Gated Bluesky collector with private removal controls, expiry and approved support contact; actual five-account capture withheld below the ten-account gate. Official six-pair Myfxbook hosted display with explicit loading and current-only isolation; see build ledger for release verification. | No public qualifying Bluesky sample, live X/Instagram or representative retail feed. Hosted FX values are outside consensus/model inputs. |
| Institutions | 12 CFTC futures-category observations; original current/prior-quarter Berkshire and Bridgewater filings, reconciled and displayed as dated allocations. FINRA private collector/query/parser and failure tests. | FINRA credential requested; public display conditions still apply. No claim of live dark-pool buying/selling. |
| Options and technicals | OPEX dates; tested IV/gamma/Fibonacci/pivot/range calculations; current hosted price/technical displays in the morning view, separated from saved evidence. | No validated redistributable US price/option chain. Math functions are not a live integration. |
| Binary/news/analysts | 35 upcoming official calendar events, a 48-story news sample from the November 3 17:00 UTC batch and four primary-source developments, including the September JOLTS release, with separately labelled instrument-specific interpretation. | Broader coverage, analyst revisions and prediction probabilities remain missing. Reviewed news is bounded context with no extra directional vote. |
| Earnings | Three issuer-confirmed upcoming results schedules, with release windows distinct from webcast times. Three selected company revenue observations; Apple and Microsoft GAAP EPS with comparable prior-year figures. Two separately dated management revenue outlooks from Microsoft and NVIDIA, with source-linked ranges, assumptions and review-due checks. | Index-wide earnings calendar, EPS surprises and analyst expectations remain missing; management guidance covers only two companies and is not a scored prediction. |
| Macro/international |12 FRED government series, seven ECB FX crosses, four official policy feeds, four daily policy-rate series, a reviewed Japan target and Treasury SLT cross-border flows. Fed private-debt-fund transactions add six quarters of loan-flow context, two related measures, dated release evidence and explicit SAAR/estimate flags. | International equity prices and daily private-equity investment flows remain missing. The Fed source is quarterly private credit, with inputs through2026Q1 and an estimated2026Q2. UK/ECB/Japan local-date decision calendars and separately labelled Japan minutes/opinions are connected. SEC private-equity assets remain separate old/stale context. |
| Consensus/history | Equal capped families, visible coverage, abstention and immutable hashed editions. | Rules2 separates about55% observation coverage from20% daily MARKET directional coverage (3/15 families); all18 trading verdicts are withheld. Quarterly earnings and standing daily CFTC levels are nonvoting context. Weekly/monthly selectors are context windows, not qualified return forecasts. |
| Evaluation/improvement | Per-horizon total-return outcomes, one edition per entry session, chronological evaluation, hash-linked prospective test reservations, incumbent comparison and audited compatible-model rollback. Independently checked 2026 sessions; uncovered horizons remain pending. Nine actual ECB historical experiments. | No resolved prospective labels or promoted model; none of nine experiments beat the declared gate. No overnight invented track record. |
| Operations | Subscription weekday publisher and build heartbeat active; shared kernel-held publication lock, recoverable publication/evaluation writes and remote-release ledger/artifact verification; latest verified observations retained through transport failure without refreshing their age. | Full goal remains open until real integrations and behavior pass the matrix. |

## Model and publication rules
No paid-model request on a page read. Separate collection, deterministic calculations, semantic annotation, consensus, publication and later evaluation. Save every input timestamp and model version. Use actual daily publications to learn prospectively; reconstructed history is a separate research dataset. Initial rule weights are declared priors, not learned reliability. Do not claim all requirements complete until real integrations and end-to-end behavior are verified; list blocked sources explicitly.
