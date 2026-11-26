import priceCheck from "@/public/research/etf-price-check-2026-09.json";
import { QUARTERLY_PRICE_FILE, validateQuarterlyPriceCheck } from "@/lib/consensus/quarterly-price-check";
import type { Instrument } from "@/lib/consensus/types";
import styles from "./MorningBoard.module.css";
import layout from "./MorningLayout.module.css";

export default function EtfPriceChecks({ instrument }: { instrument: Instrument }) {
  validateQuarterlyPriceCheck(priceCheck);
  const rows = priceCheck.funds.filter(row => instrument === "MARKET" || row.symbol === instrument);
  return (
    <section className={`${styles.panel} ${styles.experiments}`} aria-labelledby="etf-price-checks">
      <div className={styles.panelHead}><div>
        <h3 id="etf-price-checks">Historical price agreement</h3>
        <p className={styles.muted}>August 31 through October 1, 2026 · Before the first public forecast</p>
      </div></div>
      <div className={styles.tableScroll}>
        <table role="table">
          <caption>Checks passed out of all checks performed. Kibot and Market History had to agree within 0.03% at the open and 0.15% at the close, and give the same daily direction. Each longer window also had to agree after issuer dividends.</caption>
          <thead role="rowgroup"><tr role="row">
            <th scope="col" role="columnheader">ETF</th>
            <th scope="col" role="columnheader">Daily sessions</th>
            <th scope="col" role="columnheader">5-session windows</th>
            <th scope="col" role="columnheader">21-session windows</th>
            <th scope="col" role="columnheader">Dividend dates</th>
          </tr></thead>
          <tbody role="rowgroup">{rows.map(row => (
            <tr role="row" key={row.symbol}>
              <th scope="row" role="rowheader">{row.symbol}</th>
              <td role="cell" data-label="Daily sessions">{row.daily.passed} / {row.daily.checked}</td>
              <td role="cell" data-label="5-session windows">{row.weekly.passed} / {row.weekly.checked}</td>
              <td role="cell" data-label="21-session windows">{row.monthly.passed} / {row.monthly.checked}</td>
              <td role="cell" data-label="Dividend dates">{row.dividends.passed} / {row.dividends.checked}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {rows.some(row => row.symbol === "TLT" && row.weekly.changedByDividend === 1) &&
        <p className={styles.muted}>Including TLT’s dividend reversed the direction of one five-session return in both price series.</p>}
      <a className={layout.inspectLink} href={QUARTERLY_PRICE_FILE}>Inspect the comparison results</a>
    </section>
  );
}
