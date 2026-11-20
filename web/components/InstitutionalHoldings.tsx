import { ArrowUpRight } from "lucide-react";
import type { InstitutionalHoldings as Holdings } from "@/lib/consensus/holdings";
import type { Signal } from "@/lib/consensus/types";
import { effectiveStatus } from "@/lib/consensus/engine";
import styles from "./InstitutionalHoldings.module.css";

const date = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function InstitutionalHoldings({
  holdings,
  signals,
  reference,
  onInspect,
}: {
  holdings: Holdings[];
  signals: Signal[];
  reference: string;
  onInspect: () => void;
}) {
  if (!holdings.length) return null;
  return (
    <section
      className={styles.section}
      aria-label="Selected institutional holdings"
    >
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>INSIDE THE FILINGS</span>
          <h2>
            {holdings.length === 2
              ? "What two institutions disclosed."
              : "What this institution disclosed."}
          </h2>
        </div>
        <button
          onClick={onInspect}
          aria-label="Inspect original institutional filings"
        >
          Sources <ArrowUpRight size={16} />
        </button>
      </div>
      <p className={styles.intro}>
        Selected US equity disclosures. Quarter-end holdings show an earlier
        portfolio, not today’s trades or the holdings of your selected ETF.
      </p>
      <div className={styles.grid}>
        {holdings.map((item) => {
          const r = item.current,
            previous = item.previous,
            signal = signals.find((s) => s.id === `sec-holdings-${item.id}`),
            stale =
              !signal || effectiveStatus(signal, reference) !== "available";
          return (
            <article className={styles.card} key={item.id}>
              <div className={styles.cardHead}>
                <h3>{item.name}</h3>
                <span className={stale ? styles.stale : styles.badge}>
                  {stale ? "Older disclosure" : "Quarterly disclosure"}
                </span>
              </div>
              <p className={styles.dates}>
                Held {date(r.period)}
                <br />
                Filed {date(r.filedAt)}
              </p>
              <div className={styles.total}>
                <strong>{money(r.shareValueUSD)}</strong>
                <span>
                  reported non-option share value
                  <br />
                  {r.sharePositions.toLocaleString("en-US")} distinct positions
                </span>
              </div>
              <p className={styles.allocationLabel}>
                Largest positions · share of that reported value
              </p>
              <ol className={styles.allocations}>
                {r.top.map((position) => {
                  const weight = (position.valueUSD / r.shareValueUSD) * 100;
                  return (
                    <li key={`${position.issuer}|${position.securityClass}`}>
                      <div className={styles.row}>
                        <span>
                          {position.issuer}
                          <small>{position.securityClass}</small>
                        </span>
                        <strong>
                          {weight.toFixed(1)}%
                          <small>{money(position.valueUSD)}</small>
                        </strong>
                      </div>
                      <div className={styles.track} aria-hidden="true">
                        <span style={{ width: `${weight}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className={styles.remainder}>
                <span>Other disclosed share positions</span>
                <strong>
                  {((r.remainingValueUSD / r.shareValueUSD) * 100).toFixed(1)}%
                </strong>
              </div>
              <p className={styles.prior}>
                Previous quarter: {money(previous.shareValueUSD)} ·{" "}
                {date(previous.period)}. Value changes include market prices and
                position changes.
              </p>
              {r.confidentialOmitted && (
                <p className={styles.notice}>
                  The filer reports that confidential holdings were omitted.
                </p>
              )}
              {r.excludedValueUSD > 0 && (
                <p className={styles.notice}>
                  {money(r.excludedValueUSD)} of option or principal-amount
                  entries is excluded from these share allocations.
                </p>
              )}
              {signal?.collectionNote && (
                <p className={styles.notice}>{signal.collectionNote}</p>
              )}
              <a
                className={styles.filingLink}
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open {item.name} filing <ArrowUpRight size={15} />
              </a>
            </article>
          );
        })}
      </div>
      <p className={styles.finePrint}>
        13F disclosures omit cash, short positions and many other assets. The
        values above are not total assets under management, investment returns
        or capital flows. Each manager is shown separately; these filings add
        context and no directional vote.
      </p>
    </section>
  );
}
