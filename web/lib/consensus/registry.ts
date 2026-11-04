import type { FamilyDefinition, Family, Signal, Instrument } from "./types.ts";

export const ENGINE_VERSION = "consensus-rules-2.0.0";
export const FAMILIES: FamilyDefinition[] = [
  {
    id: "social",
    label: "Social pulse",
    detail: "X and Instagram, separately sampled",
    weight: 1,
  },
  {
    id: "retail",
    label: "Retail crowd",
    detail: "Positioning and community sentiment",
    weight: 1,
  },
  {
    id: "institutions",
    label: "Institutional positioning",
    detail: "Asset managers and leveraged funds",
    weight: 1,
  },
  {
    id: "options",
    label: "Options & volatility",
    detail: "IV, skew, gamma and expiration",
    weight: 1,
  },
  {
    id: "technicals",
    label: "Price & mathematics",
    detail: "Trend, momentum, Fibonacci and range",
    weight: 1,
  },
  {
    id: "premarket",
    label: "Before the bell",
    detail: "Overnight gap, volume and price range",
    weight: 1,
  },
  {
    id: "events",
    label: "Binary catalysts",
    detail: "Event risk and prediction markets",
    weight: 1,
  },
  {
    id: "analysts",
    label: "Analyst revisions",
    detail: "Estimate, target and recommendation changes",
    weight: 1,
  },
  {
    id: "news",
    label: "News cycle",
    detail: "Dated, source-linked developments",
    weight: 1,
  },
  {
    id: "earnings",
    label: "Earnings",
    detail: "Reported results and expectations",
    weight: 1,
  },
  {
    id: "liquidity",
    label: "Liquidity",
    detail: "Fed assets, Treasury cash and reverse repo",
    weight: 1,
  },
  {
    id: "rates",
    label: "Rates & bonds",
    detail: "Treasury curve and funding conditions",
    weight: 1,
  },
  {
    id: "fx",
    label: "Currency markets",
    detail: "Dollar and major exchange rates",
    weight: 1,
  },
  {
    id: "international",
    label: "Around the world",
    detail: "Central banks and international context",
    weight: 1,
  },
  {
    id: "capital",
    label: "Capital flows",
    detail: "Bank credit, cross-border and private capital",
    weight: 1,
  },
];

export const MACRO_SERIES = [
  {
    id: "DGS2",
    title: "2-year Treasury",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "DGS10",
    title: "10-year Treasury",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "DGS30",
    title: "30-year Treasury",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "SOFR",
    title: "Overnight funding · SOFR",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "EFFR",
    title: "Effective federal funds rate",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.25,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "WALCL",
    title: "Federal Reserve assets",
    family: "liquidity",
    unit: "$m",
    lag: 14,
    scale: 200000,
    polarity: 1,
    frequency: "weekly",
  },
  {
    id: "WTREGEN",
    title: "Treasury General Account",
    family: "liquidity",
    unit: "$m",
    lag: 14,
    scale: 100000,
    polarity: -1,
    frequency: "weekly",
  },
  {
    id: "RRPONTSYD",
    title: "Overnight reverse repo",
    family: "liquidity",
    unit: "$bn",
    lag: 7,
    scale: 100,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "WRESBAL",
    title: "Reserve balances",
    family: "liquidity",
    unit: "$m",
    lag: 14,
    scale: 200000,
    polarity: 1,
    frequency: "weekly",
  },
  {
    id: "DTWEXBGS",
    title: "Broad US dollar",
    family: "fx",
    unit: "index",
    lag: 14,
    scale: 2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "BUSLOANS",
    title: "Commercial & industrial loans",
    family: "capital",
    unit: "$bn",
    lag: 70,
    scale: 60,
    polarity: 1,
    frequency: "monthly",
  },
  {
    id: "TOTBKCR",
    title: "Commercial bank credit",
    family: "capital",
    unit: "$bn",
    lag: 21,
    scale: 150,
    polarity: 1,
    frequency: "weekly",
  },
] as const;

