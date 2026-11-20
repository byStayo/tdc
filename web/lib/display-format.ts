import type { Family, Metric } from "./consensus/types.ts";

/** Currency values retain the loss sign and equal precision; no EPS growth inference. */
export function gaapEpsPair(current: number, prior?: number): string {
  const dollars = (value: number) =>
    `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return `GAAP EPS ${dollars(current)}${prior === undefined ? "" : ` vs ${dollars(prior)}`}`;
}

/** Replace only known tooling blurbs; preserve stale/error/source notices. */
export function publicationNotice(message: string): string {
  return (message === "Published research from dated official evidence, reviewed through the Codex subscription. No runtime model generation." ||
    message === "Reviewed from dated primary evidence using the Codex subscription.")
    ? "Published research reviewed against dated official evidence. Source dates are preserved."
    : message;
}

/** Presentation only: preserve stored units and precision in the edition. */
export function signalMetricLabel(metric: Metric, family: Family): string {
  if (!Number.isFinite(metric.value)) return "—";
  const change = /change/i.test(metric.label);
  const rateChange = family === "rates" && metric.unit === "%" && change;
  const value = rateChange ? metric.value * 100 : metric.value;
  const unit = rateChange ? "bp" : metric.unit;
  const digits = family === "fx" && unit === "USD" ? 6 : 2;
  const precision = Number(value.toFixed(digits));
  const rounded = Object.is(precision, -0) ? 0 : precision;
  const sign = change && rounded > 0 ? "+" : "";
  const number = rounded.toLocaleString("en-US", { maximumFractionDigits: digits });
  return `${sign}${number}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}
