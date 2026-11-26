# Treasury regional stress and DIA

This historical comparison tested whether a fall in stress outside the United States helped predict a positive DIA regular session, after accounting for the U.S. contribution to the same index. The question, sign, input sources and error threshold were registered before reading the outcomes. Treasury attributes its other advanced economy measure primarily to the eurozone and Japan and reports a separate emerging-market contribution. [Official regional measures](https://www.financialresearch.gov/financial-stress-index/regions/)

| Source selection | Eligible targets | Result |
| --- | ---: | --- |
| Four-decimal component consistency check, 2022 onward | 45 | The source reported three decimals. Rounding the three contributions and the headline to that precision can produce a 0.001 difference. |
| Native precision, all verified releases from the first full calendar year | 109 | Only two additional target dates came from the 23 verified pre-2022 Treasury captures. Twenty arrived earlier than the specified two-federal-business-day lag. |
| Separately registered test that holds early verified originals until the observation matures | 147 | All 109 earlier selections survived unchanged. The 38 added Internet Archive and Library of Congress records had independent public clocks. Each added target was the first trading session after the second federal business day. Shortened sessions were excluded. The original public clock and the date the project could use the reading remain separate. |

The 147 dates comprise 110 original Treasury files and 37 independently timestamped copies. Forty overlapping economic dates matched on all three regional contributions. An early mirror implementation omitted the regional inputs. Its 40 captures were excluded. The historical inputs span changes to benchmark interest rates. [OFR original launch](https://www.financialresearch.gov/from-the-director/2017/10/25/the-ofr-introduces-financial-stability-index-and-financial-vulnerabilities-monitor/) · [Verified June 2023 benchmark-transition paper correcting the ancillary URL in the sealed supplementary registration](https://www.financialresearch.gov/working-papers/2023/06/27/transition-alternative-reference-rates-in-ofr-financial-stress-index/)

The 88 training, 29 validation and 30 test sessions all precede the first published forecast. Each selected full-session positive/negative outcome agreed across the private as-traded and split-only DIA receipts. Holding out September 21 through November 2, 2026 gave Brier scores of 0.2743 with foreign stress, 0.2705 with U.S. stress alone, 0.2686 for the training up-rate and 0.2500 for a constant 50% probability. The coefficient for falling foreign stress was positive. Mean improvement against the U.S.-only model was −0.0038, with a descriptive 95% moving-block interval from −0.0119 to +0.0048. The one-sided paired-block p-value was 0.8135 and its Bonferroni adjustment was 1.0000. This result earns zero directional votes.

That adjustment covers 29 existing public study slots and three regional registrations, with three prespecified comparisons in each slot. The discrete check enumerates the 1,024 sign assignments of ten matched blocks. It assumes signs are exchangeable across blocks. Additional private investigations fall outside this declared comparison set. These capture dates overlap other retrospective research.

## Reproduce privately

From `web`, use the existing owner-private directories. The source and outcome hash checks run offline against previously captured files. The archive collector can also retrieve the 23 registered early Treasury originals from their exact public Internet Archive replay URLs. It refuses a mismatched body, timestamp or redirect. A failed or varied input keeps the signed result pending. The earlier combined Treasury vintage inventory is required for replay. The separate output names retain all earlier selections.

```sh
price_root="$PWD/.consensus"
regional_study="$price_root/private-ofr-geography"
treasury_vintages="$price_root/private-ofr-volatility"

python3 -B scripts/collect-ofr-geographic-archives.py "$regional_study"
python3 -B scripts/qualify-ofr-geographic.py --source-root "$treasury_vintages" --output "$regional_study/source-selection.json"
python3 -B scripts/qualify-ofr-geographic.py --source-root "$treasury_vintages" --native-precision-archives "$regional_study" --output "$regional_study/supplement-final-selection.json"
python3 -B scripts/qualify-ofr-geographic.py --source-root "$treasury_vintages" --native-precision-archives "$regional_study" --after-maturity --output "$regional_study/maturity-source.json"
python3 -B scripts/replay-ofr-geographic-v1.py "$regional_study" "$price_root"
python3 -B scripts/verify-ofr-geographic-outcome.py "$regional_study" "$price_root"
python3 -B tests/test-ofr-geographic.py
node --experimental-strip-types --test tests/consensus-ofr-geographic.test.ts tests/kibot-research.test.ts
```

The `--score-once` option created the original private result after the final code and cohort lock. Routine staging uses the saved result, verifies the original Treasury source clocks and hashes, refits both original models, and compares the result to the first private outcome fingerprint. The existing `npm run consensus:stage-kibot-research` command validates the proposed public aggregate. The version-nine row contains counts, the coefficient sign, rounded errors and an adjusted significance diagnostic. Earlier aggregate versions remain readable and the first 29 studies must match their previous hash. The historical Kibot records stay in private evaluation, consistent with Kibot's separate permission for aggregate research statistics. [Kibot API scope](https://www.kibot.com/api/api-overview.html) · [Kibot research terms](https://www.kibot.com/license.html)

The source-only SHA-256 is `a842d6890ccba86bcbf33b5a0125c458c8ed067192cbd4ca45c80e47afb74335`. The pre-outcome code and comparison manifest is `faf9a5d7ab3fa0b658bd07b7f82cae31ea95d2d5b59f43c7269f12c150a72f9e`. The original outcome receipt is `8ec9a92a40c6805f87351a0dc60ff76355b8a6d517e6df1e340e2ef07876c82e`.
