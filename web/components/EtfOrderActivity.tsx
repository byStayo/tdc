import { effectiveStatus } from "@/lib/consensus/engine";
import { INSTRUMENTS, type Instrument, type Signal } from "@/lib/consensus/types";
import styles from "./EtfFlows.module.css";

const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const month = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Observation({ signal, reference, monthly = false }: { signal?: Signal; reference: string; monthly?: boolean }) {
  const point = signal?.series.at(-1);
  if (!signal || !point) return <span className={styles.activityDate}>Unavailable</span>;
  const label = (monthly ? month : day).format(new Date(point.date));
  return (
    <a href={signal.source.url} target="_blank" rel="noreferrer" className={styles.activityValue}
      aria-label={`${signal.title}, ${percent.format(point.value)} percent, ${label}. Open source`}>
      <strong>{percent.format(point.value)}%</strong>
      <span className={styles.activityDate}>
        {label}{effectiveStatus(signal, reference) === "stale" ? " · older" : ""}
      </span>
    </a>
  );
}

export default function EtfOrderActivity({ signals, instrument, reference }: {
  signals: Signal[]; instrument: Instrument; reference: string;
}) {
  const rows = INSTRUMENTS.filter(symbol => symbol !== "MARKET" && (instrument === "MARKET" || instrument === symbol))
    .map(symbol => ({
      symbol,
      exchange: signals.find(signal => signal.id === `sec-midas-${symbol}`),
      broker: signals.find(signal => signal.id === `etfiq-retail-${symbol}`),
    }));
  if (!rows.some(row => row.exchange || row.broker)) return null;
  return (
    <section className={styles.section} aria-labelledby="etf-order-activity">
      <header className={styles.heading}>
        <div><h2 id="etf-order-activity">ETF order activity</h2></div>
        <span>Quarterly exchange data · monthly broker data</span>
      </header>
      <table className={styles.activityTable}>
        <thead>
          <tr>
            <th scope="col">ETF</th>
            <th scope="col">Lit trade volume / order volume <span>SEC MIDAS</span></th>
            <th scope="col">Share of retail order dollars <span>ETFIQ estimate</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.symbol}>
              <th scope="row">{row.symbol}</th>
              <td><Observation signal={row.exchange} reference={reference} /></td>
              <td><Observation signal={row.broker} reference={reference} monthly /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.note}>The SEC sample is exchange activity. ETFIQ covers a subset of orders reported by four retail brokers. Both combine buys and sells and carry no directional vote.</p>
    </section>
  );
}
