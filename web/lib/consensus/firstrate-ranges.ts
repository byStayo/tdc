import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { immutableSourceReceipt } from "../publication-storage.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { FIRST_RATE_SYMBOLS } from "./firstrate-technicals.ts";
import { digest } from "./history.ts";
import { loadMarketHistoryRanges, recentRangeSessions } from "./market-history-ranges.ts";
import {
  RANGE_FUNDS, RANGE_POLICY_V2, rangeInstant, validateSessionRanges,
  type MarketHistoryRanges, type SessionRange, type SessionRanges,
} from "./regular-session-range.ts";
import { readResearchReceipt } from "./research-price-capture.ts";

type Fund = (typeof FIRST_RATE_SYMBOLS)[number];
const policy = "firstrate-regular-minute-to-five-v1";
const home = (root: string) => join(root, ".consensus/private-firstrate");
const reviewDir = (root: string, fund: Fund) => join(home(root), "regular-ranges-v1", fund);
const decoder = fileURLToPath(new URL("../../scripts/collect-firstrate-inputs.py", import.meta.url));
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const sha = /^[a-f0-9]{64}$/;

type NativeRange = {
  symbol: Fund; session: string; source: string; nativeSha256: string; capturedAt: string; vintageAt: string;
  activeMinutes: number; verifiedBuckets: number; closeFifth: number;
};
type Review = { method: typeof policy; symbol: Fund; session: string; nativeDigest: string; verifiedAt: string };
type Stored = { review: Review; sha256: string };

/** No network, outcome or daily settlement access. Only the coarse range leaves the native decoder. */
export async function replayFirstRateRange(root: string, fund: Fund, session: string, at: string) {
  const clock = exchangeSession(session);
  if (!FIRST_RATE_SYMBOLS.includes(fund) || !clock || !rangeInstant(at) ||
      Date.parse(clock.closeAt) - Date.parse(clock.openAt) !== 390 * 60_000 || clock.closeAt > at)
    throw Error("A completed ordinary FirstRate session is required");
  const { stdout } = await exec("python3", ["-B", decoder, session, "--cached-regular-range", fund,
    "--capture-root", join(home(root), "captures"), "--expected-close", clock.closeAt.replace(/Z$/, "+00:00")],
    { timeout: 12_000, maxBuffer: 4096 });
  const native: NativeRange = JSON.parse(stdout);
  if (native.symbol !== fund || native.session !== session ||
      native.source !== "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_" + fund + ".zip" ||
      !sha.test(native.nativeSha256) || !rangeInstant(native.vintageAt) || !rangeInstant(native.capturedAt) ||
      native.vintageAt < clock.closeAt || native.capturedAt < native.vintageAt || native.capturedAt > at ||
      !Number.isInteger(native.activeMinutes) || native.activeMinutes < 78 || native.activeMinutes > 390 ||
      native.verifiedBuckets !== 78 || !Number.isInteger(native.closeFifth) || native.closeFifth < 1 || native.closeFifth > 5)
    throw Error("FirstRate clock, source or regular range is invalid");
  return native;
}

function verifiedRow(stored: Stored, native: NativeRange, cutoff: string): SessionRange {
  const { review } = stored;
  if (stored.sha256 !== digest(review) || review.method !== policy || review.session !== native.session ||
      review.symbol !== native.symbol || review.nativeDigest !== digest(native) || !rangeInstant(review.verifiedAt) ||
      review.verifiedAt < native.capturedAt || review.verifiedAt > cutoff)
    throw Error("Saved FirstRate range differs from its original or review clock");
  return { fund: native.symbol, session: native.session, closeFifth: native.closeFifth,
    observedAt: exchangeSession(native.session)!.closeAt, verifiedAt: review.verifiedAt,
    receiptSha256: stored.sha256, source: "firstrate" };
}

function explain(error: unknown) {
  const message = (error as { stderr?: string })?.stderr?.trim().split("\n").at(-1);
  return (message || (error instanceof Error ? error.message : "Native range unavailable")).slice(0, 180);
}

/** Run after the ordinary FirstRate ZIP capture, even if its independent settlement control was unavailable. */
export async function prepareFirstRateRanges(root: string, clock = now) {
  const dates = recentRangeSessions(clock());
  return Promise.all(FIRST_RATE_SYMBOLS.map(async fund => {
    const failures: string[] = [];
    for (const session of dates) {
      try {
        if (!(await readResearchReceipt(join(home(root), "captures", session, "sample-" + fund + ".json")))) continue;
        const native = await replayFirstRateRange(root, fund, session, clock());
        const dir = reviewDir(root, fund), file = session + ".json";
        const existing = await readResearchReceipt<Stored>(join(dir, file));
        const stored = existing ?? await immutableSourceReceipt(dir, file, async () => {
          const review: Review = { method: policy, symbol: fund, session, nativeDigest: digest(native), verifiedAt: clock() };
          return { review, sha256: digest(review) };
        }, value => { verifiedRow(value, native, clock()); });
        verifiedRow(stored, native, clock());
        return { fund, session, verifiedAt: stored.review.verifiedAt, verifiedBuckets: native.verifiedBuckets,
          activeMinutes: native.activeMinutes, failures };
      } catch (error) { failures.push(session + " " + explain(error)); }
    }
    return { fund, session: null, failures };
  }));
}

/** Old Market History-only editions retain their exact v1 shape. Equal dates keep the signed hourly source. */
export function latestSessionRanges(market: MarketHistoryRanges | undefined, firstRate: SessionRange[], at: string,
  warn: (message: string) => void = () => {}): SessionRanges | undefined {
  if (market) validateSessionRanges(market, at);
  if (firstRate.length) {
    if (!firstRate.every(row => row.source === "firstrate")) throw Error("Unexpected source in FirstRate ranges");
    validateSessionRanges({ method: RANGE_POLICY_V2, rows: firstRate }, at);
  }
  const selected = RANGE_FUNDS.flatMap(fund => {
    const first = firstRate.find(row => row.fund === fund), hourly = market?.rows.find(row => row.fund === fund);
    if (first && (!hourly || first.session > hourly.session)) return [first];
    if (first && hourly && first.session === hourly.session && first.closeFifth !== hourly.closeFifth)
      warn(fund + " " + first.session + " FirstRate range differs from the verified as-traded hourly range");
    return hourly ? [{ ...hourly, source: "market-history" as const }] : [];
  });
  if (!selected.some(row => row.source === "firstrate")) return market;
  const mixed = { method: RANGE_POLICY_V2, rows: selected } as const;
  validateSessionRanges(mixed, at);
  return mixed;
}

/** Read-only as-of replay. A missing, late or corrupted refresh leaves earlier fresh, verified sources eligible. */
export async function loadDailySessionRanges(root: string, at: string,
  warn: (message: string) => void = () => {}) {
  const dates = recentRangeSessions(at);
  const [market, candidates] = await Promise.all([
    loadMarketHistoryRanges(root, at, warn).catch((error: unknown) => { warn(explain(error)); return undefined; }),
    Promise.all(FIRST_RATE_SYMBOLS.map(async fund => {
      for (const session of dates) {
        try {
          const stored = await readResearchReceipt<Stored>(join(reviewDir(root, fund), session + ".json"));
          if (!stored || stored.review.verifiedAt > at) continue;
          return verifiedRow(stored, await replayFirstRateRange(root, fund, session, at), at);
        } catch (error) { warn(fund + " " + session + ": " + explain(error)); }
      }
      return null;
    })),
  ]);
  return latestSessionRanges(market, candidates.filter(row => row !== null), at, warn);
}
