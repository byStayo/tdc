// Frozen rules2.0.0 aggregation, scoring policy and priors from a0d4830.
// Historical replay must never import the evolving engine, policy or registry.
import type { FamilyDefinition, Consensus, Horizon, Instrument, Signal, SignalStatus, Snapshot } from "../types.ts";
export const ENGINE_VERSION = "consensus-rules-2.0.0";
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

export const MACRO_SERIES = [
  {
    id: "DGS2",
    title: "2-year Treasury",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "DGS10",
    title: "10-year Treasury",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "DGS30",
    title: "30-year Treasury",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "SOFR",
    title: "Overnight funding · SOFR",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "EFFR",
    title: "Effective federal funds rate",
    family: "rates",
    unit: "%",
    lag: 7,
    scale: 0.25,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "WALCL",
    title: "Federal Reserve assets",
    family: "liquidity",
    unit: "$m",
    lag: 14,
    scale: 200000,
    polarity: 1,
    frequency: "weekly",
  },
  {
    id: "WTREGEN",
    title: "Treasury General Account",
    family: "liquidity",
    unit: "$m",
    lag: 14,
    scale: 100000,
    polarity: -1,
    frequency: "weekly",
  },
  {
    id: "RRPONTSYD",
    title: "Overnight reverse repo",
    family: "liquidity",
    unit: "$bn",
    lag: 7,
    scale: 100,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "WRESBAL",
    title: "Reserve balances",
    family: "liquidity",
    unit: "$m",
    lag: 14,
    scale: 200000,
    polarity: 1,
    frequency: "weekly",
  },
  {
    id: "DTWEXBGS",
    title: "Broad US dollar",
    family: "fx",
    unit: "index",
    lag: 14,
    scale: 2,
    polarity: -1,
    frequency: "daily",
  },
  {
    id: "BUSLOANS",
    title: "Commercial & industrial loans",
    family: "capital",
    unit: "$bn",
    lag: 70,
    scale: 60,
    polarity: 1,
    frequency: "monthly",
  },
  {
    id: "TOTBKCR",
    title: "Commercial bank credit",
    family: "capital",
    unit: "$bn",
    lag: 21,
    scale: 150,
    polarity: 1,
    frequency: "weekly",
  },
] as const;


const EQUITIES: Instrument[] = ["MARKET", "SPY", "QQQ", "IWM", "DIA"];
const NONE = { daily: null, weekly: null, monthly: null };
function change(signal: Signal, count: number | null, scale: number, polarity = 1): number | null {
  if (count === null || signal.status !== "available" || signal.series.length <= count) return null;
  return Math.max(-1, Math.min(1, (signal.series.at(-1)!.value - signal.series.at(-1 - count)!.value) / scale * polarity));
}

/** Directional eligibility is saved in the publication, not decided by the UI. */
export function signalScore(signal: Signal, instrument: Instrument, horizon: Horizon): number | null {
  return signal.instruments.includes(instrument) &&
    (!signal.directionalInstruments || signal.directionalInstruments.includes(instrument))
    ? signal.scores[horizon] : null;
}

/** New rule version only; never apply this transform when reading an archive. */
export function applyScoringPolicy(snapshot: Snapshot): Snapshot {
  const signals = snapshot.signals.map((signal): Signal => {
    const descriptor = MACRO_SERIES.find(item => signal.id === `fred-${item.id}`);
    if (descriptor) {
      const windows = descriptor.frequency === "daily" ? [1, 5, 21] : descriptor.frequency === "weekly" ? [null, 1, 4] : [null, null, 1];
      const durationEligible = ["DGS10", "DGS30"].includes(descriptor.id);
      return {
        ...signal,
        directionalInstruments: durationEligible ? [...EQUITIES, "TLT"] : [...EQUITIES],
        scores: {
          daily: change(signal, windows[0], descriptor.scale, descriptor.polarity),
          weekly: change(signal, windows[1], descriptor.scale, descriptor.polarity),
          monthly: change(signal, windows[2], descriptor.scale, descriptor.polarity),
        },
        methodology: `Published ${descriptor.frequency} changes scaled by ${descriptor.scale} ${descriptor.unit} and capped to [-1,1]. ${descriptor.polarity > 0 ? "Rises" : "Falls"} are a declared supportive equity prior, not measured predictive accuracy. Daily series use 1/5/21 observations for daily/weekly/monthly; weekly series vote only weekly/monthly using 1/4 reports; monthly series vote only monthly using 1 report. TLT receives only the 10-year and 30-year yield-change priors (falling yields supportive); funding, dollar, liquidity and credit series remain nonvoting TLT context. These lagged context windows are not forward return forecasts.`,
      };
    }
    if (/^earnings-[A-Z]{1,6}$/.test(signal.id)) {
      return { ...signal, scores: { ...NONE }, methodology: "Reported quarterly financial figures and year-over-year comparisons are context only. Revenue growth is not a surprise against expectations or evidence of the next daily, weekly or monthly price direction. No directional vote until matched expectations and a reviewed response model are available. Original source, period and any restatement limitations remain attached." };
    }
    if (signal.id.startsWith("cftc-")) {
      const code = signal.id.split("-")[1], bond = ["020601", "043602"].includes(code);
      return {
        ...signal,
        ...(bond ? { instruments: ["TLT"] as Instrument[] } : {}),
        scores: code === "043602" ? { ...NONE } : {
          daily: null, weekly: change(signal, 1, 10), monthly: change(signal, 4, 15),
        },
        methodology: "Futures-only net contracts divided by open interest. Standing net levels are context only and never a daily vote. Weekly/monthly use 1/4-report changes scaled by 10/15 percentage points, capped [-1,1]; these are declared priors, not measured predictive accuracy. Equity contracts apply to their named ETF and MARKET. Treasury bond futures apply only to TLT. The 10-year Treasury contract is intermediate-duration context only, with no TLT or MARKET directional vote.",
      };
    }
    return signal;
  });
  return { ...snapshot, engineVersion: ENGINE_VERSION, signals, consensus: undefined, forecasts: undefined };
}

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
