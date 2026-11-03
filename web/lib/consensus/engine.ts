import { FAMILIES } from "./registry.ts";
import { signalScore } from "./scoring-policy.ts";
import type {
  Consensus,
  Horizon,
  Instrument,
  Signal,
  SignalStatus,
} from "./types.ts";

export const clamp = (n: number, low = -1, high = 1) =>
  Math.min(high, Math.max(low, n));
export function effectiveStatus(signal: Signal, now: string): SignalStatus {
  if (signal.status !== "available") return signal.status;
  if (
    !signal.source.observedAt ||
    !Number.isFinite(Date.parse(signal.source.observedAt)) ||
    Date.parse(signal.source.observedAt) > Date.parse(now)
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
      .map((signal) => signalScore(signal, instrument, horizon))
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
  const directionalCoverage = totalWeight ? voteWeight / totalWeight : 0;
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
  if (directionalCoverage < 0.7)
    reasons.push("Less than 70% of independent families can cast a directional vote for this horizon.");
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
    directionalCoverage,
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
