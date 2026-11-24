# Iowa election markets and SPY

Iowa Electronic Markets operated two separate cash markets on the U.S. presidential popular vote. One paid the winning major party’s contract $1. The other paid each major party’s share of the two-party vote. The question for SPY was whether the market’s certainty about the popular-vote winner added information beyond its expected vote-share margin.

## Sources and permitted output

IEM director Thomas Gruca and steering committee member Thomas Rietz deposited the original election workbooks under CC0. The 2020 workbook includes the exchange’s older election sheets. The study reads the trade date, contract name, units, dollar volume, daily high and low, and last trade for the two parties in each market. The archive also contains third-party material. The source parser selects only the exchange’s own contract records. [IEM operators](https://iemweb.biz.uiowa.edu/about-iem/iem-organization/) · [Original historical workbook](https://doi.org/10.7910/DVN/MHUC8C) · [Original 2024 workbook](https://doi.org/10.7910/DVN/C09NG6)

The exchange’s daily close means the last trade before midnight Central. Both legs of both markets had to trade that day for positive dollar volume, with a valid closing price inside the reported range. The two-party prices in each market had to sum to between $0.90 and $1.10. The study assigns the recorded trades to the next calendar day’s 7:48 a.m. New York cutoff. The exchange operators deposited the workbooks in August 2020 and October 2024. The historical timing evidence consists of the venue’s trade dates and midnight closing convention, and individual daily archive publication times are unknown. Only ordinary SPY sessions before Election Day qualified. The 2008 and 2012 reconstructions use election-year dates, with exchange holidays, shortened sessions and both Hurricane Sandy closures excluded. [Market design and closing convention](https://www.biz.uiowa.edu/faculty/trietz/papers/Memoirs.pdf) · [2008 contract definitions](https://iemweb.biz.uiowa.edu/market/2008-u-s-presidential-election-markets/) · [2012 contemporaneous exchange prices](https://now.uiowa.edu/news/2012/10/romney-comes-back-obama-still-favored-iem) · [2016 exchange announcement](https://now.uiowa.edu/news/2014/12/iem-opens-2016-presidential-congressional-prediction-markets) · [2024 operator paper](https://www.cambridge.org/core/journals/ps-political-science-and-politics/article/iowa-electronic-markets-forecasting-the-2024-us-presidential-election/B256F4EA39F7F9B6F0423BA4EDA46B4A)

Kibot permits the guest API for evaluation and permits public aggregate backtest statistics. SPY outcomes use ordinary-session open-to-close direction, verified on separate as-traded and split-only responses from that provider. Prices, individual dates and labels remain private. The research publisher exposes sample counts, rounded errors, coefficient sign and aggregate uncertainty. An eligible forecast of a currently open event would require new source evidence. Iowa’s FedPolicyB market closed in 2023. [Kibot evaluation access](https://www.kibot.com/api/api-overview.html) · [Kibot licensed outputs](https://www.kibot.com/license.html) · [Iowa economic markets](https://iemweb.biz.uiowa.edu/markets/current-markets/)

## Registered comparison

| Cohort | Election cycles | Distinct SPY sessions |
| --- | --- | ---: |
| Training | 2008 and 2012 | 85 + 46 |
| Validation | 2016 | 51 |
| Held out | 2020 and 2024 | 24 + 8 |

Within each market, the two prices were normalized to sum to one. The model used twice the absolute distance from 0.5 as its party-neutral measure. Greater certainty had a prespecified positive sign. Fitting used the existing four ridge parameters, selected on 2016. The economic gate required a Brier improvement greater than 0.01 against each of the separate vote-share model, the training base rate and a fixed 50% forecast.

The combined model scored 0.2508, compared with 0.2499 for vote share, 0.2510 for the training base rate and 0.2500 for the fixed forecast. The added coefficient was negative. The 95% interval for improvement over vote share ran from −0.0024 to +0.0028 using blocks of four observations within each held-out campaign. With only two held-out campaigns, the separate exact sign test has four permutations. Its one-sided p-value was 1.00. This historical study earned zero directional votes.

## Offline reproduction

From `web`, the source replay checks both original workbooks and reconstructs all 214 source dates and features. The study replay verifies the original registration and underlying private price receipts, refits both models, and compares the full-precision output with the immutable first result. The general historical publisher runs this same replay.

```sh
python3 -B scripts/qualify-iem-events.py .consensus/private-iem-screen
node --experimental-strip-types scripts/stage-iem-events.ts
```

For an owner checkout with separate evidence storage, the Node command accepts the study directory and the existing `.consensus` price-research directory as positional arguments. The study directory needs the two CC0 workbooks, the original 83-target and extended 214-target selections, the registration, the sealed result and six study-specific historical price receipts. The other eight raw/split-basis receipts already live in the existing FOMC-eve and technical-momentum research folders. Private originals must be owner-readable only. The earlier 83-target selection remains replayable.

| Immutable receipt | SHA-256 |
| --- | --- |
| Source cohort | `cf718b3022d7026797be015ae8cb83ee9506c08725b10f32f568c596aab8f427` |
| Registration before price access | `c71750e1f519d662c26cacb619e553a13aa78e8aa5bc5d72344ef465649027a7` |
| First sealed result | `a7b6a0d56a17d036bb8973a76d718fbc7b7c649cf5630c08061b3bf2f40fcb5c` |
