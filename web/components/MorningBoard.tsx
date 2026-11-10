"use client";
import PublicationFooter from "@/components/PublicationFooter";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Coffee,
  ExternalLink,
  Globe2,
  History,
  Info,
  Layers3,
  X,
} from "lucide-react";
import { eventUpcoming } from "@/lib/consensus/time";
import { policyReadings } from "@/lib/consensus/policy";
import type { NewsPulse } from "@/lib/consensus/news";
import { effectiveStatus } from "@/lib/consensus/engine";
import { asIssuedConsensus } from "@/lib/consensus/as-issued";
import { performanceView } from "@/lib/consensus/performance-view";
import { editionTiming } from "@/lib/consensus/edition-timing";
import { FAMILIES } from "@/lib/consensus/registry";
import { HORIZONS, INSTRUMENTS } from "@/lib/consensus/types";
import type { PerformanceReport } from "@/lib/consensus/performance-types";
import type {
  Catalyst,
  Family,
  HistoryEntry,
  Horizon,
  Instrument,
  Point,
  Signal,
  Snapshot,
} from "@/lib/consensus/types";
import styles from "./MorningBoard.module.css";
import MorningMarket from "./MorningMarket";
import PublicationHeader from "./PublicationHeader";
import ResearchSection from "./ResearchSection";
import CommunityPanel from "./CommunityPanel";
import RetailOutlook from "./RetailOutlook";
import GuidancePanel from "./GuidancePanel";
import ReportedEpsComparison from "./ReportedEpsComparison";
import EtfFlows from "./EtfFlows";
import PrivateCreditContext from "./PrivateCreditContext";
import OffExchangeActivity from "./OffExchangeActivity";
import layout from "./MorningLayout.module.css";
import InstitutionalHoldings from "./InstitutionalHoldings";
import { signalMetricLabel } from "@/lib/display-format";
import { taiwanDataCredit, TAIWAN_LICENSE_URL, TAIWAN_OPEN_DATA_NOTICE, TAIWAN_TRANSFORM_NOTICE } from "@/lib/consensus/taiwan-attribution";

const pct = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;
const number = (value: number, decimals = 2) =>
  value.toLocaleString("en-US", { maximumFractionDigits: decimals });
const date = (value: string) =>
  new Date(
    value.length === 10 ? `${value}T12:00:00Z` : value,
  ).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
const time = (value: string) =>
  new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
const datedYear = (value: string) =>
  new Date(
    value.length === 10 ? `${value}T12:00:00Z` : value,
  ).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
