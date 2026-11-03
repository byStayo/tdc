import Link from "next/link";
import { FAMILIES, MACRO_SERIES } from "@/lib/consensus/registry";
import styles from "@/components/MorningBoard.module.css";
export const metadata = {
  title: "Sources & Methodology | The Daily Consensus",
  alternates: { canonical: "/methodology" },
};
export default function Methodology() {
  return (
    <div className={styles.board}>
      <main className={styles.main}>
        <Link href="/" className={styles.textButton}>
          ← Back to the morning view
        </Link>
        <div className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>A VIEW YOU CAN INSPECT</span>
            <h1>Every signal has a source.</h1>
            <p>
              What the observations say, how they combine, and where the
              evidence stops.
            </p>
          </div>
        </div>
        <div className={styles.twoColumns}>
          <section className={styles.panel}>
            <h2>Balance, coverage and agreement</h2>
            <p>
              The balance is an average of directional readings across
              independent source families. Every family has an equal declared
              prior weight. Adding more technical indicators cannot multiply the
              technical family's vote.
            </p>
            <p>
              Coverage measures the share of expected inputs currently
              available, averaged across all {FAMILIES.length} families. Neutral
              is a measured reading. Missing, stale and not-yet-formed are
              different states and do not cast a neutral vote.
            </p>
            <p>
              Agreement is the fraction of directional families on the majority
              side. Neither balance nor agreement is a probability of making
              money.
            </p>
            <p>
              A complete trading call is withheld below 70% coverage, without
              verified price and options inputs, or with fewer than five
              directional families.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>The time on the label matters</h2>
            <p>
              Each input records its observation date, collection time, source
              hash, frequency and release time when supplied. Daily means a
              daily publication, not that every underlying dataset is updated
              every day.
            </p>
            <p>
              CFTC positions are generally measured Tuesday and released Friday.
              Monthly credit data and weekly liquidity observations are lagged.
              They are not substitutes for live flows.
            </p>
            <p>
              Daily, weekly and monthly views apply distinct change windows.
              They are contextual scenarios. Numeric return projections require
              separately evaluated models; a longer chart does not become a
              forecast.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Official public observations</h2>
            <ul>
              <li>
                <a
                  href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  CFTC Traders in Financial Futures
                </a>
                : futures-only asset-manager and leveraged-fund categories. Net
                contracts / open interest; not ETF holdings, dark-pool trades or
                known dealer intent.
              </li>
              <li>
                <a
                  href="https://fred.stlouisfed.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Federal Reserve / FRED
                </a>
                : {MACRO_SERIES.map((series) => series.id).join(", ")}. Original
                government observations, not proprietary market-price series.
              </li>
              <li>
                <a
                  href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ECB reference exchange rates
                </a>
                : same-date USD cross rates and changes calculated by The Daily
                Consensus. Daily fixes are not executable quotes.
              </li>
              <li>
                <a
                  href="https://www.gdeltproject.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  The GDELT Project
                </a>
                : a bounded English-language financial-news batch. Finance
                themes and headline terms filter relevance; normalized headlines
                collapse syndication. Tone describes language, with bins below
                −1, within ±1 and above +1. It is not investor sentiment or a
                directional trading vote. Headlines remain attributed to their
                publishers and may include releases or topic-classification
                errors.
              </li>
              <li>
                <a
                  href="https://www.bls.gov/schedule/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  BLS releases
                </a>
                ,{" "}
                <a
                  href="https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  FOMC meetings
                </a>
                ,{" "}
                <a
                  href="https://www.treasurydirect.gov/auctions/upcoming/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Treasury auctions
                </a>{" "}
                and{" "}
                <a
                  href="https://www.optionseducation.org/referencelibrary/expiration-calendar"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  OCC / OIC expirations
                </a>
                : source dates and supplied Eastern times. Date-only events
                retain that precision. Expiration calendars do not supply gamma,
                positioning or implied volatility.
              </li>
              <li>
                International policy calendars from the{" "}
                <a
                  href="https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Bank of England
                </a>
                ,{" "}
                <a
                  href="https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ECB
                </a>{" "}
                and{" "}
                <a
                  href="https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Bank of Japan
                </a>
                . Decision days are separate from minutes and opinions.
                Date-only events retain their London, Frankfurt or Tokyo date;
                no exact time is inferred.
              </li>
              <li>
                Current price charts and technical summaries are hosted by{" "}
                <a
                  href="https://www.tradingview.com/widget-docs/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  TradingView
                </a>
                . Provider timestamps and delays apply. The market overview uses
                SPY as its named benchmark. These current displays do not
                contribute to saved consensus scores and are hidden when reading
                a past edition.
              </li>
              <li>
                Official Federal Reserve, ECB, Bank of England and Bank of Japan
                release feeds. Headlines are linked to their publishers. This is
                a selected policy-news sample, not the entire news cycle.
              </li>
            </ul>
          </section>
          <section className={styles.panel}>
            <h2>Calculation assumptions</h2>
            <p>
              Government-series changes are scaled by declared constants and
              capped to −1 to +1. Falling rates and a weaker broad dollar are
              assigned supportive priors; higher reserves and bank credit are
              assigned supportive priors. Relationships can reverse by market
              regime. These rules are not learned accuracy.
            </p>
            <p>
              The liquidity chart is Fed assets minus Treasury General Account
              minus overnight reverse repo, converted to common units and joined
              on the same observation date. It is a limited US proxy, not total
              world liquidity.
            </p>
            <p>
              Fibonacci uses a fixed trailing window. Opening range requires
              every one-minute observation in the defined interval.
              Black–Scholes calculations require valid inputs and
              European-option assumptions; a signed open-interest gamma proxy is
              not observed dealer inventory.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>An immutable track record</h2>
            <p>
              As-issued snapshots preserve source observations, cutoff, engine
              version and a SHA-256 digest. Collection alone does not justify a
              new issue date. New source observations, corrections or a declared
              model change do.
            </p>
            <p>
              Outcome measurement begins at the next eligible session open after
              publication and ends after 1, 5 or 21 sessions. Missing prices do
              not skip sessions. A verified exchange calendar and a consistent
              adjustment basis are required.
            </p>
            <p>
              Abstentions do not count as wins. Mean forecast returns are not a
              portfolio equity curve; overlapping horizons and correlated
              instruments must not be presented as independent trading profits.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Learning has to earn its place</h2>
            <p>
              Each instrument and horizon needs at least 120 resolved
              observations before a candidate can be evaluated. Inputs are
              normalized on training data only. Labels crossing the validation
              or test boundary are purged.
            </p>
            <p>
              Candidate selection uses validation data, with the final
              chronological test held aside. A candidate must beat the
              historical base rate, a 50/50 baseline and the incumbent by at
              least 0.01 Brier score. Calibration bins and sample counts
              accompany every result.
            </p>
            <p>
              No model has yet accumulated that prospective evidence. The
              original historical report's conviction percentages are not a
              verified win rate. No simulated results are included in the public
              record.
            </p>
          </section>
        </div>
        <footer className={styles.footer}>
          <Link href="/">Return to the morning view →</Link>
          <span>Free public research. No account or payment required.</span>
        </footer>
      </main>
    </div>
  );
}
