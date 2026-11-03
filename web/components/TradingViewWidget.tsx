"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink as ExternalLinkIcon, RefreshCw } from "lucide-react";
import { ExternalLink } from "./ui";

type WidgetKind = "chart" | "technical" | "profile" | "news";
const EMBEDS: Record<WidgetKind, { script: string; label: string }> = {
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

export default function TradingViewWidget({
  kind,
  symbol,
  theme,
  newsScope = "symbol",
}: {
  kind: WidgetKind;
  symbol: string;
  theme: "dark" | "light";
  newsScope?: "symbol" | "market";
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const mappedSymbol = providerSymbol(symbol);
  const broadNews = kind === "news" && newsScope === "market";
  const widgetTitle = broadNews
    ? "Broad-market headlines"
    : `${symbol} ${EMBEDS[kind].label.toLowerCase()}`;
  const providerLink =
    kind === "news"
      ? "https://www.tradingview.com/news/top-providers/tradingview/"
      : `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(mappedSymbol)}`;

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    setState("loading");
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.width = "100%";
    container.style.height = "100%";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.width = "100%";
    widget.style.height = "100%";
    container.appendChild(widget);
    const script = document.createElement("script");
    script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${EMBEDS[kind].script}.js`;
    script.type = "text/javascript";
    script.async = true;
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
            interval: "D",
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
              symbol: mappedSymbol,
              interval: "1D",
              showIntervalTabs: true,
              displayMode: "single",
            }
          : kind === "news"
            ? {
                ...shared,
                displayMode: "regular",
                // TradingView's official configurator removes `market` in
                // all_symbols mode. Market + stock is its stock-only feed.
                ...(newsScope === "market"
                  ? { feedMode: "market", market: "stock" }
                  : { feedMode: "symbol", symbol: mappedSymbol }),
              }
            : { ...shared, symbol: mappedSymbol };
    script.textContent = JSON.stringify(options);
    script.onerror = () => {
      if (!disposed) setState("error");
    };

    // Observe only the presence/load of the hosted frame. Its content and market data remain inaccessible here.
    const frames = new Set<HTMLIFrameElement>();
    const ready = () => {
      if (!disposed) setState("ready");
    };
    const observer = new MutationObserver(() => {
      for (const frame of container.querySelectorAll("iframe")) {
        if (frames.has(frame)) continue;
        frames.add(frame);
        frame.title = `${widgetTitle} hosted by TradingView`;
        frame.addEventListener("load", ready);
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    // The provider script immediately replaces its own placeholder and reads
    // iframe.contentWindow. Defer insertion so React's development setup/cleanup
    // probe (and an initial saved-theme update) cannot fetch a script for a
    // container that is already detached when that script executes.
    const mountTimer = window.setTimeout(() => {
      if (disposed || !root.isConnected) return;
      root.replaceChildren(container);
      container.appendChild(script);
    }, 0);
    const timeout = window.setTimeout(() => {
      if (!disposed)
        setState((current) => (current === "ready" ? current : "error"));
    }, 15000);
    return () => {
      disposed = true;
      window.clearTimeout(mountTimer);
      window.clearTimeout(timeout);
      observer.disconnect();
      for (const frame of frames) frame.removeEventListener("load", ready);
      script.onerror = null;
      container.remove();
    };
  }, [kind, mappedSymbol, newsScope, theme, retry, widgetTitle]);

  return (
    <div className={`provider-widget provider-widget-${kind}`}>
      <div className="provider-widget-stage">
        <div ref={host} className="provider-widget-host" />
        {state !== "ready" && (
          <div
            className={`provider-widget-status ${state === "error" ? "provider-widget-error" : ""}`}
            role="status"
          >
            {state === "loading" ? (
              <>
                <span className="spinner" />
                <p>
                  Loading{" "}
                  {broadNews
                    ? "broad-market headlines"
                    : EMBEDS[kind].label.toLowerCase()}{" "}
                  from TradingView…
                </p>
              </>
            ) : (
              <>
                <ExternalLinkIcon size={22} />
                <h3>The hosted view isn’t available.</h3>
                <p>
                  {kind === "news"
                    ? "You can open TradingView’s news directly."
                    : "You can open this instrument directly on TradingView."}
                </p>
                <div>
                  <ExternalLink
                    href={providerLink}
                    className="button button-primary"
                  >
                    Open TradingView
                  </ExternalLink>
                  <button
                    className="button button-secondary"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    <RefreshCw size={14} />
                    Retry
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="tradingview-widget-copyright">
        <ExternalLink href={providerLink}>
          {widgetTitle} by TradingView
        </ExternalLink>
      </div>
      <p className="provider-widget-note">
        Third-party hosted view. Availability and delays are shown by
        TradingView.
      </p>
    </div>
  );
}
