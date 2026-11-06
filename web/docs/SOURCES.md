# Public data and publication boundaries

Verified November 2, 2026. Free access to a personal API is not permission to redistribute its data to a public application.

| Surface | Actual source | Boundary |
| --- | --- | --- |
| Prices, chart, technical ratings, company profile, headlines | Official TradingView hosted widgets | Attribution retained. Provider controls delays and availability. No scraping, backend extraction, or use as AI input. |
| Company filing metadata and document links | SEC EDGAR submissions and issuer directory | Hourly metadata cache, daily directory cache; declared user agent; bounded requests. Filers supply the documents. Reporting period can precede filing date. |
| Futures positioning | CFTC Traders in Financial Futures, **Futures Only**, dataset `gpe5-46if` | Verified six index/Treasury contract codes. Long, short, net and open interest are contract counts, not dollar flows. Categories do not identify intent or named traders. Reports retain actual dates; stale after 14 days. |
| Rates and household/nonprofit wealth | Federal Reserve government series via FRED | FEDFUNDS monthly percent; DPRIME daily percent; TNWBSHNO quarterly millions USD (displayed as trillions). Each series has its own observation date. Revisions are possible. |
| Market-wide brief and five instrument reports | Codex subscription workflow using linked public evidence | Published once and shared with all readers. SPY, QQQ, IWM, DIA and TLT reports cite their related futures contracts, which are not ETF fund flows. Latest/prior CFTC report dates support comparisons. Citation validation and numerical review precede publication. No runtime model calls; each report becomes historical after 72 hours. |
| Original research | 41 WordPress and 17 Substack public articles | Full text preserved with historical notices and author/source attribution. Images mirrored locally with provenance. No historical performance claims reverified. |

Official references:

