import { ENGINE_VERSION, MACRO_SERIES } from "./registry.ts";
import type { Horizon, Instrument, Signal, Snapshot } from "./types.ts";

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
