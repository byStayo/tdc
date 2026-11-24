import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { exchangeSession } from "./exchange-calendar.ts";
import { latestFirstRateSession } from "./firstrate.ts";
import { firstRatePremarketSignal, type PremarketSample } from "./firstrate-premarket.ts";
import { replayFirstRateRange } from "./firstrate-ranges.ts";
import { digest } from "./history.ts";
import { loadTltPremarket } from "./market-history-premarket.ts";
import { reviewedMarketHistoryRangeSources } from "./market-history-ranges.ts";
import { RANGE_FUNDS, rangeInstant, validateSessionRanges, type RangeFund, type SessionRange } from "./regular-session-range.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { TLT_PREMARKET_ID } from "./tlt-premarket-signal.ts";
import type { Signal, Snapshot } from "./types.ts";

export type PreviousPremarketFund = RangeFund;
export type PreviousPremarketFeature =
  | { status: "available"; sourceSession: string; candidate: number; control: number; availableAt: string; evidenceSha256: string }
  | { status: "unavailable"; reason: string };

type Equity = Exclude<RangeFund, "TLT">;
type Sealed<T> = { review: T; sha256: string };
type TapeReview = { policy: string; symbol: Equity; session: string; approvedAt: string; sampleDigest: string };
type RangeReview = { method: string; symbol: Equity; session: string; verifiedAt: string; nativeDigest: string };
const firstRate = ".consensus/private-firstrate";
const execute = promisify(execFile);
const unavailable = (reason: string) => ({ status: "unavailable", reason } as const);
const ordinary = (session: ReturnType<typeof exchangeSession>) =>
  session !== null && Date.parse(session.closeAt) - Date.parse(session.openAt) === 390 * 60_000;

/** Confirm only the specific held archive; the registrar separately verifies its public pre-open witness. */
async function sameArchive(root: string, snapshot: Snapshot) {
  const path = join(root, "public/consensus", snapshot.id + ".json");
  const file = await lstat(path);
  return file.isFile() && file.size > 0 &&
    isDeepStrictEqual(JSON.parse(await readFile(path, "utf8")), snapshot);
}

/** Only the dedicated minute/five-minute review is eligible. Earlier price settlement approvals are out of scope. */
async function equityTape(root: string, symbol: Equity, session: string, cutoff: string) {
  const saved = await readResearchReceipt<Sealed<TapeReview>>(join(root, firstRate, "premarket-reviewed", session, symbol + ".json"));
  if (!saved) return null;
  const { review } = saved;
  if (saved.sha256 !== digest(review) || review.policy !== "firstrate-premarket-minute-to-five-v1" ||
      review.symbol !== symbol || review.session !== session || !rangeInstant(review.approvedAt))
    throw Error("Invalid dedicated premarket review");
  if (review.approvedAt > cutoff) return null;
  // These are the same tracked decoder and fixed, cached-only CLI used to create the review on this installation.
  const { stdout } = await execute("python3", ["-B", join(root, "scripts/collect-firstrate-inputs.py"), session,
    "--cached-premarket", symbol, "--compare-premarket-grids", "--expected-close",
    exchangeSession(session)!.closeAt.replace(/Z$/, "+00:00")], { timeout: 15_000, maxBuffer: 4096 });
  const sample = JSON.parse(stdout) as PremarketSample & { url: string; verifiedBuckets: number };
  if (sample.symbol !== symbol || sample.session !== session ||
      sample.url !== "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_" + symbol + ".zip" ||
      !Number.isInteger(sample.verifiedBuckets) || sample.verifiedBuckets < 2 || sample.verifiedBuckets > 66 ||
      digest(sample) !== review.sampleDigest)
    throw Error("Minute and five-minute tape differs from review");
  return { signal: firstRatePremarketSignal(sample, review.approvedAt, cutoff), reviewSha: saved.sha256 };
}

async function equityRange(root: string, symbol: Equity, session: string, cutoff: string) {
  const saved = await readResearchReceipt<Sealed<RangeReview>>(join(root, firstRate, "regular-ranges-v1", symbol, session + ".json"));
  if (!saved) return null;
  const { review } = saved;
  if (saved.sha256 !== digest(review) || review.method !== "firstrate-regular-minute-to-five-v1" ||
      review.symbol !== symbol || review.session !== session || !rangeInstant(review.verifiedAt))
    throw Error("Invalid regular range review");
  if (review.verifiedAt > cutoff) return null;
  const native = await replayFirstRateRange(root, symbol, session, cutoff);
  if (review.nativeDigest !== digest(native) || review.verifiedAt < native.capturedAt)
    throw Error("Regular range differs from its original");
  const row: SessionRange = { fund: symbol, session, closeFifth: native.closeFifth, observedAt: exchangeSession(session)!.closeAt,
    verifiedAt: review.verifiedAt, receiptSha256: saved.sha256, source: "firstrate" };
  return { row, originalSha: native.nativeSha256 };
}

