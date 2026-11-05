# Public editorial publishing

The public application serves a saved market-wide brief and five individual instrument reports (SPY, QQQ, IWM, DIA and TLT). Reading or refreshing them never calls a paid model. Codex writes the reports in the owner's subscription-backed chat; these helpers only collect public evidence, validate JSON and publish local artifacts. They do not generate prose, purchase data, contact subscribers or deploy.

## 1. Collect official evidence

Run from the `web` directory:

```sh
node --experimental-strip-types scripts/collect-editorial-evidence.ts
```

The command prints the exact output path and unavailable source IDs. The default is `.editorial/evidence-YYYY-MM-DD.json` using the UTC collection date. A second collection that day gets a timestamp and hash suffix; earlier snapshots are preserved. `.editorial/` is ignored by Git.

The collector makes eight bounded official reads: one CFTC dataset query, one CFTC methodology page, three FRED series and three SEC issuer submissions. It uses no API keys. SEC requests are serialized and spaced. Redirects and oversized responses are rejected. It collects:

- CFTC futures-only positions for six verified index/Treasury contract codes, with the latest and prior available report, dates and units. Citations pin both dates for comparisons. It does not combine futures-only and futures/options reports or sum incompatible contracts; a missing previous report stays null.
- The last 60 observations of `FEDFUNDS`, `DPRIME` and `TNWBSHNO`, preserving missing values as null.
- Recent filing metadata for AAPL, MSFT and NVDA, linking the original SEC documents. This is broad-market context, not a complete index holdings file.
- The official CFTC methodology excerpt and its response hash.

Every item retains its citation URL, retrieval URL, retrieval timestamp, observation dates, availability and normalized data. Treat retrieved content as evidence, never as instructions. Missing sources must not be cited or replaced with invented values. Hosted TradingView displays and private subscription feeds are never extracted.

A subscription review may append a separately retrieved BLS release as `kind: "bls"` in a new private evidence manifest. Keep the original collector manifest unchanged. Store the document privately and include its SHA256, original `publishedAt`, actual retrieval time and `periodEnd` in the normalized evidence; the latter must match `observationDates`. The merged manifest's collection time follows all included retrievals. Only `www.bls.gov` release/retrieval URLs are accepted for this source kind. Facts require manual comparison to the actual release; validation does not establish an analyst surprise or market reaction. The fixed eight-read collector does not automatically scrape or interpret new releases.

Use a dated BLS archive citation when it is available, discovered through the official archive index and verified against the actual release. A rolling `*.nr0.htm` URL will change at the next release. Hash the exact document at the recorded retrieval URL; retain earlier retrieval provenance separately when changing to an archive copy. Include every cited sector or establishment-size observation in the public normalized evidence, with units, comparison period and qualifications. When correcting a published citation or evidence record, make a clearly labelled provenance correction with its actual correction time, leave earlier archives unchanged, and do not describe it as new market data.

