import { createHash } from "node:crypto";
import { immutableSourceReceipt } from "../publication-storage.ts";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { policyCsv } from "./policy.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";
import type { Point, Signal } from "./types.ts";

export const PRIMARY_DEALER_POSITION_ID = "nyfed-dealer-long-treasury-positions";
const page = "https://www.newyorkfed.org/markets/counterparties/primary-dealers-statistics";
const api = "https://markets.newyorkfed.org/api/pd/";
const key = "PDPOSGSC-G21";
const historyUrl = api + "get/SBN2024/timeseries/" + key + ".json";
const weeklyUrl = api + "latest/SBN2024.csv";
const unit = "USD millions";
const changeLabel = "Weekly change in net dealer positions";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const instant = (t: unknown): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)) && new Date(t).toISOString() === t;
const day = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && publicDate(d) === d;

function amount(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Suppressed or invalid primary dealer position");
  return Number(value);
}

function adjacent(points: Point[], asOf: string) {
  if (points.length !== 2 || !instant(asOf) || points.some(p => !day(p.date) || !Number.isSafeInteger(p.value)) ||
      points[0].date < "2024-07-03" || points[1].date > newYorkDate(asOf)) return false;
  const days = (Date.parse(points[1].date) - Date.parse(points[0].date)) / 86400000;
  return days >= 5 && days <= 9;
}

/** The Fed's separate weekly release publishes both the net balance and its signed week-over-week change. */
export function dealerPositionReading(history: string, csv: string, asOf: string): Point[] {
  const rows = JSON.parse(history).pd?.timeseries;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 2000 ||
      rows.some((row, i) => row?.keyid !== key || !day(row.asofdate) || (i > 0 && row.asofdate <= rows[i - 1].asofdate)))
    throw new Error("Invalid series identity or ordering for New York Fed dealer positions");
  const points = rows.slice(-2).map(row => ({date: row.asofdate as string, value: amount(row.value)}));
  if (!adjacent(points, asOf)) throw new Error("Missing consecutive New York Fed reporting weeks");
  const [header, ...weekly] = policyCsv(csv);
  if (header?.join("|") !== "As Of Date|Time Series|Value (millions)") throw new Error("Unknown weekly position units");
  const [prior, current] = points;
  for (const [id, expected] of [[key, current.value], [key + "C", current.value - prior.value]] as const) {
    const matched = weekly.filter(r => r[1] === id);
    if (matched.length !== 1 || matched[0].length !== 3 || matched[0][0] !== current.date || amount(matched[0][2]) !== expected)
      throw new Error("Weekly dealer report differs from the position history");
  }
  return points;
}

function base(at: string): Signal {
  return {
    id: PRIMARY_DEALER_POSITION_ID, family: "institutions", title: "Primary dealers’ long-maturity Treasury positions",
    shortLabel: "Dealer Treasury positions", instruments: ["MARKET", "TLT"], directionalInstruments: [],
    status: "unavailable", summary: "The weekly long-maturity dealer position could not be reconciled.",
    source: { name: "Federal Reserve Bank of New York · Primary Dealer Statistics", url: page,
      observedAt: null, releasedAt: null, retrievedAt: at, sha256: null, frequency: "weekly",
      attribution: "Federal Reserve Bank of New York, Primary Dealer Statistics.",
      usage: "The Daily Consensus selected the over-21-year nominal Treasury series and calculated its weekly change. Federal Reserve Bank of New York terms apply at https://www.newyorkfed.org/privacy/termsofuse." },
    methodology: "Subtract the preceding weekly net outright position from the current balance. Verify both the level and the change against the separately delivered weekly report. The publisher records when it first verified the pair.",
    limitation: "Reporting dealers hold inventory as part of market making. The maturity bucket differs from TLT’s portfolio. The Fed generally publishes the prior week’s figures on Thursday and may revise them.",
    scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 21, unit, metrics: [], series: [],
  };
}

