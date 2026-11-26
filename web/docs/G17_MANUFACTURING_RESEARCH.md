# Federal Reserve manufacturing growth and DIA

This historical test asked whether the first estimate of monthly manufacturing growth helped predict DIA’s next full session after controlling for total industrial production. The dated Federal Reserve releases and the Fed’s separately published first-estimate histories agreed on the archived inputs. The releases were retrieved retrospectively. The Board’s published monthly schedule, report date and 9:15 a.m. Eastern embargo established the announcement time. The benchmark used the decision at 7:48 a.m. Eastern on the following trading day. [Monthly G.17 originals](https://www.federalreserve.gov/releases/g17/default.htm) · [History of first estimates](https://www.federalreserve.gov/releases/g17/revhist.htm) · [Release calendar](https://www.federalreserve.gov/releases/g17/release_dates.htm) · [Federal Reserve reuse terms](https://www.federalreserve.gov/disclaimer.htm)

The registration covered the 129 monthly reports issued from January 2016 through October 2026. One report published two preliminary reference months. Three reports had unconfirmed time zones in the original release. The remaining 125 observations had matching raw and split-only DIA outcome directions in the previously approved private research receipts. The first-vintage series are B00004 for manufacturing and B50001 for total industrial production. For reference months before March 2017, the corroboration uses the initial level divided by the first revision to the previous month’s level, following the Board’s formula.

The chronological split was 75 training, 25 validation and 25 test sessions. The model Brier score was 0.2579 against 0.2586 for total production alone, 0.2583 for the training base rate and 0.2500 for an even chance. The expected positive coefficient was negative. The descriptive 95% moving-block interval for the improvement over total production alone was −0.0002 to +0.0016. The earlier DIA technical study had already used 43 of these dates, including 19 of the 25 held-out dates. The candidate failed its registered directional screen.

## Offline reproduction

Run from the publishing host’s `web` directory with its retained owner-only `.consensus/private-g17-manufacturing-dia` bundle. It contains the registration, official Board originals and receipt metadata, the feature manifest sealed before price access, and the original model result. The existing `private-ft900` and `private-technical-momentum` directories supply the original prelaunch historical price records. Dates, prices and fitted probabilities stay in the research store.

```sh
python3 -B scripts/research-g17-originals.py .consensus/private-g17-manufacturing-dia
node --disable-warning=ExperimentalWarning scripts/research-g17-manufacturing.ts .consensus/private-g17-manufacturing-dia .
python3 -B scripts/verify-g17-manufacturing.py .consensus/private-g17-manufacturing-dia .
npm run consensus:stage-kibot-research
```

The Python check independently reconstructs the labels, fits and uncertainty interval. The stager replays the dated originals and registered models, verifies the reviewed result digest and rounds the aggregate measurements to four decimals. The first 31 published study rows retain their original serializations.