- [TradingView widgets](https://www.tradingview.com/widget/), [widget integration](https://www.tradingview.com/widget-docs/tutorials/iframe/build-page/widget-integration/), [policies](https://www.tradingview.com/policies/).
- [SEC EDGAR APIs and access guidelines](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [SEC web policy](https://www.sec.gov/about/privacy-information).
- [CFTC public dataset](https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if), [release schedule](https://www.cftc.gov/MarketReports/CommitmentsofTraders/ReleaseSchedule/index.htm), [web policy](https://www.cftc.gov/WebPolicy/index.htm).
- [FEDFUNDS](https://fred.stlouisfed.org/series/FEDFUNDS), [DPRIME](https://fred.stlouisfed.org/series/DPRIME), [TNWBSHNO](https://fred.stlouisfed.org/series/TNWBSHNO).

## Evaluated but not connected to the public app

Individual [market-data terms](https://massive.com/legal/market-data-terms-of-service) and [redistribution guidance](https://massive.com/knowledge-base/article/how-can-i-redistribute-massives-market-data) do not authorize this public app. Private network adapters and credentials are outside the deployable public application.

Alpha Vantage, Twelve Data, and Finnhub free personal tiers did not provide verified public redistribution rights for the intended service. Stooq CSV permissions and FINRA API redistribution/access were not sufficiently verified. Cboe delayed-quote scraping is not a substitute for an authorized feed. No raw US options or dark-pool API is represented as connected.

The public service uses sources whose public-display or government-reuse conditions were verified, rather than personal subscription entitlements.

## AI and costs

Research is prepared in a Codex editorial workflow, validated, and published once. Public reads serve the published result; they do not consume model tokens or initiate API generation. No paid data plan is required by the application.

## Research method

Primary-source checks and live endpoint probes support the integration choices. Internal specialist review checked licensing, data transformations, and the first brief's figures. Separate external Grok/Gemini browser reviews were not run; no cross-model agreement is claimed. Skill-suggested browser CLI automation was not used because this session requires CUA for browser interaction.


## November 3 visual-product expansion

The current collector also uses government-origin FRED DGS2/DGS10/DGS30, SOFR, EFFR, WALCL, WTREGEN, RRPONTSYD, WRESBAL, DTWEXBGS, BUSLOANS and TOTBKCR; ECB reference currency fixes; official Fed/ECB/BoE/BoJ RSS; the official BLS iCalendar; and SEC quarterly revenue concepts for AAPL/MSFT/NVDA. Each datum retains observation/retrieval time and raw-source SHA-256. NVIDIA uses the `Revenues` concept; its old `RevenueFromContractWithCustomerExcludingAssessedTax` concept ends in 2020 and must not be treated as current.

- [ECB reuse policy](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html): reproduce with accurate attribution and label modifications. USD cross rates, changes, features and experiments are explicitly our calculations. [Reference data](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml).
- [BLS release calendar](https://www.bls.gov/schedule/news_release/bls.ics): future scheduled events retain Eastern timezone conversion and do not cast a directional vote.
- [FINRA Equity Data specific terms](https://developer.finra.org/specific-terms-equity-data), [API terms](https://developer.finra.org/terms-and-conditions): free non-commercial redistribution and derivatives are allowed with FINRA attribution, no charge, no further redistribution and reasonable end-user compliance efforts. Query API credentials and those conditions are required. This resolves the earlier uncertainty about the terms; access is still not configured. A public CDN file is not assumed to inherit the Query API grant.
- [GDELT use/redistribution terms](https://www.gdeltproject.org/about.html#termsofuse): datasets allow use and redistribution with citation/link. The DOC API probe returned HTTP429; this is an access/rate-limit failure, not zero market news. No article full text is republished.
- [Polymarket terms](https://polymarket.com/tos), section 2: market-data distributors and specified capital-market clients require written permission. The public Gamma endpoint returned data but reachability is not authorization to publish it. No Polymarket numbers were deployed.
- [Manifold API licensing](https://docs.manifold.markets/api) and [data licensing](https://docs.manifold.markets/data): free/non-commercial research is distinguished from commercial AI/data licensing. It is not treated as a universal unrestricted feed or an equivalent to real-money options positioning.

Public X/Instagram/Reddit searches did not yield a verifiable current and representative market sample. Old posts and aggregator copies were not relabeled as current platform sentiment. Existing personal market-data credentials and hosted TradingView content are not extracted into the new calculations.

### Visual news and catalyst extension
- GDELT English GKG2.1 public batch via `https://data.gdeltproject.org/gdeltv2/lastupdate.txt`; official dataset reuse/redistribution conditions: `https://www.gdeltproject.org/about.html#termsofuse`. Attribution and link included in UI. Download bounds12MBcompressed/60MBexpanded, manifest size and MD5 checked, SHA256 retained. Metadata only; article bodies are not copied. The first connected batch is2026-11-03T06:45Z,26deduplicated finance stories/13publishers. Finance-theme plus headline filters remove obvious topic false positives. Residual topic errors, PR content and paraphrased syndication can remain. Tone stays non-directional.
- FOMC official calendar HTML supplies meeting conclusion dates. No invented14:00announcement timestamp.
- TreasuryDirect announced-security API supplies actual competitive-bid cutoff and offering size; only already-announced upcoming auctions are included. America/New_York conversion handles DST. Gross offering size is not net liquidity withdrawal.
- OCC/OIC's public calendar JSON (`https://www.optionseducation.org/api/expirationcalendar`, linked in its calendar page) supplies selected monthly/quarterly expiration facts. Holidays are taken from the source, not a naive third-Friday assumption. Source link and date-only precision preserved. This does not provide IV, option-chain data, gamma or daily/weekly contract coverage.
# Capital and private-fund additions · November3,2026

US Treasury [SLT table1](https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table1.txt) and [table2](https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table2.txt) supply monthly net transactions, holdings and valuation changes. Only Grand Total country code99996 is selected; countries and aggregates are never added together. Values in millions become billions. Net purchases and asset values remain separate. August2026 foreign purchases of US long-term securities are300.724bn; US purchases abroad21.563bn; the matched-period net is279.161bn inward. This excludes short-term/banking flows and casts no directional vote. These government data need no key; latest-vintage revisions are preserved in future snapshots without rewriting prior editions.

The [SEC Private Fund Statistics page](https://www.sec.gov/data-research/investment-management-data/division-investment-management-private-fund-statistics) links the supporting XLSX report. The collector discovers the latest linked quarter, validates named tables1.1/2.1/2.3 and dollar units, and reads only the Private Equity Fund aggregate row. No private filings or masked cells are exposed or invented. The actual linked2025Q3report contains7,958bn gross assets,7,293bn net assets and25,155funds. Its period is September30,2025; the product marks it stale beyond270days. This is asset scale, not private-equity calls/distributions/investment flows. The date is not replaced with retrieval time.

FINRA's [Public credential is $0](https://developer.finra.org/fees); its [equity terms](https://developer.finra.org/specific-terms-equity-data) impose attribution, end-user use/no-charge/no-redistribution conditions. The new collector is private-only pending credential and a compliant display boundary. See `FINRA_SETUP.md`. Reachable metadata or public short-sale files are not proof of an unrestricted redistribution grant.

### Reviewed primary developments

The saved November3 review cites Apple's November2 release and attached consolidated financial statements, Microsoft's October28 quarterly release, and the Federal Reserve's October28 decision. URLs, original dates, actual retrieval times and source hashes are in `lib/consensus/reviewed-developments.json`. Only brief factual paraphrases and selected financial facts are published; private raw files are excluded. Each instrument has a separately labelled editorial transmission channel, not an observed price reaction. Reviews carry no extra directional vote. Company statements update selected revenue/GAAP EPS observations when newer than the SEC concept feed; same-period conflicts block publication. No analyst-estimate or earnings-surprise feed is implied.

Additional price/prediction-source checks did not unblock public integration: [OHLC's free plan](https://ohlc.io/pricing) is personal-use only, while display/redistribution is a paid tier; [Metaculus API](https://www.metaculus.com/api/) requires authentication and permission for model development; [Manifold data](https://docs.manifold.markets/data) distinguishes personal/noncommercial data from licensed AI/ML and commercial use. No subscriptions, paid credentials, permission requests or outreach were initiated. These sources are not implemented or counted as coverage.

### Official policy-rate comparison

The four-bank panel uses actual published observations, with no directional vote: Federal Reserve lower/upper targets (FRED `DFEDTARL`/`DFEDTARU`, daily7-day, public domain with citation); ECB `FM.D.U2.EUR.4F.KR.DFR.LEV` (daily, percent per annum, units validated); and Bank of England `IUDBEDR` (daily official Bank Rate). The Bank of Japan's October30 statement supplies an explicitly approximate1.25% target, saved by the subscription reviewer and dated to that decision. It is not a daily observed market-rate series.

- [Fed target definition and public-domain attribution](https://fred.stlouisfed.org/series/DFEDTARU).
- [ECB rate history](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html) and [reuse conditions](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html): accurate source attribution and identification of our transformations.
- [Bank of England Database licence](https://www.bankofengland.co.uk/legal): Database reproduction under [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/), with Bank attribution. Third-party FX series are excluded and are not used here.
- [Bank of Japan decision](https://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/k261030a.pdf) and [noncommercial reproduction conditions](https://www.boj.or.jp/en/about/copyright.htm). Only the selected policy fact is published, with Bank attribution; no PDF/image or full-text republication. This app remains free and noncommercial.

Daily rate observations expire after7days. The saved Japan decision expires after60days and must be reviewed when a newer decision appears; its original publication date never becomes today's date. The US range requires matching observation dates and lower<=upper. Missing/provisional/conflicting values are handled explicitly; missing is not zero. Source drawers use stepped policy charts, show actual years and preserve date-only release precision. Nominal levels across different policy instruments are not equivalent real rates or a standalone FX signal.

### Current market display and international schedules

The latest morning view reuses official [TradingView chart](https://www.tradingview.com/widget-docs/widgets/charts/advanced-chart/) and [technical analysis](https://www.tradingview.com/widget-docs/widgets/symbol-details/technical-analysis/) embeds, with attribution, source-controlled delays and an external fallback. Current symbols and initial daily/weekly/monthly intervals follow the selected context. Provider values are neither extracted nor passed into the consensus or models. Current displays disappear when a past edition is selected. This is hosted display, not a raw-data redistribution licence.

Selected factual dates come from the [Bank of England confirmed schedule](https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates), [ECB governing-council calendar](https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html) and [Bank of Japan meeting/release table](https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm). Only brief factual labels/dates are published with source attribution and direct links. No full source pages are republished. November5 UK policy decision, December17 ECB decision and December18 Japan conclusion are verified in their respective sources. Japan minutes/opinions are context events, not new policy decisions. Calendar dates are local to the source and are never assigned invented exact announcement times.

### Selected issuer earnings announcements

The saved subscription review records [AMD's November3 results after the close and17:00ET call](https://ir.amd.com/news-events/press-releases/detail/1300/amd-to-report-fiscal-third-quarter-2026-financial-results), [Qualcomm's November4 results after the close and16:45ET call](https://investor.qualcomm.com/news-events/press-releases/news-details/2026/Qualcomm-Schedules-Fourth-Quarter-and-Fiscal-2026-Earnings-Release-and-Conference-Call/default.aspx), and [NVIDIA's November17 results at approximately16:20ET followed by a17:00ET call](https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Sets-Conference-Call-for-Third-Quarter-Financial-Results/default.aspx). Original announcement dates are October6,22and28respectively. Only selected factual dates/windows are published, with source links; full press releases and contact details are not republished. Qualcomm/NVIDIA direct HTML retrieval returned403, while the primary-page text retrieval succeeded; the saved evidence hashes are explicitly marked as text extracts. No login, paywall or security warning was bypassed. This is a selected issuer sample, not a complete earnings or analyst-estimate feed.


### Original institutional holdings

Two selected manager samples come from the original SEC EDGAR filings: [Berkshire Hathaway, June 30 holdings filed August 14](https://www.sec.gov/Archives/edgar/data/1067983/000119312526352200/0001193125-26-352200-index.html) and [Bridgewater Associates, the same quarter and filing date](https://www.sec.gov/Archives/edgar/data/1350694/000135069426000003/0001350694-26-000003-index.html). Prior-quarter March 31 filings are separately linked in the saved evidence. Selected factual values are derived from public filings, with no signature/contact republication. [SEC format documentation](https://www.sec.gov/files/form_13f_readme.pdf) establishes post-January 2023 dollar units, report structure and amendment distinctions; [Investor.gov](https://www.investor.gov/introduction-investing/investing-basics/glossary/form-13f-reports-filed-institutional-investment) explains quarterly reporting and the 45-day deadline. These manager samples are not a complete institutional population. Disclosed value is neither total AUM nor a measure of daily trading or return.


### Dated management guidance

Microsoft's [October 28 FY2027 Q1 conference-call transcript](https://www.microsoft.com/en-us/investor/events/fy-2027/earnings-fy-2027-q1) gives FY2027 Q2 revenue guidance of $96.0–97.1bn in US dollars. NVIDIA's [August 26 release filed as an SEC exhibit](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm) gives FY2027 Q3 revenue of $108bn plus/minus 2%, assuming no Data Center compute revenue from China. The displayed $105.84–110.16bn endpoints are our arithmetic conversion, not a probability interval. These are selected management statements, not analyst estimates or actual results. Full documents stay private; brief factual ranges, assumptions, original dates and source hashes are saved with each edition.

The visual rows are context within the existing earnings disclosure for MARKET/SPY/QQQ/DIA. They do not add a directional vote or fill missing market-feed coverage. Guidance is visibly due for review once its matching scheduled results day arrives in New York, a later reported quarter is present, or its original statement is more than 120 days old. A newer retrieval does not refresh the statement's age. Old editions without guidance remain unchanged. The schedule check does not assert that results have actually been released, and no management beat/miss is calculated without comparable target-quarter results.