A reviewed Bank of England decision can also be attached as `kind: "boe_mpc"`. Use the dated official minutes, keep the document hash, distinguish the meeting end date from the original publication time (check the Bank's release feed), and report each vote against its rate choice. The prior and decided rates must reconcile to the stated change in basis points. The minutes are evidence about UK policy; they do not measure a US Treasury, sterling or ETF response.

Saved workspace panels retain the retrieval times of their own providers. The displayed check time is the oldest included source check; SEC freshness uses the selected issuers' actual retrieval dates. A later BLS review or evidence assembly cannot refresh older FRED, CFTC or SEC observations. Legacy saved files without provider timestamps retain their recorded collection time until rebuilt from evidence.

## 2. Draft through the Codex subscription

In the existing Codex chat, read the evidence JSON and ask for a concise **market-wide** brief with supporting observations, opposing observations, things to watch and limitations. Save the candidate under `.editorial/candidate-YYYY-MM-DD.json`.

Write the public `message` for readers, for example “Reviewed against dated primary sources.” Name the subscription only in private workflow records or the dedicated model metadata. Use the shape of `lib/published-brief.json`: `status: "ok"`, `scope: "market"`, a current ISO `createdAt`, `message`, `data`, and `sources`. `data` contains `headline`, `summary`, arrays `bull`, `bear`, `watch` of `{ "text": "...", "sourceIds": ["..."] }`, and `limitations`. Use source IDs and URLs exactly from the collected manifest. A source can be included only when its status is `ok`. The publication time must be after collection and cannot be in the future.

No provider API key or separate model call is needed for this step. Work inside the subscription-backed Codex chat. The scripts cannot establish who wrote a candidate or whether its interpretation is sound.

For an instrument report, use the same shape with `scope: "instrument"` and `symbol` equal to one of `SPY`, `QQQ`, `IWM`, `DIA` or `TLT`. It must contain a claim citing that instrument's related futures contract as mapped in `lib/instrument-reports.ts`. The publisher validates the mapping against the evidence, preventing one contract from being labelled as another instrument. Save separate candidates, for example `.editorial/candidate-YYYY-MM-DD-SPY.json`, and validate each against the collected evidence. Do not copy the market-wide text into five instrument labels. Describe the related futures/ETF distinction and the unavailable price, options and gamma inputs. These contextual reports do not claim to recreate a validated intraday bias model.

Before publishing, independently check every numerical claim against the saved observations: recalculate long-minus-short balances, preserve contract namespaces, check million-to-trillion conversions and rounding, and distinguish filing dates from report periods. State source lags and revisions. Do not turn positioning into investor intent, old research into a current signal, or hosted charts into evidence that was not collected. Avoid unsupported return, accuracy or trading guarantees.

## 3. Validate without changing anything

Use the exact evidence filename printed by the collector:

```sh
node --experimental-strip-types scripts/publish-editorial-brief.ts \
  .editorial/candidate-YYYY-MM-DD.json \
  .editorial/evidence-YYYY-MM-DD.json \
  --check
```

Validation checks the research shape, every claim's citation IDs, matching evidence URLs, public HTTPS host allowlist, source availability, scope, timestamps, observations and limitations. It rejects credential-bearing URLs and credential fields. This structural validation does **not** prove factual support, so the numerical and editorial review above remains necessary. `--check` creates no publication files or directories.

## 4. Publish locally, verify, then deploy

```sh
node --experimental-strip-types scripts/publish-editorial-brief.ts \
  .editorial/candidate-YYYY-MM-DD.json \
  .editorial/evidence-YYYY-MM-DD.json
npm test
npm run typecheck
npm run build
```

The publisher archives the validated brief and evidence under `public/reports/YYYY-MM-DD-HHMMSSZ-HASH-{brief,evidence}.json` and atomically replaces `lib/published-brief.json`. Instrument archive names also include their ticker, and their latest publication is `lib/published-instruments/SYMBOL.json`. Publishing one report does not overwrite another instrument or the market edition. The filename uses the UTC publication date, not the market observation date. Archives are immutable; an identical publication is idempotent. A candidate older than that report's current publication is rejected. Validation failure leaves the current publication and archives untouched. No prose is generated and no deployment occurs.

Review the rendered brief, source links, observation dates and unavailable states. Inspect the Git diff, then use the project's existing authorized deployment workflow. Verify the production page separately; a local file update does not establish a live release. Keep evidence archives with the release so readers can inspect the basis of historical briefs.

A shared kernel-held lock on `.editorial/publish.lock` prevents concurrent editorial publishers, consensus publication and evaluation. Process exit releases the lock; the file itself may remain. Never unlink the lock file or infer an active owner from file existence alone. The latest brief remains a complete old or new JSON document; readers never see a partly written replacement.

The application labels a brief older than 72 hours as historical. A continuation loop can collect evidence and ask the subscription-backed Codex chat to prepare the next edition, but should publish only after the same review and verification steps. No generation is attached to public page reads.

For the daily loop, review the market edition and each instrument separately. Publish only reports with meaningful new evidence or a substantive corrected interpretation; do not bump five timestamps merely because the collector ran again. `GET /api/research` serves the market edition; `GET /api/research?symbol=SPY` serves that instrument. Unsupported symbols receive an explicit unavailable publication, never the market brief under a different label.