type DealerReceipt = { history: PublicDocument; weekly: PublicDocument };
const observedAt = (r: DealerReceipt) => [r.weekly.retrievedAt, r.history.retrievedAt].sort()[1];
function verifyOriginals(r: DealerReceipt, asOf: string) {
  for (const d of [r.history, r.weekly]) {
    if (!instant(d.retrievedAt) || d.retrievedAt > asOf || d.sha256 !== hash(d.text))
      throw new Error("Dealer source receipt differs from the original");
  }
  return dealerPositionReading(r.history.text, r.weekly.text, observedAt(r));
}
export async function collectPrimaryDealerPositions(read: (url: string) => Promise<PublicDocument>, directory?: string,
  now = () => new Date().toISOString()): Promise<Signal> {
  try {
    const [history, weekly] = await Promise.all([read(historyUrl), read(weeklyUrl)]);
    const fresh = {history, weekly}, at = now(), series = verifyOriginals(fresh, at);
    const fingerprint = hash(JSON.stringify(series));
    const saved = await immutableSourceReceipt(directory, fingerprint + ".json", async () => fresh, receipt => {
      if (hash(JSON.stringify(verifyOriginals(receipt, at))) !== fingerprint) throw new Error("Changed dealer position receipt");
    });
    const output = base(observedAt(fresh));
    const [prior, current] = series;
    const value = current.value - prior.value;
    output.status = "available";
    output.summary = "Primary dealers reported a net position of $" + (current.value / 1000).toLocaleString("en-US", {maximumFractionDigits: 3}) + " billion in nominal Treasury coupons due in more than 21 years.";
    output.source = { ...output.source, observedAt: current.date, vintageAt: observedAt(saved),
      sha256: hash(saved.history.sha256 + ":" + saved.weekly.sha256) };
    output.series = series;
    output.metrics = [{ label: changeLabel, date: current.date, value, unit }];
    validatePrimaryDealerPositions(output, at);
    return output;
  } catch (error) {
    return { ...base(now()), failureKind: sourceFailureKind(error) };
  }
}

export function validatePrimaryDealerPositions(signal: Signal, cutoff: string) {
  if (signal.id !== PRIMARY_DEALER_POSITION_ID) return;
  const s = signal.source, original = base(s.retrievedAt);
  if (signal.family !== original.family || signal.instruments.join() !== original.instruments.join() ||
      signal.directionalInstruments?.length !== 0 || Object.keys(signal.scores).sort().join() !== "daily,monthly,weekly" ||
      Object.values(signal.scores).some(score => score !== null) || signal.staleAfterDays !== original.staleAfterDays ||
      signal.unit !== unit || s.url !== page || s.name !== original.source.name || s.frequency !== "weekly" ||
      s.attribution !== original.source.attribution || s.usage !== original.source.usage || s.releasedAt !== null ||
      !instant(cutoff) || !instant(s.retrievedAt) || s.retrievedAt > cutoff)
    throw new Error("Unverified dealer position scope, timing or source");
  if (signal.status === "unavailable") {
    if (s.sha256 !== null || s.observedAt !== null || s.vintageAt !== undefined || signal.series.length || signal.metrics.length)
      throw new Error("Unavailable dealer observation has figures");
    return;
  }
  if (signal.status !== "available" || !instant(s.vintageAt) || s.vintageAt > s.retrievedAt ||
      !adjacent(signal.series, s.vintageAt) || s.observedAt !== signal.series[1].date ||
      !/^[a-f0-9]{64}$/.test(s.sha256 ?? "") || signal.metrics.length !== 1) throw new Error("Invalid dealer position dates or receipt");
  const [prior, latest] = signal.series, m = signal.metrics[0];
  if (m.date !== latest.date || m.label !== changeLabel || m.unit !== unit || m.value !== latest.value - prior.value)
    throw new Error("Unverified dealer position change");
}
