import { createElement } from "react";
import type { Metric } from "../lib/consensus/types.ts";
import { gaapEpsPair } from "../lib/display-format.ts";

export default function ReportedEpsComparison({ frequency, metrics, className }: {
  frequency: string;
  metrics: Metric[];
  className?: string;
}) {
  const current = metrics.find((metric) => metric.label === "GAAP diluted EPS");
  const prior = metrics.find((metric) => metric.label === "Prior-year GAAP diluted EPS");
  if (frequency !== "quarterly company release" || !current || !Number.isFinite(current.value)) return null;
  const priorValue = prior && Number.isFinite(prior.value) ? prior.value : undefined;
  return createElement("small", { className },
    priorValue === undefined ? null : "Current vs year-earlier quarter",
    createElement("span", { style: { display: "block", whiteSpace: "nowrap" } },
      gaapEpsPair(current.value, priorValue)),
  );
}
