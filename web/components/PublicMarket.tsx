"use client";

import { Star } from "lucide-react";
import TradingViewWidget from "./TradingViewWidget";
import { PanelHeader } from "./ui";

export default function PublicMarket({
  symbol,
  theme,
  compact = false,
  isWatched,
  onWatch,
}: {
  symbol: string;
  theme: "dark" | "light";
  compact?: boolean;
  isWatched: boolean;
  onWatch: () => void;
}) {
  return (
    <div className="view-stack">
      <section className="panel public-market-panel">
        <PanelHeader
          eyebrow="EXPLORE THE MARKET"
          title={`${symbol} · Market view`}
        >
          <button
            className={`button button-secondary ${isWatched ? "is-saved" : ""}`}
            onClick={onWatch}
            aria-label={`${isWatched ? "Remove" : "Add"} ${symbol} ${isWatched ? "from" : "to"} watchlist`}
          >
            <Star size={14} fill={isWatched ? "currentColor" : "none"} />
            <span>{isWatched ? "Saved" : "Watch"}</span>
          </button>
        </PanelHeader>
        <TradingViewWidget kind="chart" symbol={symbol} theme={theme} lazy />
      </section>
      {!compact && (
        <>
          <section className="panel">
            <PanelHeader
              eyebrow="PROVIDER OBSERVATIONS"
              title="Technical analysis"
            />
            <p className="panel-intro">
              TradingView’s indicators and timeframes, shown in its hosted view.
              Ratings describe the provider’s methodology and are not a
              recommendation from The Daily Consensus.
            </p>
            <TradingViewWidget kind="technical" symbol={symbol} theme={theme} lazy />
          </section>
          <section className="panel">
            <PanelHeader
              eyebrow="INSTRUMENT CONTEXT"
              title={`${symbol} profile`}
            />
            <TradingViewWidget kind="profile" symbol={symbol} theme={theme} lazy />
          </section>
        </>
      )}
    </div>
  );
}