interface Experiments {
  experiments: {
    id: string;
    instrument: string;
    horizon: string;
    testSamples?: number;
    candidateBrier?: number;
    baseRateBrier?: number;
    baselineBeaten: boolean;
  }[];
  source: { url: string };
  note: string;
}
const names: Record<Instrument, string> = {
  MARKET: "Market overview",
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  IWM: "Small caps",
  DIA: "Dow 30",
  TLT: "Long Treasuries",
};
function Sparkline({
  series,
  color = "var(--accent)",
  label,
  large = false,
  stepped = false,
}: {
  series: Point[];
  color?: string;
  label: string;
  large?: boolean;
  stepped?: boolean;
}) {
  if (series.length < 2)
    return <div className={styles.noChart}>No observed series</div>;
  const data = series.slice(-60),
    min = Math.min(...data.map((point) => point.value)),
    max = Math.max(...data.map((point) => point.value)),
    spread = max - min || Math.max(Math.abs(max) * 0.01, 1),
    width = 300,
    height = large ? 130 : 64;
  const xy = data.map((point, i) => [
    (i / (data.length - 1)) * (width - 8) + 4,
    height - 10 - ((point.value - min) / spread) * (height - 20),
  ]);
  const points = xy
    .flatMap(([x, y], i) =>
      stepped && i > 0 ? [`${x},${xy[i - 1][1]}`, `${x},${y}`] : [`${x},${y}`],
    )
    .join(" ");
  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}; ${datedYear(data[0].date)} to ${datedYear(data.at(-1)!.date)}; latest ${number(data.at(-1)!.value, 4)}`}
    >
      <path
        d={`M 4 ${height - 6} H ${width - 4}`}
        stroke="var(--border)"
        strokeDasharray="3 4"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
function FuturesOptions({ signals, reference, onInspect }: { signals: Signal[]; reference: string; onInspect: () => void }) {
  const rows = signals.filter(signal => signal.id.startsWith("tff-options-"));
  if (!rows.length) return null;
  return (
    <section className={styles.panel} aria-label="Futures options positioning">
      <div className={styles.panelHead}>
        <div><span className={styles.eyebrow}>WEEKLY CFTC REPORT</span><h3>Futures options positioning</h3></div>
        <button onClick={onInspect} aria-label="Inspect CFTC futures options sources"><ArrowUpRight size={18} /></button>
      </div>
      <p className={styles.panelSubtitle}>Options contribution to open interest, in futures equivalents</p>
      <dl className={styles.futuresOptionsRows}>
        {rows.map(signal => {
          const point = signal.series[0];
          const status = effectiveStatus(signal, reference);
          return (
            <div key={signal.id}>
              <dt>{signal.shortLabel}</dt>
              <dd>
                <strong>{point ? number(point.value, 0) : "Unavailable"}</strong>
                {point && <span>{datedYear(point.date)}{status === "stale" ? " · Stale" : ""}</span>}
                {signal.collectionNote && <p className={styles.finePrint}>{signal.collectionNote}</p>}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className={styles.finePrint}>CFTC converts options to futures equivalents using exchange delta factors. Changes can reflect both positions and deltas. ETF option chains and implied volatility have separate coverage.</p>
    </section>
  );
}
function TaiwanMarket({ signals, reference, onInspect }: { signals: Signal[]; reference: string; onInspect: () => void }) {
  const rows = signals.filter(signal => signal.id === "twse-taiex-price" || signal.id === "twse-taiex-return");
  if (!rows.length) return null;
  return (
    <section className={`${styles.panel} ${styles.taiwanPanel}`} aria-label="Taiwan equity indices">
      <div className={styles.panelHead}>
        <div><span className={styles.eyebrow}>INTERNATIONAL EQUITIES</span><h3>Taiwan, at the close.</h3></div>
        <button onClick={onInspect} aria-label="Inspect Taiwan index sources"><ArrowUpRight size={18} /></button>
      </div>
      <p className={styles.panelSubtitle}>TAIEX · Taiwan listed equities · dated end-of-day observations</p>
      <div className={styles.taiwanRows}>
        {rows.map(signal => {
          const latest = signal.series.at(-1), change = signal.metrics.find(m => m.label === "Observed-session change"), status = effectiveStatus(signal, reference);
          return (
            <div className={styles.taiwanRow} key={signal.id}>
              <div className={styles.taiwanLabel}>
                <strong>{signal.shortLabel}</strong>
                <span>{latest ? `${datedYear(latest.date)} · Taiwan session` : "Observation unavailable"}</span>
                <span>{signal.id === "twse-taiex-return" ? "Distributions reinvested" : "Price index · distributions excluded"}</span>
                {status !== "available" && <span className={styles.status}>{status === "stale" ? "Stale observation" : "Unavailable"}</span>}
              </div>
              <div className={styles.taiwanValue}>
                <strong>{latest ? latest.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</strong>
                <span>index points</span>
                <span className={change ? change.value >= 0 ? styles.up : styles.down : undefined}>
                  {change ? `${change.value < 0 ? "−" : change.value > 0 ? "+" : ""}${Math.abs(change.value).toFixed(2)}% vs prior observation` : "Prior observation unavailable"}
                </span>
              </div>
              <div className={styles.taiwanChart}>
                {signal.series.length > 1 ? <Sparkline series={signal.series} label={`${signal.shortLabel}, index points, independent scale`} /> : <div className={styles.noChart}>{latest ? "One observed session" : "No observed series"}</div>}
                {latest && <span>{signal.series.length} sessions · {date(signal.series[0].date)}–{date(latest.date)}</span>}
              </div>
              {signal.collectionNote && <p className={styles.taiwanNotice}>{signal.collectionNote}</p>}
            </div>
          );
        })}
      </div>
      <p className={styles.finePrint}>Two related measures, each on its own scale. Taiwan context only; neither casts a directional vote or supplies US ETF outcomes. Other regions remain incomplete. The source provides the latest month, so the first session has no prior-session comparison.</p>
      <div className={styles.taiwanAttribution}>
        {rows.filter(s => s.source.observedAt).map(s => <span key={s.id}>{taiwanDataCredit(s.id, s.source.observedAt!.slice(0, 4))}</span>)}
        <span>{TAIWAN_OPEN_DATA_NOTICE}</span>
        <a href={TAIWAN_LICENSE_URL} target="_blank" rel="noopener noreferrer">Open Government Data License 1.0 <ExternalLink size={13} /></a>
        <span>{TAIWAN_TRANSFORM_NOTICE}</span>
      </div>
    </section>
  );
}
function Gauge({ score, abstain }: { score: number | null; abstain: boolean }) {
  const value = score ?? 0,
    angle = Math.PI * (1 - (value + 1) / 2),
    x = 150 + 104 * Math.cos(angle),
    y = 135 - 104 * Math.sin(angle);
  return (
    <svg
      viewBox="0 0 300 175"
      className={styles.gauge}
      role="img"
      aria-label={
        abstain
          ? "Trading call withheld. See the reasons below."
          : `Available-input balance ${score === null ? "unavailable" : number(value * 100, 0)} on a scale from -100 to 100. Heuristic directional lean.`
      }
    >
      <path
        d="M 30 135 A 120 120 0 0 1 270 135"
        fill="none"
        stroke="var(--border)"
        strokeWidth="14"
      />
      <path
        d="M 30 135 A 120 120 0 0 1 90 31"
        fill="none"
        stroke={abstain ? "var(--border)" : "var(--negative)"}
        strokeWidth="14"
      />
      <path
        d="M 210 31 A 120 120 0 0 1 270 135"
        fill="none"
        stroke={abstain ? "var(--border)" : "var(--positive)"}
        strokeWidth="14"
      />
      {!abstain && score !== null && (
        <>
          <line
            x1="150"
            y1="135"
            x2={x}
            y2={y}
            stroke="var(--text)"
            strokeWidth="2"
          />
          <circle cx="150" cy="135" r="5" fill="var(--text)" />
        </>
      )}
      <text x="150" y="104" textAnchor="middle" className={styles.gaugeValue}>
        {abstain || score === null
          ? "—"
          : `${score > 0 ? "+" : ""}${Math.round(score * 100)}`}
      </text>
      <text x="150" y="123" textAnchor="middle" className={styles.gaugeCaption}>
        {abstain ? "CALL WITHHELD" : "INPUT BALANCE"}
      </text>
      <text x="25" y="163" className={styles.gaugeCaption}>
        DEFENSIVE
      </text>
      <text x="275" y="163" textAnchor="end" className={styles.gaugeCaption}>
        SUPPORTIVE
      </text>
    </svg>
  );
}
function Divergence({
  value,
  muted = false,
}: {
  value: number | null;
  muted?: boolean;
}) {
  return (
    <div className={styles.divergence} aria-hidden="true">
      <span />
      <i
        style={{
          left: value !== null && value < 0 ? `${50 + value * 50}%` : "50%",
          width: value === null ? "0%" : `${Math.abs(value) * 50}%`,
          background: muted
            ? "var(--text-muted)"
            : value !== null && value < 0
              ? "var(--negative)"
              : "var(--positive)",
        }}
      />
    </div>
  );
}
function SourceDrawer({
  family,
  snapshot,
  instrument,
  now,
  onClose,
}: {
  family: Family | null;
  snapshot: Snapshot;
  instrument: Instrument;
  now: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (family && !dialog.current?.open) dialog.current?.showModal();
    if (!family && dialog.current?.open) dialog.current?.close();
  }, [family]);
  const definition = FAMILIES.find((item) => item.id === family);
  return (
    <dialog
      ref={dialog}
      className={styles.drawer}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="source-drawer-title"
    >
      <div className={styles.drawerHead}>
        <div>
          <span className={styles.eyebrow}>FOLLOW THE EVIDENCE</span>
          <h2 id="source-drawer-title">{definition?.label}</h2>
        </div>
        <button
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close source details"
        >
          <X size={21} />
        </button>
      </div>
      <p className={styles.muted}>
        {definition?.detail}. Dates refer to the actual observation, not when
        you opened this page.
      </p>
      {snapshot.signals
        .filter(
          (signal) =>
            signal.family === family && signal.instruments.includes(instrument),
        )
        .map((signal) => (
          <article className={styles.sourceItem} key={signal.id}>
            <div className={styles.cardTop}>
              <h3>{signal.title}</h3>
              <span className={styles.status}>
                {effectiveStatus(signal, now).replace("_", " ")}
              </span>
            </div>
            <p>{signal.summary}</p>
            {signal.collectionNote && (
              <p className={styles.finePrint}>{signal.collectionNote}</p>
            )}
            {signal.series.length > 1 && (
              <Sparkline
                series={signal.series}
                label={signal.title}
                large
                stepped={signal.source.frequency === "daily policy level"}
              />
            )}
            {!!signal.metrics.length && (
              <dl className={styles.sourceFacts}>
                {signal.metrics.map((metric) => (
                  <div key={metric.label}>
                    <dt>{metric.label}</dt>
                    <dd>
                      {signalMetricLabel(metric, signal.family)} ·{" "}
                      {datedYear(metric.date)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <dl className={styles.sourceFacts}>
              <div>
                <dt>Observed</dt>
                <dd>
                  {signal.source.observedAt
                    ? datedYear(signal.source.observedAt)
                    : "No observation"}
                </dd>
              </div>
              <div>
                <dt>Cadence</dt>
                <dd>{signal.source.frequency}</dd>
              </div>
              <div>
                <dt>Collected</dt>
                <dd>
                  {date(signal.source.retrievedAt)} ·{" "}
                  {time(signal.source.retrievedAt)} ET
                </dd>
              </div>
              <div>
                <dt>Released</dt>
                <dd>
                  {signal.source.releasedAt
                    ? signal.source.releasedAt.length === 10
                      ? `${datedYear(signal.source.releasedAt)} · time not supplied`
                      : `${datedYear(signal.source.releasedAt)} · ${time(signal.source.releasedAt)} ET`
                    : "Not supplied by source"}
                </dd>
              </div>
            </dl>
            <details>
              <summary>Calculation & limitations</summary>
              <p>{signal.methodology}</p>
              <p>{signal.limitation}</p>
              <p>{signal.source.attribution}</p>
              <p>{signal.source.usage}</p>
              {signal.id === "policy-boe-bank" && (
                <a
                  href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Government Licence v3.0
                </a>
              )}
            </details>
            <a
              href={signal.source.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {signal.source.name === "Not connected"
                ? "Source requirements"
                : `Open ${signal.source.name}`}{" "}
              <ExternalLink size={13} />
            </a>
          </article>
        ))}
    </dialog>
  );
}
function Curve({ signals }: { signals: Signal[] }) {
  const selected = ["DGS2", "DGS10", "DGS30"].map((id) =>
    signals.find((signal) => signal.id === `fred-${id}`),
  );
  const common = selected[0]?.series
    .map((point) => point.date)
    .filter((day) =>
      selected.every((signal) =>
        signal?.series.some((point) => point.date === day),
      ),
    )
    .at(-1);
  const values = selected.map(
    (signal) =>
      signal?.series.find((point) => point.date === common)?.value ?? null,
  );
  if (!common || values.some((value) => value === null))
    return <p className={styles.muted}>No complete same-date yield curve.</p>;
  const numbers = values as number[],
    min = Math.floor((Math.min(...numbers) - 0.2) * 2) / 2,
    max = Math.ceil((Math.max(...numbers) + 0.2) * 2) / 2;
  const xs = [30, 150, 330],
    ys = numbers.map((value) => 140 - ((value - min) / (max - min)) * 110);
  return (
    <>
      <div className={styles.curveMetrics}>
        {numbers.map((value, i) => (
          <div key={i}>
            <span>{[2, 10, 30][i]} YEAR</span>
            <strong>
              {value.toFixed(2)}
              <small>%</small>
            </strong>
          </div>
        ))}
      </div>
      <svg
        className={styles.curve}
        viewBox="0 0 360 180"
        role="img"
        aria-label={`Treasury yield curve on ${date(common)}: 2-year ${numbers[0]}%, 10-year ${numbers[1]}%, 30-year ${numbers[2]}%.`}
      >
        {[40, 85, 130].map((y) => (
          <line
            key={y}
            x1="15"
            x2="345"
            y1={y}
            y2={y}
            stroke="var(--border)"
            strokeDasharray="3 5"
          />
        ))}
        <polyline
          points={xs.map((x, i) => `${x},${ys[i]}`).join(" ")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="3"
        />
        {xs.map((x, i) => (
          <g key={x}>
            <circle
              cx={x}
              cy={ys[i]}
              r="5"
              fill="var(--panel)"
              stroke="var(--accent)"
              strokeWidth="3"
            />
            <text
              x={x}
              y="169"
              textAnchor="middle"
              className={styles.gaugeCaption}
            >
              {[2, 10, 30][i]}Y
            </text>
          </g>
        ))}
      </svg>
      <div className={styles.chartFoot}>
        <span>
          10Y − 2Y{" "}
          <strong>{number((numbers[1] - numbers[0]) * 100, 0)} bp</strong>
        </span>
        <span>{date(common)} · FRED</span>
      </div>
    </>
  );
}
function Liquidity({ signals }: { signals: Signal[] }) {
  const assets = signals.find((signal) => signal.id === "fred-WALCL"),
    treasury = signals.find((signal) => signal.id === "fred-WTREGEN"),
    repo = signals.find((signal) => signal.id === "fred-RRPONTSYD");
  const series =
    assets?.series.flatMap((point) => {
      const cash = treasury?.series.find((item) => item.date === point.date),
        reverse = repo?.series.find((item) => item.date === point.date);
      return cash && reverse
        ? [
            {
              date: point.date,
              value: (point.value - cash.value) / 1000 - reverse.value,
            },
          ]
        : [];
    }) ?? [];
  const latest = series.at(-1),
    previous = series.at(-2),
    change = latest && previous ? latest.value - previous.value : null;
  return (
    <>
      <div className={styles.bigValue}>
        {latest ? `$${number(latest.value / 1000, 2)}` : "—"}
        <small>{latest ? "trillion" : ""}</small>
      </div>
      <div className={change !== null && change >= 0 ? styles.up : styles.down}>
        {change === null
          ? "Awaiting aligned observations"
          : `${change >= 0 ? "+" : "−"}$${number(Math.abs(change), 1)}bn since prior common date`}
      </div>
      <Sparkline
        series={series}
        label="Fed assets minus Treasury cash and overnight reverse repo, in billions of dollars"
        color="var(--positive)"
        large
      />
      <p className={styles.chartFoot}>
        Fed assets − TGA − ON RRP ·{" "}
        {latest ? date(latest.date) : "no common date"}
      </p>
      <p className={styles.finePrint}>
        A US liquidity proxy. Components are aligned by observation date; this
        is not total global liquidity.
      </p>
    </>
  );
}

function CapitalPanels({
  signals,
  now,
  onInspect,
}: {
  signals: Signal[];
  now: string;
  onInspect: () => void;
}) {
  const inward = signals.find((s) => s.id === "tic-for_lt_total"),
    outward = signals.find((s) => s.id === "tic-us_lt_total"),
    privateEquity = signals.find((s) => s.id === "sec-private-equity-assets"),
    privateCredit = signals.find((s) => s.id === "fed-private-credit-loans");
  if (!inward && !privateEquity && !privateCredit) return null;
  const latest = inward?.series.at(-1),
    out = outward?.series.find((p) => p.date === latest?.date),
    net = latest && out ? latest.value - out.value : null,
    rows = [
      ["for_lt_treas", "Treasuries"],
      ["for_lt_agcy", "Agency bonds"],
      ["for_lt_corp", "Corporate bonds"],
      ["for_lt_eqty", "Equities"],
    ].map(([key, label]) => ({
      label,
      value:
        signals
          .find((s) => s.id === `tic-${key}`)
          ?.series.find((p) => p.date === latest?.date)?.value ?? null,
    })),
    scale = Math.max(1, ...rows.map((row) => Math.abs(row.value ?? 0))),
    gross = privateEquity?.metrics.find((m) => m.label === "Gross asset value"),
    nav = privateEquity?.metrics.find((m) => m.label === "Net asset value"),
    count = privateEquity?.metrics.find((m) => m.label === "Reported funds"),
    month = latest
      ? new Date(`${latest.date}T12:00:00Z`).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : null;
  const privateEquityAssets = (<>
        <p className={styles.panelSubtitle}>
          {gross
            ? `Period ended ${datedYear(gross.date)}`
            : "Awaiting reported aggregates"}{" "}
          · SEC Form PF
        </p>
        <span className={styles.status}>
          {privateEquity
            ? effectiveStatus(privateEquity, now) === "stale"
              ? "Stale · historical context"
              : privateEquity.status === "available"
                ? "Reported asset stock"
                : "Unavailable"
            : "Unavailable"}
        </span>
        <div className={styles.bigValue}>
          {gross ? `$${number(gross.value / 1000, 2)}` : "—"}
          <small>{gross ? "trillion gross assets" : ""}</small>
        </div>
        {privateEquity && (
          <Sparkline
            series={privateEquity.series}
            label="SEC reported aggregate private-equity gross assets in billions of dollars"
            large
          />
        )}
        <div className={styles.chartFoot}>
          <span>
            {nav
              ? `$${number(nav.value / 1000, 2)}T net assets`
              : "Net assets unavailable"}
          </span>
          <span>
            {count
              ? `${number(count.value, 0)} reported funds`
              : "Fund count unavailable"}
          </span>
        </div>
        <p className={styles.finePrint}>
          Assets are not capital calls, distributions or today's investment
          flows. Most advisers report annually; the source is published with a
          substantial lag. No directional vote.
        </p>
  </>);
  return (
    <div className={`${styles.twoColumns} ${styles.capitalPanels}`}>
      <section className={styles.panel} aria-label="Cross-border capital flows">
        <div className={styles.panelHead}>
          <h3>Where capital is moving</h3>
          <button onClick={onInspect} aria-label="Inspect capital-flow sources">
            <ArrowUpRight size={18} />
          </button>
        </div>
        <p className={styles.panelSubtitle}>
          {month ?? "Awaiting monthly data"} · Treasury cross-border
          transactions
        </p>
        {inward && effectiveStatus(inward, now) === "stale" && (
          <span className={styles.status}>Stale observation</span>
        )}
        <div className={styles.bigValue}>
          {net === null ? "—" : `$${number(Math.abs(net), 1)}`}
          <small>{net === null ? "" : "billion"}</small>
        </div>
        <p className={styles.panelSubtitle}>
          {net === null
            ? "No aligned inward and outward observations"
            : `Net ${net >= 0 ? "inward" : "outward"} long-term securities transactions`}
        </p>
        <div
          className={styles.flowBars}
          aria-label="Foreign net purchases of US securities in billions of dollars"
        >
          {rows.map((row) => (
            <div key={row.label}>
              <span>{row.label}</span>
              <div className={styles.flowTrack} aria-hidden="true">
                <i
                  style={{
                    left:
                      row.value !== null && row.value < 0
                        ? `${50 - (Math.abs(row.value) / scale) * 50}%`
                        : "50%",
                    width:
                      row.value === null
                        ? "0%"
                        : `${(Math.abs(row.value) / scale) * 50}%`,
                    background:
                      row.value !== null && row.value < 0
                        ? "var(--text-muted)"
                        : "var(--accent)",
                  }}
                />
              </div>
              <strong>
                {row.value === null
                  ? "—"
                  : `${row.value >= 0 ? "+" : "−"}${number(Math.abs(row.value), 1)}`}
              </strong>
            </div>
          ))}
        </div>
        <p className={styles.finePrint}>
          Bars show foreign net purchases of US assets ($bn).{" "}
          {latest && out
            ? `Total $${number(latest.value, 1)}bn, less $${number(out.value, 1)}bn of US net purchases abroad.`
            : "Both totals must share a reporting month."}{" "}
          Negative means net sales.
        </p>
        <p className={styles.finePrint}>
          Lagged monthly flows, excluding short-term and banking flows. Changes
          in asset values are separate. No daily directional vote.
        </p>
      </section>
      <section
        className={styles.panel}
        aria-label="Private-capital context"
      >
        <div className={styles.panelHead}>
          <h3>The private-capital backdrop</h3>
          <button
            onClick={onInspect}
            aria-label="Inspect private-capital sources"
          >
            <ArrowUpRight size={18} />
          </button>
        </div>
        {privateCredit ? (
          <>
            <PrivateCreditContext signal={privateCredit} now={now} />
            <details className={styles.olderCapital}>
              <summary>
                Older private-equity assets · {gross ? datedYear(gross.date) : "unavailable"}
                {privateEquity && effectiveStatus(privateEquity, now) === "stale" ? " · stale" : ""}
              </summary>
              {privateEquityAssets}
            </details>
          </>
        ) : privateEquityAssets}
      </section>
    </div>
  );
}

function eventLabel(item: Catalyst) {
  const zone =
    item.dateZone === "Asia/Tokyo"
      ? "Tokyo"
      : item.dateZone === "Europe/London"
        ? "London"
        : item.dateZone === "Europe/Berlin"
          ? "Frankfurt"
          : null;
  return item.at.length === 10
    ? `${date(item.at)} · ${zone ? `${zone} date` : "date only"}`
    : `${date(item.at)} · ${time(item.at)} ET`;
}
function NewsPanel({
  pulse,
  onInspect,
  collectionNote,
}: {
  pulse: NewsPulse;
  onInspect: () => void;
  collectionNote?: string;
}) {
  const bins = [
    {
      label: "Negative language",
      count: pulse.negative,
      color: "var(--negative)",
    },
    {
      label: "Balanced language",
      count: pulse.balanced,
      color: "var(--text-muted)",
    },
    {
      label: "Positive language",
      count: pulse.positive,
      color: "var(--positive)",
    },
  ];
  return (
    <section
      className={`${styles.panel} ${styles.newsPanel}`}
      aria-label="Global financial news sample"
    >
      <div className={styles.panelHead}>
        <div>
          <span className={styles.eyebrow}>THE NEWS CYCLE</span>
          <h3>The language around the market.</h3>
        </div>
        <button
          className={styles.iconButton}
          onClick={onInspect}
          aria-label="Inspect news sources"
        >
          <Info size={16} />
        </button>
      </div>
      <p className={styles.muted}>
        {pulse.storyCount} sampled stories · {pulse.publishers} publishers ·
        English-language global coverage
      </p>
      {collectionNote && <p className={styles.finePrint}>{collectionNote}</p>}
      <div
        className={styles.newsDistribution}
        role="img"
        aria-label={bins
          .map((bin) => `${bin.count} ${bin.label.toLowerCase()} stories`)
          .join(", ")}
      >
        {bins.map((bin) => (
          <span
            key={bin.label}
            style={{
              width: `${(bin.count / pulse.storyCount) * 100}%`,
              background: bin.color,
            }}
          />
        ))}
      </div>
      <div className={styles.newsLegend}>
        {bins.map((bin) => (
          <span key={bin.label}>
            <i style={{ background: bin.color }} />
            <strong>{bin.count}</strong>
            {bin.label}
          </span>
        ))}
      </div>
      <p className={styles.finePrint}>
        A 15-minute discovery batch, not a full-day survey. Positive language is
        not a bullish forecast. This tone sample casts no directional vote.
      </p>
      <div className={styles.newsStories}>
        {pulse.stories.slice(0, 6).map((story) => (
          <a
            key={story.id}
            href={story.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>
              {story.domain} ·{" "}
              {story.publishedAt
                ? `published ${date(story.publishedAt)} ${time(story.publishedAt)} ET`
                : "publication time not supplied"}
            </span>
            <strong>
              {story.title}
              <ArrowUpRight size={14} />
            </strong>
            <small>
              Tone {story.tone > 0 ? "+" : ""}
              {number(story.tone, 1)} · {story.mentions} matched article
              {story.mentions === 1 ? "" : "s"}
            </small>
          </a>
        ))}
      </div>
      <p className={styles.chartFoot}>
        <a
          href="https://www.gdeltproject.org/"
          target="_blank"
          rel="noopener noreferrer"
        >
          The GDELT Project
        </a>{" "}
        · Batch {date(pulse.batchAt)} {time(pulse.batchAt)} ET ·{" "}
        <a href={pulse.sourceUrl} target="_blank" rel="noopener noreferrer">
          Data source
        </a>
      </p>
    </section>
  );
}

function PolicyRates({
  signals,
  reference,
  onInspect,
}: {
  signals: Signal[];
  reference: string;
  onInspect: (family: Family) => void;
}) {
  if (!signals.some((signal) => signal.id.startsWith("policy-"))) return null;
  const rows = policyReadings(signals, reference),
    values = rows.flatMap((row) =>
      row.lower === null || row.upper === null ? [] : [row.lower, row.upper],
    );
  const min = Math.min(0, Math.floor(Math.min(...values, 0))),
    max = Math.max(5, Math.ceil(Math.max(...values, 5))),
    position = (value: number) => ((value - min) / (max - min)) * 100;
  return (
    <section
      className={`${styles.panel} ${styles.policyPanel}`}
      aria-label="Central-bank policy rates"
    >
      <div className={styles.panelHead}>
        <div>
          <span className={styles.eyebrow}>THE GLOBAL COST OF MONEY</span>
          <h3>Four policy desks. Different settings.</h3>
        </div>
      </div>
      <p className={styles.panelSubtitle}>
        Official nominal policy rates · shared percent scale
      </p>
      <div className={styles.policyLanes}>
        {rows.map((row) => (
          <button
            key={row.currency}
            className={styles.policyRow}
            onClick={() => onInspect(row.family)}
            aria-label={`Inspect ${row.name} rate`}
          >
            <span className={styles.policyLabel}>
              <strong>
                {row.currency} <span>{row.name}</span>
              </strong>
              <small>{row.definition}</small>
            </span>
            <span className={styles.policyTrack} aria-hidden="true">
              {[0, 25, 50, 75, 100].map((tick) => (
                <i
                  className={styles.policyTick}
                  style={{ left: `${tick}%` }}
                  key={tick}
                />
              ))}
              {row.lower !== null && row.upper !== null && (
                <>
                  <i
                    className={styles.policyRange}
                    style={{
                      left: `${position(row.lower)}%`,
                      width: `${position(row.upper) - position(row.lower)}%`,
                      opacity: row.stale ? 0.4 : 1,
                    }}
                  />
                  <i
                    className={`${styles.policyDot} ${row.approximate ? styles.approximateDot : ""}`}
                    style={{
                      left: `${position(row.lower)}%`,
                      opacity: row.stale ? 0.4 : 1,
                    }}
                  />
                  {row.upper !== row.lower && (
                    <i
                      className={styles.policyDot}
                      style={{
                        left: `${position(row.upper)}%`,
                        opacity: row.stale ? 0.4 : 1,
                      }}
                    />
                  )}
                </>
              )}
            </span>
            <span className={styles.policyValue}>
              {row.lower === null
                ? "—"
                : `${row.approximate ? "≈ " : ""}${number(row.lower, 2)}${row.upper !== row.lower ? `–${number(row.upper!, 2)}` : ""}%`}
              <small>
                {row.at ? date(row.at) : "Unavailable"}
                {row.stale ? " · stale" : ""}
              </small>
            </span>
            <span className={styles.policyDateNote}>
              {row.note}
              {row.at ? ` · ${datedYear(row.at)}` : ""}
              <ArrowUpRight size={12} />
            </span>
          </button>
        ))}
        <div
          className={`${styles.policyRow} ${styles.policyAxis}`}
          aria-hidden="true"
        >
          <span />
          <div>
            {[0, 25, 50, 75, 100].map((tick) => (
              <span key={tick} style={{ left: `${tick}%` }}>
                {number(min + ((max - min) * tick) / 100, 2)}%
              </span>
            ))}
          </div>
          <span />
        </div>
      </div>
      <p className={styles.chartFoot}>
        A range, a deposit rate, Bank Rate and an approximate target measure
        different policy settings. Dates vary. These levels alone do not
        forecast currencies or the next rate decision. Select a bank to inspect
        its source.
      </p>
    </section>
  );
}

function ReviewedDevelopments({
  snapshot,
  instrument,
  reference,
}: {
  snapshot: Snapshot;
  instrument: Instrument;
  reference: string;
}) {
  const review = snapshot.review;
  if (!review) return null;
  const developments = review.developments
    .filter((item) =>
      item.impacts.some((impact) => impact.instrument === instrument),
    )
    .slice(0, 3);
  if (!developments.length) return null;
  return (
    <section
      className={styles.reviewedSection}
      aria-label="Reviewed market developments"
    >
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>
            FACT → TRANSMISSION → YOUR MARKET
          </span>
          <h2>What changed. Why it matters.</h2>
        </div>
        <span>{names[instrument]} · selected primary sources</span>
      </div>
      <div className={styles.reviewedGrid}>
        {developments.map((item) => {
          const sources = item.sourceIds.map(
            (id) => review.sources.find((source) => source.id === id)!,
          );
          const impact = item.impacts.find(
            (entry) => entry.instrument === instrument,
          )!;
          const signal = snapshot.signals.find(
            (entry) => entry.id === `review-${item.id}`,
          )!;
          const stale = effectiveStatus(signal, reference) !== "available";
          return (
            <article className={styles.reviewedCard} key={item.id}>
              <div className={styles.reviewedMeta}>
                <span>{date(sources[0].publishedAt)} · published</span>
                <span>{stale ? "Older context" : "Source checked"}</span>
              </div>
              <h3>{item.title}</h3>
              <div className={styles.transmission}>
                <ArrowRight size={20} aria-hidden="true" />
                <div>
                  <span className={styles.eyebrow}>POSSIBLE MARKET EFFECT</span>
                  <strong>{impact.channel}</strong>
                </div>
              </div>
              <details>
                <summary>Read the context & sources</summary>
                <span className={styles.eyebrow}>REPORTED FACTS</span>
                <p>{item.facts}</p>
                <span className={styles.eyebrow}>EDITORIAL INTERPRETATION</span>
                <p className={styles.interpretation}>{impact.interpretation}</p>
                <p>{item.limitation}</p>
                {sources.map((source) => (
                  <a
                    key={source.id}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.name}
                    <ArrowUpRight size={13} />
                  </a>
                ))}
              </details>
            </article>
          );
        })}
      </div>
      <p className={styles.chartFoot}>
        Facts and editorial interpretation are separate. No measured price
        reaction or directional vote is implied. Reviewed{" "}
        {date(review.reviewedAt)} at {time(review.reviewedAt)} ET; original
        publication dates remain above.
      </p>
    </section>
  );
}

export default function MorningBoard({
  initial,
  history,
  performance,
  experiments,
  communityEnabled = false,
}: {
  initial: Snapshot;
  history: HistoryEntry[];
  performance: PerformanceReport;
  experiments: Experiments;
  communityEnabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial),
    [instrument, setInstrument] = useState<Instrument>("MARKET"),
    [horizon, setHorizon] = useState<Horizon>("daily");
  const [family, setFamily] = useState<Family | null>(null),
    [tab, setTab] = useState<"morning" | "signals" | "history">("morning"),
    [theme, setTheme] = useState<"dark" | "light">("dark");
  const [now, setNow] = useState(initial.issuedAt),
    [historyError, setHistoryError] = useState(""),
    [loading, setLoading] = useState(false);
  const issueRequest = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [showAllEditions, setShowAllEditions] = useState(false);
  useEffect(() => {
    setNow(new Date().toISOString());
    setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    );
    const timer = setInterval(() => setNow(new Date().toISOString()), 60000);
    return () => clearInterval(timer);
  }, []);
  const historical = snapshot.id !== initial.id,
    reference = historical ? snapshot.cutoff : now;
  const consensus = asIssuedConsensus(snapshot, instrument, horizon),
    current = snapshot.signals.filter((signal) =>
      signal.instruments.includes(instrument),
    );
  const available = current.filter(
    (signal) => effectiveStatus(signal, reference) === "available",
  );
  const agedSincePublication = historical
    ? 0
    : current.filter(
        (signal) =>
          effectiveStatus(signal, snapshot.cutoff) === "available" &&
          effectiveStatus(signal, reference) !== "available",
      ).length;
  const leaders = [...consensus.families]
    .filter((item) => item.score !== null)
    .sort((a, b) => Math.abs(b.score!) - Math.abs(a.score!))
    .slice(0, 5);
  const timing = editionTiming(snapshot, history);
  const cohort = performanceView(
    performance,
    instrument,
    horizon,
    snapshot.engineVersion,
  );
  const pendingTargets = (performance.pending ?? []).filter(item =>
    item.snapshotId === snapshot.id && item.horizon === horizon &&
    (instrument === "MARKET" || item.instrument === instrument),
  );
  const learning = performance.learning.filter(
    (item) =>
      (instrument === "MARKET" || item.instrument === instrument) &&
      item.horizon === horizon &&
      item.engineVersion === snapshot.engineVersion,
  );
  const fx = snapshot.signals.filter(
    (signal) => signal.id.startsWith("fx-") && signal.series.length,
  );
  const institutions = current.filter(
    (signal) => signal.id.startsWith("cftc-") && signal.metrics.length,
  );
  const scheduled = snapshot.catalysts
    .filter(
      (item) =>
        item.kind !== "release" &&
        eventUpcoming(item.at, reference, 70, item.dateZone),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const reported = current.filter(
    (signal) => signal.id.startsWith("earnings-") && signal.metrics.length,
  );
  const supportive = consensus.families
    .filter((item) => item.score !== null && item.score > 0.1)
    .sort((a, b) => b.score! - a.score!)
    .slice(0, 3);
  const defensive = consensus.families
    .filter((item) => item.score !== null && item.score < -0.1)
    .sort((a, b) => a.score! - b.score!)
    .slice(0, 3);
  const describeFamilies = (items: typeof supportive) =>
    items.length
      ? items.map((item) => item.label.toLowerCase()).join(", ")
      : "No family currently clears the directional threshold";
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("tdc-theme", next);
    } catch {
      /* Theme still works for this visit. */
    }
  }
  async function chooseIssue(id: string) {
    const request = ++issueRequest.current;
    setHistoryError("");
    if (id === initial.id) {
      setSnapshot(initial);
      setLoading(false);
      return true;
    }
    const entry = history.find((item) => item.id === id);
    if (!entry) return false;
    setLoading(true);
    setHistoryError("");
    try {
      const response = await fetch(
        `/consensus/${encodeURIComponent(entry.id)}.json`,
      );
      if (!response.ok) throw new Error("This edition could not be loaded.");
      const next = (await response.json()) as Snapshot,
        bytes = new TextEncoder().encode(JSON.stringify(next));
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== entry.sha256 || next.id !== entry.id)
        throw new Error("Edition integrity check failed.");
      if (request !== issueRequest.current) return false;
      setSnapshot(next);
      return true;
    } catch (error) {
      if (request === issueRequest.current)
        setHistoryError(
          error instanceof Error ? error.message : "History unavailable.",
        );
      return false;
    } finally {
      if (request === issueRequest.current) setLoading(false);
    }
  }
  const votingFamilies = consensus.families.filter(
    (item) => item.score !== null,
  ).length;
  const familyNames: Record<Family, string> = {
    social: "Social",
    retail: "Retail",
    institutions: "Institutions",
    options: "Options",
    technicals: "Technicals",
    premarket: "Premarket",
    events: "Events",
    analysts: "Analysts",
    news: "News",
    earnings: "Earnings",
    liquidity: "Liquidity",
    rates: "Rates",
    fx: "Currencies",
    international: "Global",
    capital: "Capital",
  };
  const overview = (
    <section className={layout.hero} aria-label="Consensus overview">
      <div className={layout.verdict}>
        <span className={styles.eyebrow}>
          {names[instrument]} · {horizon} context
        </span>
        <h2>{consensus.label}</h2>
        <p>
          {consensus.abstain
            ? "The evidence is incomplete. A trading call is withheld until more independent signals are available."
            : "The balance of independent market signals. Explore the evidence before forming your plan."}
        </p>
        <div className={layout.coverage}>
          <strong>
            {pct(consensus.directionalCoverage ?? consensus.coverage)}
          </strong>
          <span>
            {consensus.directionalCoverage !== undefined
              ? "Directional coverage"
              : "Observation coverage"}
            <small>
              {consensus.directionalCoverage !== undefined
                ? `at publication · ${votingFamilies}/${FAMILIES.length} voting families`
                : "at publication · this edition has no directional gate"}
            </small>
          </span>
        </div>
        <div className={layout.coverageTrack} aria-hidden="true">
          <i
            style={{
              width: pct(consensus.directionalCoverage ?? consensus.coverage),
            }}
          />
        </div>
        <p className={layout.coverageNote}>
          {consensus.directionalCoverage !== undefined
            ? `${pct(consensus.coverage)} observation coverage.`
            : `${votingFamilies} of ${FAMILIES.length} families provided directional input.`}{" "}
          Completeness, not accuracy.
        </p>
        {agedSincePublication > 0 && (
          <p className={layout.coverageNote}>
            {agedSincePublication} {agedSincePublication === 1 ? "observation has" : "observations have"} aged out since publication;
            this saved reading is unchanged.
          </p>
        )}
      </div>
      <div className={layout.evidenceMap}>
        <div className={layout.mapHeading}>
          <span className={styles.eyebrow}>THE SIGNAL MAP</span>
          <span>At publication</span>
        </div>
        <div className={layout.familyMap}>
          {FAMILIES.map((definition) => {
            const reading = consensus.families.find(
              (item) => item.id === definition.id,
            )!;
            const state =
              reading.score !== null
                ? "voting"
                : reading.available > 0
                  ? "context"
                  : "missing";
            const label =
              state === "voting"
                ? "Directional input"
                : state === "context"
                  ? "Context only"
                  : "No current input";
            return (
              <button
                key={definition.id}
                className={layout.familyCell}
                data-state={state}
                onClick={() => setFamily(definition.id)}
                aria-label={`${definition.label}: ${label}. Inspect sources`}
              >
                <i aria-hidden="true" />
                <span>{familyNames[definition.id]}</span>
              </button>
            );
          })}
        </div>
        <div className={layout.mapLegend}>
          <span>
            <i data-state="voting" />
            Directional input
          </span>
          <span>
            <i data-state="context" />
            Context only
          </span>
          <span>
            <i data-state="missing" />
            No current input
          </span>
        </div>
        <button
          className={layout.inspectLink}
          onClick={() => {
            setTab("signals");
            document.getElementById("signals-tab")?.focus();
          }}
        >
          Explore all signals <ArrowRight size={15} />
        </button>
      </div>
      <details className={layout.consensusDetails}>
        <summary>
          {consensus.abstain
            ? "Why the call is withheld"
            : "How the signals combine"}
          <ChevronRight size={16} aria-hidden="true" />
        </summary>
        <div className={layout.consensusDetailsBody}>
          <div>
            <h3>
              {consensus.abstain ? "What is still missing" : "Methodology"}
            </h3>
            {consensus.abstain && (
              <ul>
                {consensus.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <p>
              Equal family weights. Correlated indicators share a vote. These
              are declared rules, not learned accuracy.
            </p>
          </div>
          <div className={layout.partialInputs}>
            <h3>
              {consensus.abstain
                ? "Partial inputs · not a call"
                : "What is pulling the balance"}
            </h3>
            {leaders.map((item) => (
              <button key={item.id} onClick={() => setFamily(item.id)}>
                <span>{item.label}</span>
                <Divergence value={item.score} muted={consensus.abstain} />
                <strong>
                  {item.score! > 0 ? "+" : ""}
                  {Math.round(item.score! * 100)}
                </strong>
              </button>
            ))}
            <p>
              {consensus.bullish} supportive · {consensus.bearish} defensive ·{" "}
              {consensus.neutral} balanced. {pct(consensus.agreement)} agreement
              among directional families; not a probability of profit.
            </p>
          </div>
          {!consensus.abstain && (
            <Gauge score={consensus.score} abstain={false} />
          )}
        </div>
      </details>
    </section>
  );
  return (
    <div className={styles.board}>
      <a href="#morning-main" className={styles.skip}>
        Skip to market overview
      </a>
      <PublicationHeader active="morning" theme={theme} onToggleTheme={toggleTheme} />
      <main id="morning-main" className={layout.main}>
        <div className={layout.intro}>
          <div>
            <span className={styles.eyebrow}>
              <Coffee size={14} /> YOUR MORNING, IN FOCUS
            </span>
            <h1 ref={headingRef} tabIndex={-1}>
              The morning briefing<span>.</span>
            </h1>
            <p>The signals. The context. A clearer start.</p>
          </div>
          <div className={layout.edition} data-historical={historical}>
            <span className={layout.editionLabel}>
              {historical ? "AS-ISSUED EDITION" : "LATEST SAVED EDITION"}
            </span>
            <strong>
              {date(snapshot.issuedAt)}{" "}
              <span>· {time(snapshot.issuedAt)} ET</span>
            </strong>
            <details>
              <summary>
                Edition details <ChevronRight size={13} aria-hidden="true" />
              </summary>
              <div>
                <span>
                  {timing.methodologyReissue ? "Methodology reissue · " : ""}
                  {timing.ruleLabel}
                </span>
                {timing.latestSourceCheck && (
                  <span>
                    Latest source check {date(timing.latestSourceCheck)} ·{" "}
                    {time(timing.latestSourceCheck)} ET
                  </span>
                )}
                <span>
                  {available.length} current inputs · {snapshot.signals.length}{" "}
                  tracked
                </span>
              </div>
            </details>
          </div>
        </div>
        {historical && <div className={layout.historyBanner} role="status">
          <div><strong>Viewing an as-issued edition</strong><span>{datedYear(snapshot.issuedAt)} · {time(snapshot.issuedAt)} ET. Observations and verdicts are preserved as published.</span></div>
          <button onClick={async () => {
            if (await chooseIssue(initial.id)) headingRef.current?.focus({ preventScroll: true });
          }}>Return to latest <ArrowRight size={15} aria-hidden="true" /></button>
        </div>}
        <div className={layout.toolbar}>
          <div
            className={layout.instruments}
            role="group"
            aria-label="Instrument"
          >
            {INSTRUMENTS.map((symbol) => (
              <button
                key={symbol}
                aria-pressed={instrument === symbol}
                onClick={() => setInstrument(symbol)}
              >
                {symbol === "MARKET" ? <Globe2 size={14} /> : null}
                {symbol === "MARKET" ? "All markets" : symbol}
              </button>
            ))}
          </div>
          <div
            className={layout.horizons}
            role="group"
            aria-label="Context window"
          >
            {HORIZONS.map((value) => (
              <button
                key={value}
                aria-pressed={horizon === value}
                onClick={() => setHorizon(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <div
          className={layout.tabs}
          role="tablist"
          aria-label="Morning sections"
        >
          {(
            [
              { id: "morning", name: "The big picture", icon: Coffee },
              { id: "signals", name: "Every signal", icon: Layers3 },
              { id: "history", name: "History & learning", icon: History },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${item.id}-panel`}
              id={`${item.id}-tab`}
              tabIndex={tab === item.id ? 0 : -1}
              onKeyDown={(event) => {
                const order = ["morning", "signals", "history"] as const;
                const currentIndex = order.indexOf(tab);
                const nextIndex =
                  event.key === "ArrowRight"
                    ? (currentIndex + 1) % 3
                    : event.key === "ArrowLeft"
                      ? (currentIndex + 2) % 3
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : null;
                if (nextIndex !== null) {
                  event.preventDefault();
                  setTab(order[nextIndex]);
                  document.getElementById(`${order[nextIndex]}-tab`)?.focus();
                }
              }}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={15} />
              {item.name}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="morning-panel"
          aria-labelledby="morning-tab"
          hidden={tab !== "morning"}
          tabIndex={0}
        >
          {tab === "morning" && (
            <>
              {overview}
              <section
                className={styles.catalystStrip}
                aria-label="Upcoming economic catalysts"
              >
                <div>
                  <span className={styles.eyebrow}>ON THE RADAR</span>
                  <strong>Next catalysts</strong>
                </div>
                {scheduled.slice(0, 3).map((item) => (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span>{eventLabel(item)}</span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.source} · {item.kind} <ArrowUpRight size={12} />
                    </small>
                  </a>
                ))}
                {!scheduled.length && (
                  <p className={styles.muted}>
                    No upcoming events returned by the connected calendar.
                  </p>
                )}
              </section>
              {scheduled.length > 0 && (
                <details className={styles.calendarExpand}>
                  <summary>
                    Full calendar · {scheduled.length} upcoming events
                  </summary>
                  <p className={styles.muted}>
                    Exact times are shown in Eastern. International date-only
                    events keep their labelled local date. Schedules can change;
                    check the linked source.
                  </p>
                  <div className={styles.calendarGrid}>
                    {scheduled.map((item) => (
                      <a
                        key={item.id}
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.calendarEvent}
                      >
                        <span className={styles.eyebrow}>
                          {eventLabel(item)}
                        </span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.source} · {item.kind}
                          <ArrowUpRight size={13} />
                        </small>
                      </a>
                    ))}
                  </div>
                </details>
              )}
              <ReviewedDevelopments
                snapshot={snapshot}
                instrument={instrument}
                reference={reference}
              />
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.eyebrow}>
                    THE FORCES BEHIND THE MARKET
                  </span>
                  <h2>Start with the big picture.</h2>
                </div>
                <span>{names[instrument]} · source dates vary</span>
              </div>
              <div className={styles.dashboardGrid}>
                <section className={styles.panel}>
                  <div className={styles.panelHead}>
                    <h3>The price of money</h3>
                    <button
                      onClick={() => setFamily("rates")}
                      aria-label="Inspect rates sources"
                    >
                      <ArrowUpRight size={18} />
                    </button>
                  </div>
                  <p className={styles.panelSubtitle}>US Treasury curve</p>
                  <Curve signals={snapshot.signals} />
                </section>
                <section className={styles.panel}>
                  <div className={styles.panelHead}>
                    <h3>Liquidity underneath</h3>
                    <button
                      onClick={() => setFamily("liquidity")}
                      aria-label="Inspect liquidity sources"
                    >
                      <ArrowUpRight size={18} />
                    </button>
                  </div>
                  <p className={styles.panelSubtitle}>
                    A same-date view of the Fed, Treasury and repo
                  </p>
                  <Liquidity signals={snapshot.signals} />
                </section>
                <section className={`${styles.panel} ${styles.fxPanel}`}>
                  <div className={styles.panelHead}>
                    <h3>The world against the dollar</h3>
                    <button
                      onClick={() => setFamily("fx")}
                      aria-label="Inspect currency sources"
                    >
                      <ArrowUpRight size={18} />
                    </button>
                  </div>
                  <p className={styles.panelSubtitle}>
                    Daily change · ECB reference fixes, not live quotes
                  </p>
                  <div className={styles.fxGrid}>
                    {fx.map((signal) => {
                      const change =
                        signal.metrics.find(
                          (metric) => metric.label === "Daily change",
                        )?.value ?? null;
                      return (
                        <button
                          key={signal.id}
                          onClick={() => setFamily("fx")}
                          className={
                            change !== null && change >= 0
                              ? styles.fxUp
                              : styles.fxDown
                          }
                        >
                          <span>
                            {signal.id.slice(3)}
                            <small>/ USD</small>
                          </span>
                          <strong>
                            {change === null
                              ? "—"
                              : `${change >= 0 ? "+" : ""}${number(change)}%`}
                          </strong>
                          <Sparkline
                            series={signal.series}
                            color={
                              change !== null && change >= 0
                                ? "var(--positive)"
                                : "var(--negative)"
                            }
                            label={signal.title}
                          />
                          <small>
                            {signal.source.observedAt
                              ? date(signal.source.observedAt)
                              : "Unavailable"}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
              <TaiwanMarket signals={current} reference={reference} onInspect={() => setFamily("international")} />
              <OffExchangeActivity review={snapshot.review} instrument={instrument} historical={historical} />
              <EtfFlows signals={snapshot.signals} instrument={instrument} reference={reference} />
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.eyebrow}>GO A LEVEL DEEPER</span>
                  <h2>Follow the forces.</h2>
                </div>
                <span>Open the research that matters to you</span>
              </div>
              <ResearchSection
                number="01"
                title="Policy, positioning & capital"
                description="Central banks · institutional filings · liquidity flows"
              >
                <PolicyRates
                  signals={snapshot.signals}
                  reference={reference}
                  onInspect={setFamily}
                />
                <div className={styles.twoColumns}>
                  <section className={styles.panel}>
                    <div className={styles.panelHead}>
                      <h3>Where institutions stand</h3>
                      <button
                        onClick={() => setFamily("institutions")}
                        aria-label="Inspect institutional positioning"
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </div>
                    <p className={styles.panelSubtitle}>
                      Net futures positions as a share of open interest
                    </p>
                    <div className={styles.positioning}>
                      {institutions
                        .slice(0, instrument === "MARKET" ? 8 : 4)
                        .map((signal) => (
                          <button
                            key={signal.id}
                            onClick={() => setFamily("institutions")}
                          >
                            <span>
                              {signal.title}
                              <small>
                                Measured {date(signal.source.observedAt!)}
                              </small>
                            </span>
                            <Divergence
                              value={Math.max(
                                -1,
                                Math.min(1, signal.metrics[0].value / 60),
                              )}
                            />
                            <strong
                              className={
                                signal.metrics[0].value >= 0
                                  ? styles.up
                                  : styles.down
                              }
                            >
                              {signal.metrics[0].value >= 0 ? "+" : ""}
                              {number(signal.metrics[0].value, 1)}%
                            </strong>
                          </button>
                        ))}
                    </div>
                    <p className={styles.finePrint}>
                      CFTC weekly, futures only. These are category positions,
                      not ETF flows or named-investor intent.
                    </p>
                  </section>
                  <section className={styles.panel}>
                    <div className={styles.panelHead}>
                      <h3>Across the policy desks</h3>
                      <button
                        onClick={() => setFamily("international")}
                        aria-label="Inspect international sources"
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </div>
                    <p className={styles.panelSubtitle}>
                      Latest official releases · publication time in New York
                    </p>
                    <div className={styles.timeline}>
                      {snapshot.catalysts
                        .filter((item) => item.kind === "release")
                        .slice(0, 6)
                        .map((item) => (
                          <a
                            key={item.id}
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <div className={styles.timelineDate}>
                              {date(item.at)}
                              <small>{time(item.at)}</small>
                            </div>
                            <div>
                              <span>{item.source}</span>
                              <h4>{item.title}</h4>
                            </div>
                            <ArrowUpRight size={14} />
                          </a>
                        ))}
                    </div>
                  </section>
                </div>
                <FuturesOptions signals={current} reference={reference} onInspect={() => setFamily("institutions")} />
                {instrument !== "TLT" && snapshot.holdings && (
                  <InstitutionalHoldings
                    holdings={snapshot.holdings}
                    signals={snapshot.signals}
                    reference={reference}
                    onInspect={() => setFamily("institutions")}
                  />
                )}
                <CapitalPanels
                  signals={snapshot.signals}
                  now={reference}
                  onInspect={() => setFamily("capital")}
                />
              </ResearchSection>
              <ResearchSection
                number="02"
                title="News & company earnings"
                description="The news sample · reported results · management outlook"
              >
                {snapshot.news && (
                  <NewsPanel
                    pulse={snapshot.news}
                    onInspect={() => setFamily("news")}
                    collectionNote={
                      snapshot.signals.find(
                        (s) => s.id === "gdelt-finance-news",
                      )?.collectionNote
                    }
                  />
                )}
                {!!reported.length && (
                  <section
                    className={styles.earningsStrip}
                    aria-label="Reported company revenues"
                  >
                    <div>
                      <span className={styles.eyebrow}>
                        COMPANY REPORTED RESULTS
                      </span>
                      <h3>Inside the earnings cycle</h3>
                      <p>
                        Selected company revenue. This is not an index-wide
                        earnings surprise measure.
                      </p>
                    </div>
                    <div className={styles.earningsCompanies}>
                      {reported.map((signal) => {
                        const growth = signal.metrics.find(
                          (metric) =>
                            metric.label === "Year-over-year revenue change",
                        );
                        return (
                          <button
                            key={signal.id}
                            onClick={() => setFamily("earnings")}
                          >
                            <span>
                              {signal.id.replace("earnings-", "")}
                              <small>
                                Quarter ended {date(signal.source.observedAt!)}
                              </small>
                            </span>
                            <strong>
                              ${number(signal.metrics[0].value, 2)}bn
                            </strong>
                            <span
                              className={
                                growth && growth.value >= 0
                                  ? styles.up
                                  : styles.down
                              }
                            >
                              {growth
                                ? `${growth.value < 0 ? "−" : "+"}${number(Math.abs(growth.value), 1)}% YoY`
                                : "No comparable period"}
                            </span>
                            <Sparkline
                              series={signal.series}
                              label={signal.title}
                            />
                            <ReportedEpsComparison
                              frequency={signal.source.frequency}
                              metrics={signal.metrics}
                              className={styles.comparisonNote}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
                <GuidancePanel snapshot={snapshot} instrument={instrument} reference={reference} />
              </ResearchSection>
              <ResearchSection
                number="03"
                title="Price chart & technicals"
                description="Current TradingView display · separate from saved consensus"
              >
                <MorningMarket
                  instrument={instrument}
                  horizon={horizon}
                  theme={theme}
                  historical={historical}
                />
              </ResearchSection>
              <ResearchSection number="04" title="Community & retail" description="FX-community positioning · current hosted context">
                <RetailOutlook historical={historical} />
                {communityEnabled && <CommunityPanel instrument={instrument} historical={historical} />}
              </ResearchSection>
              <section className={styles.scenario}>
                <div>
                  <span className={styles.eyebrow}>
                    {consensus.abstain
                      ? "CONDITIONS TO WATCH · CALL WITHHELD"
                      : "BUILD YOUR PLAN"}
                  </span>
                  <h2>
                    {horizon === "daily"
                      ? "What would change the picture?"
                      : `${horizon === "weekly" ? "The week" : "The month"} ahead: conditions, not certainty.`}
                  </h2>
                </div>
                <div>
                  <p>
                    <ArrowUpRight
                      className={consensus.abstain ? styles.muted : styles.up}
                      size={20}
                    />
                    <span>
                      <strong>Constructive conditions</strong>
                      {describeFamilies(supportive)}
                      {supportive.length
                        ? " leaned supportive under the rules at publication."
                        : "."}{" "}
                      Inspect their observation dates and assumptions before
                      using them in a plan.
                    </span>
                  </p>
                  <p>
                    <ArrowDownRight
                      className={consensus.abstain ? styles.muted : styles.down}
                      size={20}
                    />
                    <span>
                      <strong>Defensive conditions</strong>
                      {describeFamilies(defensive)}
                      {defensive.length
                        ? " leaned defensive under the rules at publication."
                        : "."}{" "}
                      Disagreement is part of the setup, not an input to
                      discard.
                    </span>
                  </p>
                  <p className={styles.finePrint}>
                    {consensus.abstain &&
                      "These partial inputs do not qualify as a trade setup. "}
                    Daily, weekly and monthly views use distinct change windows.
                    Numeric return projections remain unavailable until a model
                    passes historical and prospective evaluation.
                  </p>
                </div>
              </section>
            </>
          )}
        </div>
        <section
          role="tabpanel"
          id="signals-panel"
          aria-labelledby="signals-tab"
          hidden={tab !== "signals"}
          tabIndex={0}
        >
          {tab === "signals" && (
            <>
              {overview}
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.eyebrow}>NO HIDDEN VOTES</span>
                  <h2>Every piece of the picture.</h2>
                </div>
                <span>Click a family to inspect its inputs</span>
              </div>
              <div className={styles.signalGrid}>
                {FAMILIES.map((definition) => {
                  const reading = consensus.families.find(
                      (item) => item.id === definition.id,
                    )!,
                    members = current.filter(
                      (signal) => signal.family === definition.id,
                    ),
                    example =
                      members.find(
                        (signal) =>
                          effectiveStatus(signal, reference) === "available" &&
                          signal.series.length > 1,
                      ) ??
                      members.find(
                        (signal) =>
                          effectiveStatus(signal, reference) === "available",
                      ),
                    availableCount = reading.available;
                  return (
                    <article
                      key={definition.id}
                      className={`${styles.signalCard} ${availableCount ? "" : styles.missingCard}`}
                    >
                      <h3>
                        <button
                          className={styles.cardAction}
                          onClick={() => setFamily(definition.id)}
                          aria-label={`Inspect ${definition.label} inputs`}
                        >
                          <span>{definition.label}</span>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      </h3>
                      <p className={styles.cardStatus}>
                        {reading.score === null
                          ? availableCount
                            ? "Context available"
                            : reading.status === "stale"
                              ? "Needs a refresh"
                              : "Not connected"
                          : reading.score > 0.1
                            ? "Supportive"
                            : reading.score < -0.1
                              ? "Defensive"
                              : "Balanced"}
                      </p>
                      {example?.series.length ? (
                        <Sparkline
                          series={example.series}
                          label={example.title}
                          color={
                            reading.score !== null && reading.score < 0
                              ? "var(--negative)"
                              : "var(--accent)"
                          }
                        />
                      ) : (
                        <div className={styles.signalEmpty}>
                          {availableCount ? (
                            <Globe2 size={25} />
                          ) : (
                            <Layers3 size={25} />
                          )}
                          <span>{definition.detail}</span>
                        </div>
                      )}
                      <p>
                        {example
                          ? example.title
                          : (members[0]?.summary ?? definition.detail)}
                      </p>
                      <div className={styles.cardFoot}>
                        <span>
                          {availableCount}/{reading.expected} inputs current
                        </span>
                        <span>
                          {example?.source.observedAt
                            ? date(example.source.observedAt)
                            : "No directional vote"}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </section>
        <section
          role="tabpanel"
          id="history-panel"
          aria-labelledby="history-tab"
          hidden={tab !== "history"}
          tabIndex={0}
        >
          {tab === "history" && (
            <>
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.eyebrow}>
                    ACCOUNTABILITY COMES WITH THE CALL
                  </span>
                  <h2>Remember. Measure. Improve.</h2>
                </div>
                <label className={styles.issueSelect}>
                  Saved edition
                  <select
                    value={snapshot.id}
                    disabled={loading}
                    onChange={(event) => void chooseIssue(event.target.value)}
                  >
                    {[...history].reverse().map((entry) => (
                      <option value={entry.id} key={entry.id}>
                        {date(entry.issuedAt)} · {time(entry.issuedAt)} ET
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {historyError && <p role="alert">{historyError}</p>}
              {pendingTargets.length > 0 && <p className={styles.pendingTargets}>
                {pendingTargets.length} {horizon} {pendingTargets.length === 1 ? "target awaits" : "targets await"} verified prices or reviewed calendar coverage for this edition.
                These are unresolved edition targets, not independent training samples.
              </p>}
              <div className={styles.historyStats}>
                <div>
                  <span>As-issued editions</span>
                  <strong>{history.length}</strong>
                  <small>Immutable, source-linked snapshots</small>
                </div>
                <div>
                  <span>
                    {instrument === "MARKET"
                      ? "Instrument outcomes"
                      : "Scored outcomes"}
                  </span>
                  <strong>{cohort.resolved ?? "—"}</strong>
                  <small>
                    {performance.status === "awaiting_price_evidence"
                      ? "Requires verified future session prices"
                      : `${horizon} outcomes · ${instrument === "MARKET" ? "across five instruments" : "verified session prices"}`}
                  </small>
                </div>
                <div>
                  <span>Directional accuracy</span>
                  <strong>{pct(cohort.accuracy)}</strong>
                  <small>
                    {cohort.calls ?? "—"} {horizon} calls · {timing.ruleLabel}
                  </small>
                </div>
                <div>
                  <span>Trained model</span>
                  <strong>
                    {learning.some(
                      (item) =>
                        item.activeModelId ||
                        (item.activeModelId === undefined && item.promoted),
                    )
                      ? "Active"
                      : "Pending"}
                  </strong>
                  <small>
                    {Math.max(0, ...learning.map((item) => item.samples))}{" "}
                    resolved observations per target
                  </small>
                </div>
              </div>
              <p className={styles.finePrint}>
                {instrument === "MARKET" &&
                  "MARKET is context only; it has no scored trade. Figures above summarize this horizon across the five instrument editions. "}
                Figures and training are specific to {timing.ruleLabel}. Scoring
                uses the last edition before each session opens, including when
                the rule version changes. Earlier editions remain in the audit
                record. Model qualification requires at least 100 new,
                non-overlapping test outcomes and an uncertainty check against
                the baselines.
              </p>
              <p className={styles.finePrint}>
                This conservative gate takes time: roughly 500 daily, 2,500
                weekly or 10,500 monthly session labels before a first candidate
                can be tested (about 2, 10 or 42 trading years). Extra editions
                do not shorten that wait. Missing data can extend it. Promotion
                may never occur; unqualified projections stay withheld.
              </p>
              <div className={styles.twoColumns}>
                <section className={styles.panel}>
                  <h3>The record, exactly as it was</h3>
                  <p className={styles.muted}>
                    Each publication preserves its cutoff, observations and
                    calculation version. Later revisions cannot quietly rewrite
                    an old call.
                  </p>
                  <div className={styles.editionList}>
                    {[...history]
                      .reverse()
                      .slice(0, showAllEditions ? history.length : 5)
                      .map((entry) => (
                        <button
                          key={entry.id}
                          aria-current={entry.id === snapshot.id ? "true" : undefined}
                          onClick={async () => {
                            if (await chooseIssue(entry.id)) setTab("morning");
                          }}
                        >
                          <History size={17} />
                          <span>
                            {date(entry.issuedAt)} · {time(entry.issuedAt)} ET
                            <small>{entry.engineVersion}{entry.id === initial.id ? " · Latest" : ""}{entry.id === snapshot.id ? " · Viewing" : ""}</small>
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      ))}
                  </div>
                  {history.length > 5 && <button className={styles.historyToggle} aria-expanded={showAllEditions} onClick={() => setShowAllEditions(value => !value)}>{showAllEditions ? "Show latest 5 editions" : `Show all ${history.length} editions`}</button>}
                </section>
                <section className={styles.panel}>
                  <h3>How improvement earns its place</h3>
                  <ol className={styles.learningSteps}>
                    <li>
                      <strong>Freeze the forecast</strong>
                      <span>
                        Inputs are preserved before the target session opens.
                      </span>
                    </li>
                    <li>
                      <strong>Wait for the outcome</strong>
                      <span>
                        Compare the next 1, 5 and 21 complete sessions, adjusted
                        for splits and distributions.
                      </span>
                    </li>
                    <li>
                      <strong>Train on the past</strong>
                      <span>
                        Chronological splits exclude labels that overlap
                        validation or test dates.
                      </span>
                    </li>
                    <li>
                      <strong>Challenge the baseline</strong>
                      <span>
                        Evaluate calibration and Brier score against a base-rate
                        model and the current model.
                      </span>
                    </li>
                    <li>
                      <strong>Promote only with evidence</strong>
                      <span>
                        Versioned candidates must improve held-out results. No
                        learning or accuracy is claimed before that.
                      </span>
                    </li>
                  </ol>
                </section>
              </div>
              <section className={`${styles.panel} ${styles.experiments}`}>
                <div className={styles.panelHead}>
                  <div>
                    <span className={styles.eyebrow}>
                      REAL DATA · HISTORICAL RECONSTRUCTION
                    </span>
                    <h3>The first models had to prove themselves.</h3>
                  </div>
                  <span className={styles.status}>
                    {
                      experiments.experiments.filter(
                        (item) => item.baselineBeaten,
                      ).length
                    }{" "}
                    / {experiments.experiments.length} cleared the gate
                  </span>
                </div>
                <p className={styles.muted}>
                  Nine currency models were trained on ECB reference-rate
                  history using momentum, RSI, volatility and moving-average
                  distance. None cleared the required improvement over the
                  baselines. These experiments are separate from the prospective
                  daily-consensus record.
                </p>
                <div className={styles.tableScroll}>
                  <table role="table">
                    <caption>
                      Chronological holdout results. Brier score measures
                      probability error; lower is better.
                    </caption>
                    <thead role="rowgroup">
                      <tr role="row">
                        <th scope="col" role="columnheader">Currency</th>
                        <th scope="col" role="columnheader">Horizon</th>
                        <th scope="col" role="columnheader">Test samples</th>
                        <th scope="col" role="columnheader">Model error</th>
                        <th scope="col" role="columnheader">Base-rate error</th>
                        <th scope="col" role="columnheader">Decision</th>
                      </tr>
                    </thead>
                    <tbody role="rowgroup">
                      {experiments.experiments.map((item) => (
                        <tr key={item.id} role="row">
                          <th scope="row" role="rowheader">{item.instrument}</th>
                          <td role="cell" data-label="Horizon">{item.horizon}</td>
                          <td role="cell" data-label="Test samples">{item.testSamples ?? "—"}</td>
                          <td role="cell" data-label="Model error">{item.candidateBrier?.toFixed(4) ?? "—"}</td>
                          <td role="cell" data-label="Base-rate error">{item.baseRateBrier?.toFixed(4) ?? "—"}</td>
                          <td role="cell" data-label="Decision">
                            {item.baselineBeaten
                              ? "Shadow evaluation required"
                              : "Not promoted"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className={styles.finePrint}>{experiments.note}</p>
                <a
                  className={layout.inspectLink}
                  href={experiments.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source: European Central Bank <ExternalLink size={13} />
                </a>
              </section>
            </>
          )}
        </section>
      </main>
      <PublicationFooter />
      <SourceDrawer
        family={family}
        snapshot={snapshot}
        instrument={instrument}
        now={reference}
        onClose={() => setFamily(null)}
      />
    </div>
  );
}
