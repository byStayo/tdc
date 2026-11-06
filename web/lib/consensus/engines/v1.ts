// Frozen implementation for consensus-rules-1.0.0 and 1.1.0.
// Copied from release 7efc9d6; both versions used identical aggregation and family priors.
// Historical readers must not import evolving registry weights or engine rules.
import type { FamilyDefinition } from "../types.ts";
export const FAMILIES: FamilyDefinition[] = [
  {
    id: "social",
    label: "Social pulse",
    detail: "X and Instagram, separately sampled",
    weight: 1,
  },
  {
    id: "retail",
    label: "Retail crowd",
    detail: "Positioning and community sentiment",
    weight: 1,
  },
  {
    id: "institutions",
    label: "Institutional positioning",
    detail: "Asset managers and leveraged funds",
    weight: 1,
  },
  {
    id: "options",
    label: "Options & volatility",
    detail: "IV, skew, gamma and expiration",
    weight: 1,
  },
  {
    id: "technicals",
    label: "Price & mathematics",
    detail: "Trend, momentum, Fibonacci and range",
    weight: 1,
  },
  {
    id: "premarket",
    label: "Before the bell",
    detail: "Overnight gap, volume and price range",
    weight: 1,
  },
  {
    id: "events",
    label: "Binary catalysts",
    detail: "Event risk and prediction markets",
    weight: 1,
  },
  {
    id: "analysts",
    label: "Analyst revisions",
    detail: "Estimate, target and recommendation changes",
    weight: 1,
  },
  {
    id: "news",
    label: "News cycle",
    detail: "Dated, source-linked developments",
    weight: 1,
  },
  {
    id: "earnings",
    label: "Earnings",
    detail: "Reported results and expectations",
    weight: 1,
  },
  {
    id: "liquidity",
    label: "Liquidity",
    detail: "Fed assets, Treasury cash and reverse repo",
    weight: 1,
  },
  {
    id: "rates",
    label: "Rates & bonds",
    detail: "Treasury curve and funding conditions",
    weight: 1,
  },
  {
    id: "fx",
    label: "Currency markets",
    detail: "Dollar and major exchange rates",
    weight: 1,
  },
  {
    id: "international",
    label: "Around the world",
    detail: "Central banks and international context",
    weight: 1,
  },
  {
    id: "capital",
    label: "Capital flows",
    detail: "Bank credit, cross-border and private capital",
    weight: 1,
  },
];

import type {
  Consensus,
  Horizon,
  Instrument,
  Signal,
  SignalStatus,
} from "../types.ts";

export const clamp = (n: number, low = -1, high = 1) =>
  Math.min(high, Math.max(low, n));
export function effectiveStatus(signal: Signal, now: string): SignalStatus {
  if (signal.status !== "available") return signal.status;
  if (
    !signal.source.observedAt ||
    !Number.isFinite(Date.parse(signal.source.observedAt))
  )
    return "unavailable";
  return Date.parse(now) - Date.parse(signal.source.observedAt) >
    signal.staleAfterDays * 86400000
    ? "stale"
    : "available";
}

/** Equal family priors. More indicators inside one family never create more family weight. */
export function calculateConsensus(
  signals: Signal[],
  instrument: Instrument,
  horizon: Horizon,
  now: string,
): Consensus {
  const applicable = signals.filter((signal) =>
    signal.instruments.includes(instrument),
  );
  const families = FAMILIES.map((family) => {
    const members = applicable.filter((signal) => signal.family === family.id);
    const current = members.filter(
      (signal) => effectiveStatus(signal, now) === "available",
    );
    const votes = current
      .map((signal) => signal.scores[horizon])
      .filter((n): n is number => n !== null && Number.isFinite(n));
    return {
      id: family.id,
      label: family.label,
      weight: family.weight,
      expected: members.length || 1,
      available: current.length,
      score: votes.length
        ? clamp(votes.reduce((sum, n) => sum + clamp(n), 0) / votes.length)
        : null,
      status: (current.length
        ? "available"
        : members.some((signal) => effectiveStatus(signal, now) === "stale")
          ? "stale"
          : "unavailable") as SignalStatus,
    };
  });
  const totalWeight = families.reduce((sum, family) => sum + family.weight, 0);
  const coverage =
    families.reduce(
      (sum, family) =>
        sum + (family.weight * family.available) / family.expected,
      0,
    ) / totalWeight;
  const voting = families.filter((family) => family.score !== null);
  const voteWeight = voting.reduce((sum, family) => sum + family.weight, 0);
  const score = voteWeight
    ? voting.reduce((sum, family) => sum + family.score! * family.weight, 0) /
      voteWeight
    : null;
  const bullish = voting.filter((family) => family.score! > 0.1).length;
  const bearish = voting.filter((family) => family.score! < -0.1).length;
  const neutral = voting.length - bullish - bearish;
  const agreement =
    bullish + bearish ? Math.max(bullish, bearish) / (bullish + bearish) : null;
  const reasons: string[] = [];
  if (coverage < 0.7)
    reasons.push("Less than 70% of the requested evidence is current.");
  if (
    !families.some(
      (family) => family.id === "technicals" && family.score !== null,
    )
  )
    reasons.push("A verified price-based setup is missing.");
  if (
    !families.some((family) => family.id === "options" && family.available > 0)
  )
    reasons.push("Options risk is not measured.");
  if (voting.length < 5)
    reasons.push(
      "Fewer than five independent families provide directional readings.",
    );
  return {
    instrument,
    horizon,
    score,
    coverage,
    agreement,
    bullish,
    bearish,
    neutral,
    abstain: !!reasons.length,
    reasons,
    families,
    label: reasons.length
      ? "Incomplete picture"
      : score === null || Math.abs(score) <= 0.1
        ? "Signals are balanced"
        : score > 0.35
          ? "Risk-on lean"
          : score > 0.1
            ? "Cautiously constructive"
            : score < -0.35
              ? "Risk-off lean"
              : "Cautiously defensive",
  };
}
