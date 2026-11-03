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

## Model and publication rules
No paid-model request on a page read. Separate collection, deterministic calculations, semantic annotation, consensus, publication and later evaluation. Save every input timestamp and model version. Use actual daily publications to learn prospectively; reconstructed history is a separate research dataset. Initial rule weights are declared priors, not learned reliability. Do not claim all requirements complete until real integrations and end-to-end behavior are verified; list blocked sources explicitly.
