import type { Signal } from "@/lib/consensus/types";
import { effectiveStatus } from "@/lib/consensus/engine";
import styles from "./MorningBoard.module.css";

const quarter = (date: string) => `${date.slice(0, 4)} Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
const number = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dated = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric", timeZone: "UTC"});

/** Saved source context only. Never requests a provider or contributes a directional vote. */
export default function PrivateCreditContext({ signal, now }: { signal: Signal; now: string }) {
  const meta = signal.privateCredit, latest = signal.series.at(-1);
  if (!meta || !latest) return <p className={styles.finePrint}>Fed private-credit flows are unavailable. No value or daily direction is inferred.</p>;
  const points = signal.series, min = Math.min(0, ...points.map(p => p.value)), max = Math.max(0, ...points.map(p => p.value));
  const span = max - min || 1, zero = -min / span * 100;
  const estimated = latest.date > meta.inputThrough, stale = effectiveStatus(signal, now) === "stale";
  return (
    <div className={styles.privateCredit}>
      <p className={styles.panelSubtitle}>Private-credit loans · {quarter(latest.date)}</p>
      <span className={styles.status}>{stale ? "Stale · " : ""}{estimated ? "Estimated quarter" : "Quarterly context"} · no directional vote</span>
      <div className={styles.bigValue}>{number(latest.value)}<small>$bn SAAR</small></div>
      <p className={styles.panelSubtitle}>Net acquisition of loans by private debt funds</p>
      <figure className={styles.creditFigure}>
        <ol className={styles.creditBars} style={{gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`}} aria-label="Quarterly private-credit loan net acquisition, billions of US dollars at a seasonally adjusted annual rate">
          {points.map(point => {
            const estimate = point.date > meta.inputThrough, height = Math.abs(point.value) / span * 100;
            return <li key={point.date} aria-label={`${quarter(point.date)}: ${number(point.value)} billion US dollars SAAR${estimate ? ", estimated" : ""}`}>
              <strong aria-hidden="true">{number(point.value)}{estimate ? "*" : ""}</strong>
              <div className={styles.creditBarTrack} aria-hidden="true">
                <i className={styles.creditZero} style={{bottom: `${zero}%`}} />
                <i className={`${styles.creditBar} ${estimate ? styles.creditEstimate : ""}`} style={{height: `${height}%`, bottom: `${point.value < 0 ? zero - height : zero}%`}} />
              </div>
              <span aria-hidden="true">Q{Math.ceil(Number(point.date.slice(5, 7)) / 3)}<small>{point.date.slice(0, 4)}</small></span>
            </li>;
          })}
        </ol>
        <figcaption className={styles.finePrint}>
          $bn at a seasonally adjusted annual rate, not cash moved within the quarter. {points.some(p => p.date > meta.inputThrough) && "* Hatched bars are estimated quarters."}
        </figcaption>
      </figure>
      <dl className={styles.creditMetrics}>
        {signal.metrics.slice(1).map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{number(metric.value)} <small>$bn SAAR</small></dd></div>)}
      </dl>
      <p className={styles.finePrint}>Fed release {dated(signal.source.releasedAt!)}. Underlying inputs through {quarter(meta.inputThrough)}; later quarters are estimates. Loans are included in financial assets; these measures must not be added together.</p>
      <p className={styles.finePrint}>Private credit, not daily private-equity flows or capital calls.</p>
      <div className={styles.creditSources}>
        <a href={signal.source.url} target="_blank" rel="noreferrer">Federal Reserve table ↗</a>
        <a href={`${meta.documentation.url}#page=47`} target="_blank" rel="noreferrer">Release & units ↗</a>
      </div>
    </div>
  );
}
