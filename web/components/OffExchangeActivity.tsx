import { ArrowUpRight } from "lucide-react";
import type { ReviewPacket, ReviewedSource } from "@/lib/consensus/reviewed";
import type { Instrument } from "@/lib/consensus/types";
import type { VenueComparison } from "@/lib/consensus/venue-activity";
import styles from "./MorningBoard.module.css";

const ETFS = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
const FINRA_READER = "https://otctransparency.finra.org/otctransparency/Agreement";

function quarter(date: string) {
  return `Q${Math.ceil(Number(date.slice(5, 7)) / 3)} ${date.slice(0, 4)}`;
}

function VenueTile({ title, description, comparison, unit, priorQuarter, filing }: {
  title: string;
  description: string;
  comparison: VenueComparison;
  unit: "%" | "M";
  priorQuarter: string;
  filing: ReviewedSource;
}) {
  const figure = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit}`;
  const filed = new Date(filing.publishedAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York",
  });
  return (
    <article className={styles.venueTile}>
      <h4>{title}</h4>
      <strong>{figure(comparison.current)}{unit === "M" && <small> shares/day</small>}</strong>
      <p>{priorQuarter} · {figure(comparison.previous)}{unit === "M" && " shares/day"}</p>
      <p>{description}</p>
      <a href={filing.url} target="_blank" rel="noopener noreferrer">{filing.name} · filed {filed} <ArrowUpRight size={14} aria-hidden="true" /></a>
    </article>
  );
}

export default function OffExchangeActivity({ review, instrument, historical }: {
  review?: ReviewPacket;
  instrument: Instrument;
  historical: boolean;
}) {
  const activity = review?.venueActivity;
  if (!activity || (historical && instrument !== "MARKET")) return null;
  const nasdaq = review.sources.find(source => source.id === activity.nasdaqTrfShare.sourceId);
  const cboe = review.sources.find(source => source.id === activity.bidsTouchedMillions.sourceId);
  const market = instrument === "MARKET";
  const tickers = instrument === "MARKET" ? ETFS : [instrument];
  return (
    <section id="off-exchange" className={`${styles.panel} ${styles.venuePanel}`} aria-labelledby="venue-heading">
      <h2 id="venue-heading">{market ? "Off-exchange trading" : `${instrument} off-exchange trading`}</h2>
      {!historical && (
        <div className={styles.venueReaders}>
          <p>Open a weekly ETF report on Tapeboard to compare shares traded on alternative trading systems (ATS) with other off-exchange volume. FINRA publishes the totals with a delay.</p>
          <nav aria-label="Weekly ETF volume reports" className={styles.venueLinks}>
            {tickers.map(symbol => (
              <a key={symbol} href={`https://tapeboard.com/dark-pool/${symbol}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${symbol} weekly volume on Tapeboard`}>
                {market ? symbol : `Open ${symbol} weekly volume`} <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            ))}
          </nav>
          <a className={styles.venueOfficial} href={FINRA_READER} target="_blank" rel="noopener noreferrer">FINRA’s official tables and reader agreement <ArrowUpRight size={14} aria-hidden="true" /></a>
        </div>
      )}
      {market && nasdaq && cboe && (
        <div className={styles.venueMarket}>
          <h3>U.S. trading venues · {quarter(activity.periodEnd)}</h3>
          <div className={styles.venueTiles}>
            <VenueTile title="Nasdaq trade reporting share" description="Share of U.S.-listed share volume reported through the FINRA/Nasdaq Trade Reporting Facility."
              comparison={activity.nasdaqTrfShare} unit="%" priorQuarter={quarter(activity.priorPeriodEnd)} filing={nasdaq} />
            <VenueTile title="BIDS Trading average daily volume" description="Cboe’s touched volume includes internally matched shares and shares routed to another market center for execution."
              comparison={activity.bidsTouchedMillions} unit="M" priorQuarter={quarter(activity.priorPeriodEnd)} filing={cboe} />
          </div>
          <p className={styles.finePrint}>These quarterly figures describe different parts of the U.S. market. They carry no directional weight.</p>
        </div>
      )}
    </section>
  );
}
