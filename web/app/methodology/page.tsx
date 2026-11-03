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
              Observation coverage measures the share of expected inputs currently
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
              Directional coverage is the weighted share of families that have
              an eligible vote for the selected instrument and horizon. Context-only
              observations do not raise it. Under rules 2.0, a complete trading call
              is withheld below 70% observation or directional coverage, without
              verified price and options inputs, or with fewer than five
              directional families.
            </p>
            <p>
              Quarterly revenue growth is context, not an earnings-surprise vote.
              Standing futures positions never cast a daily vote; weekly and monthly
              readings use changes across one and four reports. Monthly macro series
              vote only monthly; weekly series only weekly and monthly. MARKET combines
              equity-market context. Treasury futures are excluded from its votes;
              the 10-year contract is context only for TLT. TLT receives only long-yield
              and Treasury-bond positioning priors, with falling yields treated as
              supportive. These are explicit assumptions, not learned accuracy.
            </p>
            <p>
              Earlier editions preserve their original rule version, coverage and
              votes. A methodology correction creates a new edition; it never rewrites
              an earlier call or makes old observations look freshly collected.
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
              ETF outcomes use the next session's total-return-adjusted open and
              the adjusted close after 1, 5 or 21 complete sessions. The same basis
              must account for both splits and distributions at both endpoints.
              Unadjusted and split-only series are rejected for every horizon;
              model forecasts and labels must declare the same basis. This is a
              total-return research target, not an executable quote or a portfolio return.
            </p>
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
              Only the last edition before an entry session opens is scored for
              each instrument and horizon. Earlier editions stay in the audit
              ledger. Training uses the same selection. MARKET is an overview,
              not a traded instrument; its performance panel summarizes the five
              instrument editions for the selected horizon.
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
              Each instrument and horizon needs at least 500 resolved
              observations and 100 previously uninspected, non-overlapping test
              outcomes before a candidate can be evaluated. Longer horizons can
              require substantially more history. Inputs are
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
              A test window is reserved permanently before evaluation, including
              failed or interrupted attempts. A paired block-bootstrap check
              measures uncertainty in the improvement, with stricter thresholds
              across instruments, horizons and repeated attempts. These are
              approximate statistical checks, not proof of future performance.
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
