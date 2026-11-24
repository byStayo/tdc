# Canadian policy decisions and the next TLT session

In the registered 2003–2021 comparison, adding the Bank of Canada’s newly announced rate change reduced held-out Brier error from 0.2440 to 0.2408. Both models used the preceding six weeks of Canadian and U.S. policy-rate changes. The training-rate benchmark scored 0.2452 and a fixed 50% forecast scored 0.2500. The incremental gain over the matched control was 0.0031, with a paired 95% interval of −0.0111 to +0.0210. The study required a gain greater than 0.01 over each baseline and positive corrected lower bounds. It earned no directional vote.

## Coverage and timing

All 19 advance annual schedules and all 152 original decisions were recovered. Only 4 of the 28 decisions in the test period changed the rate. The validation period contained two rate changes across 28 observations. These counts limit what the apparent improvement establishes.

The new feature measures announced easing against the prevailing Canadian overnight target, in percentage points. The U.S. control uses the midpoint when the Board specified a range. Each Canadian statement precedes the next selected U.S. trading session. The next-day cutoff accommodates both the historical 9 a.m. and later 10 a.m. announcement schedules. The 07:48 New York research decision always precedes the 09:30 regular opening. The test measures that session’s TLT opening-to-closing direction.

The official Valet daily service starts on April 21, 2009. The initial daily-vintage procedure supported 88 eligible sessions. Before opening prices, a separate registration qualified the Bank’s historical effective-date register. All 3,319 overlapping business-day values matched Valet. Statements, prior rates, fresh announcements and the effective-date register agreed for every decision. The initial 88 dates and their features were retained. Earlier register values describe the legally prevailing rate. The independent daily delivery starts in 2009.

Thirteen candidate target dates overlapped prior TLT research including previously used price inputs. Their exclusion leaves 139 distinct eligible sessions. All 139 had agreeing native as-traded and split-only directions. The chronological split contained 83 training, 28 validation and 28 test observations. Feature fit and uncertainty used only the frozen target roster. The public research report may disclose the aggregate results. The native text, market data, dated labels, probabilities, model coefficients and earlier-study receipts remain in owner-only storage.

## Run the immutable study offline

From the publisher’s `web` directory, with the existing private source bundle installed, run the following commands.

```sh
python3 -B scripts/qualify-boc-decisions.py \
  --root .consensus/private-boc-decisions-tlt --external .consensus
node scripts/research-boc-decisions-tlt.ts \
  .consensus/private-boc-decisions-tlt .consensus --cached
python3 -B scripts/verify-boc-decisions-tlt.py \
  .consensus/private-boc-decisions-tlt .consensus
node --test tests/consensus-boc-decision-study.test.ts
```

The source replay checks the original Bank of Canada bytes, Fed Board register, effective dates, earlier exclusions and private cohort hash. The Node evaluator rebuilds the historical model from 68 native price receipts. The Python implementation independently decodes the deliveries, reproduces both fits and recalculates the three moving-block intervals. The extra private acquisition used 32 bounded receipts, 22 covering a single date and 10 spanning a wider eligible interval. The initial run stopped at a request cap before a fit. A sealed transport supplement added an existing verified archive and reduced network calls through bounded annual batches. It checks that scoring code is bit-identical to the original registration.

The public stager calls `readBocDecisionStudy(webRoot, firstIssue)` using the original public forecast time. It requires all three offline replays, the immutable private result hash, the expected aggregate fields and the pre-existing study history. All prior prospective forecasts, model candidates and holdouts keep their original outcomes and permissions.

## Sources and permitted public output

The Bank permits accurate attributed reuse of its own content. Its notice requirements apply when providing its content through a paid service or a document for sale. Attribute the Canadian observations to the Bank of Canada and these calculations to The Daily Consensus. [Bank of Canada effective-rate register](https://www.bankofcanada.ca/rates/interest-rates/key-interest-rates/) · [Bank of Canada business-day target](https://www.bankofcanada.ca/rates/interest-rates/canadian-interest-rates/) · [Bank of Canada terms](https://www.bankofcanada.ca/terms/)

The U.S. policy control comes from the Federal Reserve Board’s original policy implementation tables. The Bank’s publication-time notices and advance calendars establish Canadian event chronology. [Federal Reserve Board open market operations](https://www.federalreserve.gov/monetarypolicy/openmarket.htm) · [Historical Fed Board operations](https://www.federalreserve.gov/monetarypolicy/openmarket_archive.htm) · [Bank of Canada 2003 schedule](https://www.bankofcanada.ca/2002/08/bank-canada-releases-2003-schedule/) · [2013 publication-time change](https://www.bankofcanada.ca/2012/12/bank-canada-announces-new-publication-time-2013-fad-mpr/)

Kibot guest access supplied permitted private historical evaluation. Its data licence expressly permits sharing aggregate statistics and backtest summaries. This study’s public scope consists of rounded errors, counts, the confidence interval, coefficient sign and gate result. [Kibot API scope](https://www.kibot.com/api/api-overview.html) · [Kibot data licence](https://www.kibot.com/license.html)
