# Frozen Canadian equity-flow research

This private historical experiment tested one new international input: nonresident net purchases of Canadian equity and investment fund shares, in CAD billions, from the latest named monthly column of each original Statistics Canada release. A positive SPY coefficient was fixed before return access. The relationship failed the declared gate and contributes no public vote.

The collector inspected 130 dated issue-chain entries from January 19, 2016 through October 16, 2026. It accepted 126 distinct original monthly values, covering November 2015 through August 2026. [Accepted dates and four exclusions](research/statcan-equity-flow-dates-v1.json) preserve the cohort. Two later-modified issues and two COVID-era exact-month/definition failures were excluded. The January 2016 PDF timing request returned 522 and was not repeated. The October 2026 original PDF prints 08:30 Eastern and reports an original server Last-Modified of 12:30:02 UTC on October 16. Historical eligibility uses the end of each printed original release day, followed by the first full US session with an 08:00 New York issue cutoff. No historical intraday availability is inferred.

The observations arrived 44–50 calendar days after reference month-end (median 47). Each release supplies one full-session SPY label; no monthly observation is repeated across daily labels. All targets are January 20, 2016 through October 19, 2026, before the first public forecast. The source's population includes Canadian common/preferred equity and investment-fund shares held by nonresidents, with direct investment excluded. It includes new issues, retirements and outstanding-security transactions. This is a broad Canadian cross-border flow measure.

Only original release tables are used. The original November 2015 foreign-equity value was CAD2,765 million in the [January 19 release](https://www150.statcan.gc.ca/n1/daily-quotidien/160119/t001a-eng.htm); the same prior-month field was CAD3,125 million in the [February 17 release](https://www150.statcan.gc.ca/n1/daily-quotidien/160217/t001a-eng.htm). The later historical column is not a new observation or an earlier known value.

The fixed controls were prior full-session SPY log(close/open), the Treasury 10-year yield change between the two preceding US sessions, and prior-date CAD appreciation against USD from the identical-date ECB USD/EUR and CAD/EUR reference-rate legs. Treasury and ECB controls use the established research policy's current official historical captures, with strict prior-date joins. Their values are retrospective control reconstructions. The initial 10-year ECB request timed out after 25 seconds. Annual overlapping chunks recovered the same series; one CAD annual timeout was recovered by two overlapping halves. Every chunk retains its digest, exact unit, date and A-status validation. Both canonical legs have 2,782 matching dates, December 21, 2015 through November 2, 2026. The USD/CAD joins retain 64/77 overlap confirmations respectively.

Six documented anonymous guest price captures supplied 2016–21, and five existing private raw-price receipts supplied 2022–November 2, 2026. This is internal Kibot research evidence. It does not establish public price-display rights or listing-market auction labels. No prospective outcome, reservation, public model, transaction or deployment was changed.

The unchanged historical `trainCandidate` policy produced 75 training, 25 validation and 26 chronological test rows. The test starts August 19, 2024 and ends October 19, 2026. The added flow had to improve test Brier by more than 0.01 over controls, the training base rate and 50/50, with a positive coefficient.

| Test measure | Result |
| --- | ---: |
| Controls Brier | 0.22659025499116286 |
| Controls plus flow Brier | 0.2625717244524497 |
| Training base-rate Brier | 0.24598290598290606 |
| Coin Brier | 0.25 |
| Flow coefficient | -0.30367419166547494 |

The result is sealed. No feature, date window, sign, horizon or margin was changed after the test.

## Offline replay

Keep the entire owner-only `.consensus/private-canada-equity-flows/` directory. The bundle's `replay-manifest-v1.json` names every required receipt with relative paths, including eleven price receipts, eleven Treasury receipts and twenty-two ECB captures. `replay-controls/` contains the small immutable references copied from other studies, so replay has no dependency on another worktree. Raw prices and source bodies are ignored private files and must not be committed.

Required core names are `frozen-candidate-v1.json`, `source-complete-v1.json`, `raw/`, `evaluation-inputs-v1.json`, `evaluation-started-v1.json`, `prelaunch-result-recovered-v1.json`, `ecb-canonical-controls-v1.json` and `replay-manifest-v1.json`, plus the paths enumerated by the manifest. Preserve the initial `prelaunch-result-v1.json`, `bulk-fx-timeout-receipt-v1.json` and `transport-recovery-policy-v1.json` as provenance. No new vendor request is needed.

From `web/`:

```sh
python3 -B tests/test-statcan-equity-source.py
node --experimental-strip-types --test tests/canada-equity-flow-research.test.ts
python3 -B scripts/collect-statcan-equity-flows.py --cached-only
node --experimental-strip-types scripts/replay-statcan-equity-flows.ts
```

For a bundle outside this checkout, both scripts accept `--private-root /absolute/private/bundle`. The collector defaults to cached-only verification. Network collection requires explicit `--collect`, the matching frozen receipt and `pdftotext` for the printed-time probes. Offline verification needs only Python3 and the existing Node runtime. The replay verifies source bytes/fields, matching control units and overlaps, independent calendar alignment, all 126 reconstructed rows and stored test predictions. It makes zero vendor requests and fits zero models. A changed or missing receipt fails closed.

| Immutable receipt | SHA256 |
| --- | --- |
| Frozen design | `6e4c905e16c774bc35bcc39e9e07dd8858f92d4c3fc960e3585c2d3dc5e3c2da` |
| Original source cohort | `0e641e1abff40566e60eac3b17b822146576dcd3026dc3f6c7210f4525537733` |
| Evaluated result | `cd143b969bd9ef2cca649ee9c76a21cbe834b9e7e55d71156ccd075f9f2208ed` |
| Portable private manifest | `f952e3293afd1af56948934c8f5ac55341246e03884168c6d320b1ff354366a6` |

Statistics Canada's [Open Licence](https://www.statcan.gc.ca/en/terms-conditions/open-licence) permits commercial reuse and value-added products with attribution and no endorsement. The selected fields are compiled government flow statistics; third-party stock-index values mentioned elsewhere in the releases are not features. Adapted from Statistics Canada, *Canada's international transactions in securities*, November 2015–August 2026, original issues January 19, 2016–October 16, 2026. This does not constitute an endorsement by Statistics Canada of this product.