const REQUIRED_FEEDS: {
  id: string;
  family: Family;
  title: string;
  reason: string;
  url: string;
}[] = [
  {
    id: "off-exchange",
    family: "institutions",
    title: "Off-exchange activity",
    reason:
      "No current off-exchange activity sample is available. CFTC futures positions measure a different part of the market.",
    url: "https://developer.finra.org/specific-terms-equity-data",
  },
  {
    id: "global-news",
    family: "news",
    title: "News impact by market",
    reason:
      "Instrument-specific news impact ratings await reviewed evidence. Global news tone and official policy releases provide separate context.",
    url: "https://www.gdeltproject.org/",
  },
  {
    id: "global-equities",
    family: "international",
    title: "Broader international equity markets",
    reason:
      "Broad international equity coverage is unavailable. Separately labelled regional observations, currency fixes and policy releases provide only partial context.",
    url: "https://thedailyconsensus.com/methodology",
  },
  {
    id: "social-x",
    family: "social",
    title: "X sentiment",
    reason:
      "A current X sample is unavailable. No platform-wide sentiment is inferred from selected posts.",
    url: "https://docs.x.com/",
  },
  {
    id: "social-instagram",
    family: "social",
    title: "Instagram sentiment",
    reason:
      "A current Instagram sample is unavailable. Hashtag counts alone do not measure investor positioning.",
    url: "https://developers.facebook.com/docs/instagram-platform/",
  },
  {
    id: "retail-positioning",
    family: "retail",
    title: "Retail positioning",
    reason:
      "A representative retail-position or sentiment feed is not connected. Social engagement is not a substitute for holdings.",
    url: "https://thedailyconsensus.com/methodology",
  },
  {
    id: "options-chain",
    family: "options",
    title: "Options, IV & gamma",
    reason:
      "A verified options chain is unavailable. Implied volatility, skew and gamma remain unmeasured.",
    url: "https://thedailyconsensus.com/methodology",
  },
  {
    id: "daily-prices",
    family: "technicals",
    title: "Trend, Fibonacci & opening range",
    reason:
      "Independent price calculations are unavailable. Current hosted charts are displayed in the morning view and research desk, separately from the saved consensus.",
    url: "https://thedailyconsensus.com/research-desk",
  },
  {
    id: "premarket-bars",
    family: "premarket",
    title: "Premarket tape",
    reason:
      "An extended-hours bar feed is required to calculate the gap and range; no previous close or intraday prices are fabricated.",
    url: "https://thedailyconsensus.com/research-desk",
  },
  {
    id: "prediction-markets",
    family: "events",
    title: "Prediction markets",
    reason:
      "Verified prediction-market probabilities are unavailable. Each reading needs the exact contract, timestamp and liquidity.",
    url: "https://polymarket.com/tos",
  },
  {
    id: "analyst-revisions",
    family: "analysts",
    title: "Analyst estimates & revisions",
    reason:
      "Analyst estimate and revision observations are unavailable. Reported results alone cannot establish an earnings beat.",
    url: "https://thedailyconsensus.com/methodology",
  },
  {
    id: "earnings-expectations",
    family: "earnings",
    title: "Earnings versus expectations",
    reason:
      "Reported filings and analyst expectations must be matched to the same period. A verified expectations feed is not connected.",
    url: "https://www.sec.gov/edgar/search/",
  },
  {
    id: "private-capital",
    family: "capital",
    title: "Private-equity investment flows",
    reason:
      "Private-equity capital calls, distributions and investment flows are not integrated. SEC assets and Treasury cross-border transactions are separate lagged context.",
    url: "https://www.sec.gov/data-research/investment-management-data/division-investment-management-private-fund-statistics",
  },
];

export function missingSignals(at: string): Signal[] {
  return REQUIRED_FEEDS.map((feed) => ({
    ...feed,
    shortLabel: feed.title,
    instruments: ["MARKET", "SPY", "QQQ", "IWM", "DIA", "TLT"] as Instrument[],
    status: "unavailable",
    summary: feed.reason,
    methodology:
      "No observation or directional vote until a permitted source passes validation.",
    limitation: feed.reason,
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 3,
    unit: "",
    source: {
      name: "Not connected",
      url: feed.url,
      retrievedAt: at,
      observedAt: null,
      releasedAt: null,
      frequency: "unavailable",
      attribution: "",
      usage: "Not integrated",
      sha256: null,
    },
  }));
}
