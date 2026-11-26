"use client";

import { useId, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { Bar, Envelope, Quote } from "@/lib/contracts";
import {
  compactNumber,
  dateLabel,
  EmptyState,
  number,
  SourceNote,
  StatusBadge,
  timestamp,
} from "./ui";

export const PERIODS = ["1M", "3M", "6M", "1Y"] as const;
export type Period = (typeof PERIODS)[number];

export default function MarketChart({
  symbol,
  history,
  quote,
  period,
  onPeriod,
  loading,
}: {
  symbol: string;
  history?: Envelope<Bar[]>;
  quote?: Quote;
  period: Period;
  onPeriod: (period: Period) => void;
  loading: boolean;
}) {
  const chartId = useId().replace(/:/g, "");
  const bars = useMemo(
    () =>
      (history?.data ?? []).filter(
        (bar) =>
          Number.isFinite(bar.close) && Number.isFinite(Date.parse(bar.time)),
      ),
    [history],
  );
  const [inspected, setInspected] = useState<number | null>(null);
  const index =
    inspected === null ? bars.length - 1 : Math.min(inspected, bars.length - 1);
  const selected = bars[index];
  const latest = bars.at(-1);
  const initial = bars[0];
  const change =
    latest && initial && initial.close !== 0
      ? (latest.close / initial.close - 1) * 100
      : null;
  const positive = change !== null && change >= 0;
  const prices = bars.map((bar) => bar.close);
  const min = prices.length ? Math.min(...prices) : 0;
  const max = prices.length ? Math.max(...prices) : 1;
  const spread = Math.max(max - min, max * 0.005, 0.01);
  const low = min - spread * 0.12;
  const high = max + spread * 0.12;
  const width = 800,
    height = 280,
    plotRight = 735,
    plotBottom = 205,
    plotTop = 16;
  const x = (i: number) =>
    8 + (i / Math.max(bars.length - 1, 1)) * (plotRight - 8);
  const y = (price: number) =>
    plotBottom - ((price - low) / (high - low)) * (plotBottom - plotTop);
  const line = bars
    .map(
      (bar, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(bar.close).toFixed(2)}`,
    )
    .join(" ");
  const area = bars.length
    ? `${line} L${x(bars.length - 1)},${plotBottom} L8,${plotBottom} Z`
    : "";
  const maxVolume = Math.max(
    1,
    ...bars.map((bar) => Math.max(0, bar.volume || 0)),
  );

  return (
    <section
      className="panel chart-panel"
      aria-label={`${symbol} price history`}
    >
      <div className="chart-heading">
        <div>
          <div className="instrument-heading">
            <span className="ticker-mark">{symbol.slice(0, 2)}</span>
            <div>
              <h2>{symbol}</h2>
              <p>{quote?.name ?? "Price & volume"}</p>
            </div>
          </div>
        </div>
        <div
          className="segmented-control period-control"
          aria-label="Chart time period"
        >
          {PERIODS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => {
                setInspected(null);
                onPeriod(value);
              }}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-price-row">
        <div>
          <span className="large-number">
            {quote
              ? `$${number(quote.close)}`
              : latest
                ? `$${number(latest.close)}`
                : "—"}
          </span>
          <span
            className={`price-change ${change === null ? "" : positive ? "positive" : "negative"}`}
          >
            {change !== null &&
              (positive ? (
                <ArrowUpRight size={16} />
              ) : (
                <ArrowDownRight size={16} />
              ))}
            {change === null
              ? "No period change available"
              : `${positive ? "+" : ""}${number(change)}% in displayed history`}
          </span>
        </div>
        <StatusBadge status={history?.status} />
      </div>
      {(quote || latest) && (
        <p className="quote-timestamp">
          Latest completed session · {timestamp(quote?.asOf ?? latest?.time)}
        </p>
      )}
      {bars.length > 0 ? (
        <>
          <div className="chart-inspection">
            <span>{selected ? dateLabel(selected.time) : "—"}</span>
            <span>
              Close <strong>${number(selected?.close)}</strong>
            </span>
            <span>
              Volume <strong>{compactNumber(selected?.volume)}</strong>
            </span>
          </div>
          <svg
            className="price-chart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-labelledby={`${chartId}-title ${chartId}-desc`}
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const scaledX =
                ((event.clientX - bounds.left) / bounds.width) * width;
              setInspected(
                Math.max(
                  0,
                  Math.min(
                    bars.length - 1,
                    Math.round(
                      ((scaledX - 8) / (plotRight - 8)) * (bars.length - 1),
                    ),
                  ),
                ),
              );
            }}
            onPointerLeave={() => setInspected(null)}
          >
            <title id={`${chartId}-title`}>
              {symbol} closing price and daily volume
            </title>
            <desc id={`${chartId}-desc`}>
              {bars.length} sessions from {dateLabel(initial?.time)} to{" "}
              {dateLabel(latest?.time)}. Closing prices range from {number(min)}{" "}
              to {number(max)} dollars. Use the session slider below to inspect
              individual values.
            </desc>
            <defs>
              <linearGradient
                id={`${chartId}-fill`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="var(--accent)" stopOpacity=".19" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 1, 2, 3].map((tick) => {
              const price = high - ((high - low) * tick) / 3;
              return (
                <g key={tick}>
                  <line
                    x1="8"
                    y1={y(price)}
                    x2={plotRight}
                    y2={y(price)}
                    className="chart-grid"
                  />
                  <text x="750" y={y(price) + 4} className="chart-axis">
                    {number(price)}
                  </text>
                </g>
              );
            })}
            <path d={area} fill={`url(#${chartId}-fill)`} />
            <path
              d={line}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.4"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {bars.map((bar, i) => (
              <rect
                key={`${bar.time}-${i}`}
                x={x(i) - 1}
                y={252 - (Math.max(0, bar.volume || 0) / maxVolume) * 29}
                width={Math.max(1.1, ((plotRight - 8) / bars.length) * 0.58)}
                height={(Math.max(0, bar.volume || 0) / maxVolume) * 29}
                rx=".4"
                fill={
                  bar.close >= bar.open
                    ? "var(--chart-volume)"
                    : "var(--chart-volume-negative)"
                }
              />
            ))}
            {selected && (
              <g>
                <line
                  x1={x(index)}
                  y1={plotTop}
                  x2={x(index)}
                  y2="254"
                  stroke="var(--text-muted)"
                  strokeDasharray="3 4"
                  opacity=".5"
                />
                <circle
                  cx={x(index)}
                  cy={y(selected.close)}
                  r="4"
                  fill="var(--accent)"
                  stroke="var(--panel)"
                  strokeWidth="2"
                />
              </g>
            )}
            <text x="8" y="276" className="chart-axis">
              {dateLabel(initial?.time, true)}
            </text>
            <text
              x={plotRight / 2}
              y="276"
              textAnchor="middle"
              className="chart-axis"
            >
              {dateLabel(bars[Math.floor(bars.length / 2)]?.time, true)}
            </text>
            <text x={plotRight} y="276" textAnchor="end" className="chart-axis">
              {dateLabel(latest?.time, true)}
            </text>
          </svg>
          <label className="chart-scrubber-label">
            <span>Explore sessions</span>
            <input
              type="range"
              min="0"
              max={Math.max(0, bars.length - 1)}
              value={Math.max(0, index)}
              aria-label="Inspect trading session"
              aria-valuetext={
                selected
                  ? `${dateLabel(selected.time)}. Close ${number(selected.close)} dollars. Volume ${compactNumber(selected.volume)}.`
                  : undefined
              }
              onChange={(event) => setInspected(Number(event.target.value))}
            />
          </label>
        </>
      ) : (
        <EmptyState
          title={
            loading ? "Loading market history" : "Price history is unavailable"
          }
          loading={loading}
        >
          {history?.message ??
            "Verified closing prices and volume will appear here when the market source responds."}
        </EmptyState>
      )}
      <SourceNote envelope={history} />
    </section>
  );
}
