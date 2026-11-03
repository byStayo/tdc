"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink as ExternalLinkIcon, RefreshCw } from "lucide-react";
import { ExternalLink } from "./ui";
import { EMBEDS, providerSymbol, type WidgetKind } from "@/lib/tradingview-config";
export { providerSymbol, usesBroadMarketNews } from "@/lib/tradingview-config";

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
    // An async script in the parent document can finish after its container is
    // removed. An owned child document is cancelled as a unit during navigation.
    const frame = document.createElement("iframe");
    frame.title = `${widgetTitle} hosted by TradingView`;
    frame.src = `/widgets/${kind}?${new URLSearchParams({ symbol, theme, newsScope })}`;
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    const children = new Set<HTMLIFrameElement>();
    let observer: MutationObserver | undefined;
    const ready = () => { if (!disposed) setState("ready"); };
    const documentLoaded = () => {
      if (disposed) return;
      const document = frame.contentDocument;
      if (!document) return;
      // Some provider scripts create the frame after the wrapper load event.
      // Observe only frame lifecycle in our own document, never provider data.
      const trackFrames = () => {
        for (const child of document.querySelectorAll("iframe")) {
          if (children.has(child)) continue;
          children.add(child);
          child.title = `${widgetTitle} by TradingView`;
          child.addEventListener("load", ready);
        }
      };
      observer?.disconnect();
      observer = new MutationObserver(trackFrames);
      observer.observe(document, { childList: true, subtree: true });
      trackFrames();
      // Frames already present when their containing document loads have loaded.
      if (document.querySelector("iframe")) ready();
    };
    frame.addEventListener("load", documentLoaded);
    const mountTimer = window.setTimeout(() => {
      if (disposed || !root.isConnected) return;
      root.replaceChildren(frame);
    }, 0);
    const timeout = window.setTimeout(() => {
      if (!disposed)
        setState((current) => (current === "ready" ? current : "error"));
    }, 15000);
    return () => {
      disposed = true;
      window.clearTimeout(mountTimer);
      window.clearTimeout(timeout);
      observer?.disconnect();
      for (const child of children) child.removeEventListener("load", ready);
      frame.removeEventListener("load", documentLoaded);
      frame.remove();
    };
  }, [kind, symbol, newsScope, theme, retry, widgetTitle]);

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
