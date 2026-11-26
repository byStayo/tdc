import { filedGuidanceRows, guidanceRows } from "@/lib/consensus/guidance";
import type { Instrument, Snapshot } from "@/lib/consensus/types";
import styles from "./GuidancePanel.module.css";

const amount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const date = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00Z` : s)
  .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

export default function GuidancePanel({ snapshot, instrument, reference }: {
  snapshot: Snapshot; instrument: Instrument; reference: string;
}) {
  const filed = filedGuidanceRows(snapshot, instrument, reference);
  const rows = guidanceRows(snapshot, instrument, reference).filter(row =>
    !filed.some(match => match.evidence.ticker === row.ticker && match.period === row.fiscalPeriod));
  if (!rows.length && !filed.length) return null;
  return <>{rows.length > 0 && <section className={styles.panel} aria-label="Company revenue guidance">
    <header>
      <span className={styles.eyebrow}>MANAGEMENT OUTLOOK</span>
      <h3>Before the next results</h3>
      <p>Selected companies’ published revenue ranges. These are management expectations, not reported results, analyst consensus or trading votes.</p>
    </header>
    <div className={styles.rows}>
      {rows.map((row) => <article key={row.ticker} className={styles.row} aria-label={`${row.ticker} ${row.fiscalPeriod} management guidance`}>
        <div className={styles.identity}>
          <h4>{row.ticker}</h4>
          <span>{row.fiscalPeriod}</span>
          <small>Issued {date(row.source.publishedAt)}</small>
        </div>
        <div>
          <div className={styles.range} aria-label={`Revenue guidance: $${amount(row.low)} to $${amount(row.high)} billion`}>
            <span><small>LOW</small><strong>${amount(row.low)}<em>bn</em></strong></span>
            <i aria-hidden="true" />
            <span><small>HIGH</small><strong>${amount(row.high)}<em>bn</em></strong></span>
          </div>
          <p className={styles.basis}>{row.revenue.kind === "midpoint_tolerance"
            ? `Company midpoint $${amount(row.revenue.midpoint)}bn ±${amount(row.revenue.tolerancePercent)}%; endpoints calculated.`
            : "Bounds supplied by management."}</p>
          {row.reviewDue && <p className={styles.reviewDue}><strong>Review due.</strong> {row.reviewDue}</p>}
          <details>
            <summary>Assumptions &amp; source</summary>
            <p>{row.assumptions}</p>
            <p>No verified actual for this guided quarter is compared here. This is a selected, dated statement; later company updates may supersede it.</p>
            <a href={row.source.url} target="_blank" rel="noreferrer">{row.source.name} ↗</a>
            <small>Source retrieved {date(row.source.retrievedAt)}. Its original issue date stays above.</small>
          </details>
        </div>
      </article>)}
    </div>
  </section>}
    {filed.length > 0 && <section className={styles.panel} aria-label="Filed revenue versus management guidance">
      <h3>Revenue versus management guidance</h3>
      <div className={styles.rows}>
        {filed.map(({ evidence: e, period, summary, filingURL, stale }) =>
          <article key={e.ticker} className={styles.row}>
            <div className={styles.identity}>
              <h4>{e.ticker}</h4><span>{period}</span>
              <small>Quarter ended {date(e.end)}{stale && " · stale"}</small>
            </div>
            <div>
              <p>{summary}</p>
              <details>
                <summary>Filing sources</summary>
                <a href={e.guidance.url} target="_blank" rel="noreferrer">Original guidance · filed {date(e.guidance.filed)} ↗</a>
                <a href={e.results.url} target="_blank" rel="noreferrer">Quarterly earnings release · filed {date(e.results.filed)} ↗</a>
                <a href={filingURL} target="_blank" rel="noreferrer">Form 10-Q · filed {date(e.quarterly.filed)} ↗</a>
                <small>All three filings first verified {date(e.firstEvidenceCompleteAt)}.</small>
              </details>
            </div>
          </article>)}
      </div>
    </section>}</>;
}
