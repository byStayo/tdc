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
