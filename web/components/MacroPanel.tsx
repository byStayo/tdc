"use client";

import { ChevronRight, Globe2 } from "lucide-react";
import type { Envelope, MacroSeries } from "@/lib/contracts";
import { dateLabel, ExternalLink, number, StatusBadge, timestamp } from "./ui";

function observationPeriod(date: string, frequency: MacroSeries["frequency"]) {
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime())) return "Period unavailable";
  if (frequency === "quarterly") {
    return `Q${Math.floor(parsed.getUTCMonth() / 3) + 1} ${parsed.getUTCFullYear()}`;
  }
  if (frequency === "monthly") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(parsed);
  }
  return dateLabel(date);
}

function presentation(series: MacroSeries) {
  // FRED publishes TNWBSHNO in millions of USD. One trillion is a million millions.
  if (series.id === "TNWBSHNO") {
    return {
      divisor: 1_000_000,
      unit: "USD trillions",
      suffix: "",
      prefix: "$",
    };
  }
  if (/percent|%/i.test(series.unit)) {
    return { divisor: 1, unit: "Percent", suffix: "%", prefix: "" };
  }
  return { divisor: 1, unit: series.unit, suffix: "", prefix: "" };
}

function MacroSeriesCard({ series }: { series: MacroSeries }) {
  const observations = series.observations
    .filter(
      (observation) =>
        Number.isFinite(observation.value) &&
        Number.isFinite(Date.parse(observation.date)),
    )
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = observations[0];
  const format = presentation(series);
  const valueLabel = (value: number) =>
    `${format.prefix}${number(value / format.divisor)}${format.suffix}`;
  return (
    <article className="macro-series">
      <h3>{series.name}</h3>
      <div className="macro-value-row">
        <strong>{latest ? valueLabel(latest.value) : "—"}</strong>
        <span>{format.unit}</span>
      </div>
      <p className="macro-observation">
        {latest
          ? `Observation · ${observationPeriod(latest.date, series.frequency)}`
          : "No published observation available"}
      </p>
      <p className="macro-frequency">{series.frequency} series</p>
      {latest && (
        <details className="macro-history">
          <summary>
            Recent observations
            <ChevronRight size={13} aria-hidden="true" />
          </summary>
          <table>
            <caption className="sr-only">
              {series.name}, recent observations in {format.unit}
            </caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col" className="numeric">
                  {format.unit}
                </th>
              </tr>
            </thead>
            <tbody>
              {observations.slice(0, 6).map((observation) => (
                <tr key={observation.date}>
                  <th scope="row">
                    {observationPeriod(observation.date, series.frequency)}
                  </th>
                  <td className="numeric">{valueLabel(observation.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {series.id === "TNWBSHNO" && (
            <p className="macro-conversion-note">
              Converted from FRED’s millions of US dollars to trillions.
            </p>
          )}
        </details>
      )}
      <ExternalLink href={series.url} className="macro-source-link">
        View FRED series
      </ExternalLink>
    </article>
  );
}

export default function MacroPanel({
  macro,
  loading,
}: {
  macro?: Envelope<MacroSeries[]>;
  loading: boolean;
}) {
  return (
    <section className="macro-panel" aria-label="FRED macroeconomic context">
      <div className="rail-heading">
        <h2>Macro context</h2>
        <Globe2 size={15} className="muted" aria-hidden="true" />
      </div>
      <p className="rail-description">
        Published economic observations. Each series has its own reporting
        period.
      </p>
      <div className="macro-coverage">
        <StatusBadge status={macro?.status} />
      </div>
      {macro?.data.length ? (
        <div className="macro-series-list">
          {macro.data.map((series) => (
            <MacroSeriesCard key={series.id} series={series} />
          ))}
        </div>
      ) : (
        <p className="rail-empty" role={loading ? "status" : undefined}>
          {loading
            ? "Loading economic observations…"
            : (macro?.message ??
              "Macro observations are unavailable. No economic values are estimated.")}
        </p>
      )}
      {macro?.data.length && macro.message ? (
        <p className="macro-message">{macro.message}</p>
      ) : null}
      <p className="macro-retrieval">
        {macro
          ? `${macro.source} · Retrieved ${timestamp(macro.fetchedAt)}`
          : "Source: Federal Reserve Bank of St. Louis (FRED)"}
      </p>
      <p className="macro-timing-note">
        Observation periods above describe the data. Retrieval time does not
        make an older observation current.
      </p>
    </section>
  );
}
