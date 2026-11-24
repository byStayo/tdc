import { isDeepStrictEqual } from "node:util";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { rangeInstant } from "./regular-session-range.ts";
import { newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const TLT_PREMARKET_ID = "market-history-tlt-prior-premarket";
const day = 86_400_000;
export function nextPremarketOpen(session: string): string {
  for (let t = Date.parse(session) + day; ; t += day) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (!hasReviewedCalendar(date)) throw Error("Next premarket opening is outside the reviewed calendar");
    const clock = exchangeSession(date);
    if (clock) return clock.openAt;
  }
}

export function tltPremarketClocks(session: string) {
  const regular = exchangeSession(session);
  if (!regular) throw Error("TLT premarket requires an exchange session");
  const first = Date.parse(regular.openAt) - 330 * 60_000;
  // The consolidated dataset withholds a civil session for at least 48 hours.
  // Allow the full source session to age. The catalogue must also prove actual delivery.
  const endOfExtended = newYorkTimestamp(session.replaceAll("-", "") + "T200000")!;
  return {
    first, last: Date.parse(regular.openAt) - 60_000, observedAt: new Date(Date.parse(regular.openAt) - 1).toISOString(),
    earliest: new Date(Date.parse(endOfExtended) + 2 * day).toISOString(), expires: nextPremarketOpen(session)
  };
}

export type TltPremarketSample = {
  session: string; changePct: number; activeMinutes: number;
  vintageAt: string; retrievedAt: string; approvedAt: string; sha256: string
};

export function tltPremarketSignal(sample: TltPremarketSample, cutoff: string): Signal {
  const { session, changePct, activeMinutes, vintageAt, retrievedAt, approvedAt, sha256 } = sample;
  const { earliest, expires, observedAt } = tltPremarketClocks(session);
  if (![vintageAt, retrievedAt, approvedAt, cutoff].every(rangeInstant) || vintageAt < observedAt || approvedAt < earliest ||
    retrievedAt < vintageAt || approvedAt < retrievedAt || approvedAt >= expires || approvedAt > cutoff ||
    !/^[0-9a-f]{64}$/.test(sha256) || !Number.isFinite(changePct) || changePct <= -100 ||
    Number(changePct.toFixed(1)) !== changePct || !Number.isInteger(activeMinutes) || activeMinutes < 2 || activeMinutes > 330)
    throw Error("Invalid TLT premarket evidence or availability clock");
  const title = "TLT premarket on " + session;
  return {
    id: TLT_PREMARKET_ID, family: "premarket", title, shortLabel: title, instruments: ["TLT"],
    directionalInstruments: [], status: cutoff < expires ? "available" : "stale",
    staleAfterDays: (Date.parse(expires) - Date.parse(observedAt) - 1) / day,
    summary: `On ${session}, TLT changed ${changePct.toFixed(1)}% from the 4:00 a.m. open to the 9:29 a.m. closing minute in New York. The consolidated source recorded ${activeMinutes} of 330 minutes.`,
    methodology: "Reconcile the premarket price change across as-traded and split-only hourly bars. Verify both boundary minutes and count observed minutes from the provider’s consolidated coverage map.",
    limitation: "The 48-hour delivery lag limits coverage to mornings after a sufficiently long exchange closure. The observation expires at the next regular open.",
    scores: { daily: null, weekly: null, monthly: null }, unit: "%", series: [{ date: session, value: changePct }],
    metrics: [{ label: "Premarket change", unit: "%", date: session, value: changePct },
    { label: "Recorded minutes out of 330", unit: "minutes", date: session, value: activeMinutes }],
    source: {
      name: "Market History", url: "https://getmarkethistory.com/docs/guides/historical-stock-market-data/",
      observedAt, releasedAt: null, vintageAt, retrievedAt, approvedAt, sha256, frequency: "completed premarket sessions",
      attribution: "Market History consolidated US equities. Premarket calculation by The Daily Consensus.",
      usage: "Non-reconstructible derived statistics under the Market History data licence."
    }
  };
}

export function validateTltPremarket(signal: Signal, cutoff: string) {
  if (signal.id !== TLT_PREMARKET_ID) return;
  const source = signal.source;
  const expected = tltPremarketSignal({
    session: source.observedAt?.slice(0, 10) ?? "",
    changePct: signal.metrics[0]?.value, activeMinutes: signal.metrics[1]?.value,
    vintageAt: source.vintageAt!, retrievedAt: source.retrievedAt, approvedAt: source.approvedAt!, sha256: source.sha256!
  }, cutoff);
  if (!isDeepStrictEqual(signal, expected)) throw Error("TLT premarket fields or scope differ from the reviewed observation");
}
