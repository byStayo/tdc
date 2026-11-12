"use client";

import type { Horizon, Instrument } from "@/lib/consensus/types";
import TradingViewWidget from "./TradingViewWidget";
import styles from "./MorningBoard.module.css";

export default function MorningMarket({
  instrument,
  horizon,
  theme,
  historical,
}: {
  instrument: Instrument;
  horizon: Horizon;
  theme: "dark" | "light";
  historical: boolean;
}) {
  if (historical)
    return (
      <p className={styles.historicalMarket}>
        Current price charts are hidden in past editions. Choose the latest
        edition to view today’s market alongside its saved consensus.
      </p>
    );
  const symbol = instrument === "MARKET" ? "SPY" : instrument;
  return (
    <section
      className={styles.currentMarket}
      aria-label="Current market display"
    >
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>THE MARKET ON SCREEN</span>
          <h2>{symbol} · price and technicals.</h2>
        </div>
        <span>Current provider view · {horizon} bars</span>
      </div>
      <p className={styles.marketContext}>
        {instrument === "MARKET"
          ? "SPY is the S&P 500 benchmark shown here. Select an instrument above to change both views. "
          : "Both views follow your selected instrument and horizon. "}
        TradingView’s current display is separate from the saved consensus and
        its history. Quotes may be delayed; use the provider’s timestamps.
      </p>
      <div className={styles.marketGrid}>
        <article className={styles.marketPanel}>
          <h3>{symbol} price chart</h3>
          <TradingViewWidget
            kind="chart"
            symbol={symbol}
            theme={theme}
            horizon={horizon}
            lazy
          />
        </article>
        <article className={styles.marketPanel}>
          <h3>TradingView technical summary</h3>
          <p>
            Provider indicators use their own methodology. Their ratings are not
            a Daily Consensus trading call.
          </p>
          <TradingViewWidget
            kind="technical"
            symbol={symbol}
            theme={theme}
            horizon={horizon}
            lazy
          />
        </article>
      </div>
    </section>
  );
}
