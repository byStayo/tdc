# Can the number of X authors improve on mention volume?

The private historical comparison covered 149 regular sessions per ETF. Distinct-author participation improved the held-out Brier score for QQQ by 0.00351. The required improvement was greater than 0.01 against each of three baselines. The QQQ coefficient also had the opposite sign from the prediction. The other four funds scored worse when author participation was added. Zero funds qualified.

| ETF | Authors and mentions | Mentions alone | Training frequency | Fixed 50% |
| --- | ---: | ---: | ---: | ---: |
| SPY | 0.24951 | 0.24839 | 0.24916 | 0.25000 |
| QQQ | 0.24630 | 0.24981 | 0.25478 | 0.25000 |
| IWM | 0.26187 | 0.26169 | 0.26203 | 0.25000 |
| DIA | 0.25611 | 0.24671 | 0.25417 | 0.25000 |
| TLT | 0.26577 | 0.26322 | 0.25028 | 0.25000 |

Each score is a mean squared probability error on the last 30 dates. Lower is better. The preceding 89 dates trained each model. The next 30 selected regularization. All five comparisons used the same calendar. A second Python implementation reconstructed every input, matched the open-to-close signs on both price bases and reproduced all 20 aggregate error scores to an absolute tolerance of 0.000000000003.

## What was observable

TwitterAPI.io first published this revision on November 16, 2026. Its historical counts cover January 1, 2024 through May 1, 2026. No contemporary morning copy of these counts was available for the 2024 comparison. This measures a retrospectively reconstructed relationship. It contributed zero as-issued forecasts and consumed zero production holdout reservations.

The authors of *X (Twitter) Cashtag Mentions 2024–2026* released the counts under CC BY 4.0. The native ticker file totals 81,342,452 tag mentions across the archive. SPY accounted for 901,149, QQQ for 607,857, IWM for 197,226, DIA for 101,003 and TLT for 76,910. The provider reports 38,747,722 distinct posts. Summing the per-query counts gives 39,836,807. The study uses the five funds' comparable ticker totals as the denominator. A post or account can count toward multiple symbols. Some symbols can also refer to a different asset. The archive has no independent bullish or bearish labels. [Provider's data card and licence](https://huggingface.co/datasets/twitterapi-io/x-cashtag-mentions-2024-2026/blob/f1485ca2d83e6f770ed6d28522dde60f8071bebe/README.md) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## How the comparison was made

The protocol was sealed at 08:35:15 New York on November 24 before opening target outcomes for this comparison. It asks whether a fund's share of distinct authors adds to what its share of mentions already predicts. Both inputs compare the preceding complete UTC calendar day with the four preceding instances of that weekday. Every fund must have at least ten distinct authors on all five input dates. Nineteen sessions lacked the full calendar lookback. A further nineteen spanned the June 3 change in the provider's collection. No current-day or later engagement count entered a feature. [Registered protocol](../scripts/x-attention-study-policy.json)

Only historical training dates from the previously completed technical study were eligible. The calendar reproduced that study's 22-session ordinary-hours condition and October 29 training boundary before any price join. The X cohort ran from January 30 through October 29, 2024. Its 30 comparison dates begin September 18. All their signs had already been available to that earlier study's training process. Each target used the same regular-session open and close, with a matching sign on raw and split-only data. An overnight distribution does not enter that intraday return. Kibot supplies the owner-only price evidence. [Kibot licence](https://www.kibot.com/license.html)

## Reproduce on the publishing host

From `web`, the first command fetches only missing pinned aggregate objects. The remaining commands are offline. The scripts read the original price receipts from `.consensus/private-technical-momentum` and retain this study under `.consensus/private-x-attention/v1`. They never hydrate an X post, request an API credit or alter the public consensus.

```sh
python3 -B scripts/collect-x-attention.py --collect
npm run consensus:research-x-attention -- --cohort
npm run consensus:research-x-attention
python3 -B scripts/verify-x-attention.py
```

The byte SHA-256 values are `44e30fe4918776c3aa3099b6340f41c2dc44e39ef4afb86bcd244f7d6e8eb92c` for the selected inputs and `63f0cbf46e05afd922d70634d8adc931aee7bf6bb13d3d665683d2c1ef5462ec` for the research result. Both replays require the first sealed records to match.
