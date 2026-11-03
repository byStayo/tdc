import { isPublicSymbol } from "./public-normalization.ts";

export type WidgetKind = "chart" | "technical" | "profile" | "news";
export type WidgetHorizon = "daily" | "weekly" | "monthly";
export function isWidgetHorizon(value: string): value is WidgetHorizon {
  return ["daily", "weekly", "monthly"].includes(value);
}
export const EMBEDS: Record<WidgetKind, { script: string; label: string }> = {
  chart: { script: "advanced-chart", label: "Market chart" },
  technical: { script: "technical-analysis", label: "Technical analysis" },
  profile: { script: "symbol-profile", label: "Instrument profile" },
  news: { script: "timeline", label: "Market headlines" },
};
const SYMBOLS: Record<string, string> = {
  SPY: "AMEX:SPY",
  IWM: "AMEX:IWM",
  DIA: "AMEX:DIA",
  GLD: "AMEX:GLD",
  VOO: "AMEX:VOO",
  VTI: "AMEX:VTI",
  XLK: "AMEX:XLK",
  XLF: "AMEX:XLF",
  XLV: "AMEX:XLV",
  QQQ: "NASDAQ:QQQ",
  TLT: "NASDAQ:TLT",
  IEF: "NASDAQ:IEF",
  AAPL: "NASDAQ:AAPL",
  MSFT: "NASDAQ:MSFT",
  NVDA: "NASDAQ:NVDA",
  AMZN: "NASDAQ:AMZN",
  GOOGL: "NASDAQ:GOOGL",
  GOOG: "NASDAQ:GOOG",
  META: "NASDAQ:META",
  TSLA: "NASDAQ:TSLA",
  "BRK.B": "NYSE:BRK.B",
};
export function providerSymbol(symbol: string) {
  return SYMBOLS[symbol] ?? symbol;
}
export function isWidgetKind(value: string): value is WidgetKind {
  return Object.hasOwn(EMBEDS, value);
}
const BROAD_NEWS_ETFS = new Set([
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "TLT",
  "GLD",
  "VTI",
  "VOO",
  "IEF",
]);
export function usesBroadMarketNews(symbol: string) {
  return BROAD_NEWS_ETFS.has(symbol);
}

/** The official embed runs in a separate document, cancelled as a unit on unmount. */
export function tradingViewDocument(
  kind: WidgetKind,
  symbol: string,
  theme: "dark" | "light",
  newsScope: "symbol" | "market",
  horizon: WidgetHorizon = "daily",
): string {
  if (
    !isWidgetKind(kind) ||
    !isPublicSymbol(symbol) ||
    !["dark", "light"].includes(theme) ||
    !["symbol", "market"].includes(newsScope) ||
    !isWidgetHorizon(horizon)
  )
    throw new Error("Invalid hosted widget parameters");
  const mappedSymbol = providerSymbol(symbol);
  const interval = { daily: "D", weekly: "W", monthly: "M" }[horizon];
  const shared = {
    locale: "en",
    width: "100%",
    height: "100%",
    colorTheme: theme,
    isTransparent: true,
  };
  const options =
    kind === "chart"
      ? {
          autosize: true,
          symbol: mappedSymbol,
          interval,
          timezone: "America/New_York",
          theme,
          style: "1",
          locale: "en",
          allow_symbol_change: false,
          calendar: false,
          support_host: "https://www.tradingview.com",
        }
      : kind === "technical"
        ? {
            ...shared,
            isTransparent: false,
            symbol: mappedSymbol,
            interval: `1${interval}`,
            showIntervalTabs: true,
            displayMode: "single",
          }
        : kind === "news"
          ? {
              ...shared,
              displayMode: "regular",
              ...(newsScope === "market"
                ? { feedMode: "market", market: "stock" }
                : { feedMode: "symbol", symbol: mappedSymbol }),
            }
          : { ...shared, symbol: mappedSymbol };
  const config = JSON.stringify(options).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${symbol} ${EMBEDS[kind].label}</title><style>html,body,.tradingview-widget-container,.tradingview-widget-container__widget{margin:0;width:100%;height:100%;background:transparent}iframe{border:0}</style></head><body><div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-${EMBEDS[kind].script}.js" async>${config}</script></div></body></html>`;
}