async function nativeTape(root: string, fund: RangeFund, session: string, cutoff: string) {
  if (fund !== "TLT") return equityTape(root, fund, session, cutoff);
  const signal = await loadTltPremarket(root, cutoff);
  return signal ? { signal, reviewSha: signal.source.sha256! } : null;
}

/** Read the previous ordinary session exactly as issued, without touching outcome ledgers, markets or live sources. */
export async function readPreviousPremarketFeature(
  root: string, snapshot: Snapshot, instrument: PreviousPremarketFund, targetSession: string,
): Promise<PreviousPremarketFeature> {
  let failure = "invalid-premarket-session-or-edition";
  try {
    const target = exchangeSession(targetSession);
    if (!RANGE_FUNDS.includes(instrument) || !target || !ordinary(target)) return unavailable("target-is-not-an-ordinary-session");
    if (snapshot.origin !== "prospective" || !rangeInstant(snapshot.issuedAt) || !rangeInstant(snapshot.cutoff) ||
        snapshot.id !== snapshot.issuedAt.replace(/[:.]/g, "-") || snapshot.cutoff > snapshot.issuedAt ||
        snapshot.issuedAt >= target.openAt)
      return unavailable("edition-is-not-before-this-session-open");
    // An edition issued after the prior close can be witnessed again on the target morning.
    // Bind the input to the scheduled target itself, so an older archive cannot slide past an intervening session.
    const session = latestFirstRateSession(new Date(Date.parse(target.openAt) - 1).toISOString());
    const prior = exchangeSession(session);
    if (!prior || !ordinary(prior)) return unavailable("immediately-prior-session-is-not-ordinary");
    if (snapshot.cutoff < prior.closeAt) return unavailable("edition-cutoff-precedes-the-immediately-prior-close");
    failure = "as-issued-archive-unverified";
    if (!await sameArchive(root, snapshot)) return unavailable(failure);

    const tapeId = instrument === "TLT" ? TLT_PREMARKET_ID : "firstrate-premarket-" + instrument;
    const signals = snapshot.signals.filter(s => s.id === tapeId);
    if (signals.length !== 1 || signals[0].status !== "available") return unavailable("fund-premarket-not-issued-as-available");
    const signal: Signal = signals[0];
    if (signal.series.length !== 1 || signal.series[0].date !== session)
      return unavailable("premarket-is-not-the-immediately-prior-session");
    const context = snapshot.regularSessionRanges;
    const rows = context?.rows.filter(row => row.fund === instrument);
    if (!context || rows?.length !== 1) return unavailable("fund-regular-range-not-issued");
    const [row] = rows;
    if (row.session !== session) return unavailable("regular-range-is-not-the-immediately-prior-session");
    failure = "as-issued-regular-range-invalid";
    validateSessionRanges({ ...context, rows }, snapshot.cutoff);

    failure = "native-premarket-not-verified-at-cutoff";
    const tape = await nativeTape(root, instrument, session, snapshot.cutoff);
    if (!tape || !isDeepStrictEqual(signal, tape.signal)) return unavailable(failure);

    failure = "native-regular-range-not-verified-at-cutoff";
    const [hourly, equity] = await Promise.all([
      reviewedMarketHistoryRangeSources(root, instrument, session, snapshot.cutoff),
      instrument === "TLT" ? null : equityRange(root, instrument, session, snapshot.cutoff),
    ]);
    if (equity && equity.originalSha !== signal.source.sha256) return unavailable("firstrate-source-originals-disagree");
    if (hourly && equity && hourly.row.closeFifth !== equity.row.closeFifth) return unavailable("regular-range-sources-disagree");
    const selected = row.source === "firstrate" ? equity?.row : hourly?.row;
    if (!selected || !isDeepStrictEqual({ ...selected, source: selected.source ?? "market-history" },
        { ...row, source: row.source ?? "market-history" })) return unavailable(failure);

    // Use the order/fields of the replayed canonical representations, independent of JSON key order or reissue.
    const availableAt = [tape.signal.source.approvedAt!, selected.verifiedAt].sort()[1];
    const evidenceSha256 = digest({
      method: "prior-premarket-vs-regular-close-location-v1", instrument, session,
      tape: digest(tape.signal), tapeReview: tape.reviewSha,
      range: digest({ ...selected, source: selected.source ?? "market-history" }), rangeReview: selected.receiptSha256,
    });
    return { status: "available", sourceSession: session, candidate: tape.signal.metrics[0].value,
      control: selected.closeFifth - 3, availableAt, evidenceSha256 };
  } catch { return unavailable(failure); }
}
