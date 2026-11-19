import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { loadReviewedTltCash } from "./firstrate.ts";
import { digest } from "./history.ts";
import { closeMomentum, coreSessionCloses, fetchMarketHistoryHours, parseMarketHistoryHours,
  type MarketHistoryCapture } from "./market-history-closes.ts";
import { collectResearchPrices, readResearchReceipt, type ResearchPriceReceipt } from "./research-price-capture.ts";
import { tltCloseSignal } from "./tlt-close-signal.ts";
import { newYorkDate } from "./time.ts";

const DAY = 86_400_000;
const METHOD = "tlt-consolidated-final-hour-v1";
const directory = (root: string) => resolve(root, ".consensus/private-market-history/tlt-closing-trend");
type Issuer = NonNullable<Awaited<ReturnType<typeof loadReviewedTltCash>>>;
const controlIds = (receipts: ResearchPriceReceipt[]) => receipts.map(({ sha256, priceDigest }) => ({ sha256, priceDigest }));
type Review = { method: typeof METHOD; checkedAt: string; issuer: Issuer; capture: MarketHistoryCapture;
  from: string; through: string; raw: ReturnType<typeof controlIds>; splits: ReturnType<typeof controlIds> };

function verifiedCloses(review: Review, raw: ResearchPriceReceipt[], splits: ResearchPriceReceipt[]) {
  if (review.method !== METHOD || !Number.isFinite(Date.parse(review.checkedAt)) ||
      new Date(review.checkedAt).toISOString() !== review.checkedAt || review.issuer.issuer.capturedAt > review.checkedAt ||
      Date.parse(review.capture.capturedAt) > Date.parse(review.checkedAt) || review.through > review.issuer.through ||
      review.issuer.issuer.symbol !== "TLT" || !/^[a-f0-9]{64}$/.test(review.issuer.issuer.sha256) ||
      JSON.stringify(review.raw) !== JSON.stringify(controlIds(raw)) ||
      JSON.stringify(review.splits) !== JSON.stringify(controlIds(splits)))
    throw new Error("TLT closing-hour review differs from its pinned controls");
  const hours = parseMarketHistoryHours(review.capture, "TLT");
  if (hours.some(row => row.symbol_id !== 11418)) throw new Error("The Market History TLT instrument ID changed");
  const url = new URL(review.capture.source);
  if (url.searchParams.get("start") !== review.from || url.searchParams.get("end") !== review.issuer.through ||
      url.searchParams.get("feed") !== "consolidated" || url.searchParams.get("adjust") !== "raw")
    throw new Error("TLT closing hours need the reviewed raw consolidated series");
  const dates = exchangeSessions(review.from, review.through);
  const clocks = dates.map(day => exchangeSession(day)!);
  const { closes } = coreSessionCloses(hours, clocks, review.capture.through);
  const rawByDay = new Map(raw.flatMap(receipt => receipt.sessions.map(row => [row.session, row.close] as const)));
  const splitByDay = new Map(splits.flatMap(receipt => receipt.sessions.map(row => [row.session, row.close] as const)));
  const qualified = closes.filter(row => {
    const reference = rawByDay.get(row.session);
    // A shortened Tape C session still requires the separate listing review.
    return !row.earlyClose && reference !== undefined && reference === splitByDay.get(row.session) &&
      Math.abs(row.close / reference - 1) * 10000 <= 15;
  });
  if (!qualified.length || qualified.at(-1)!.session !== review.through) return null;
  const changes = closeMomentum(qualified, dates, review.issuer.issuer.cash);
  const values = changes.flatMap(row => row.issuerAdjustedChangePct === null ? [] : [row.issuerAdjustedChangePct]);
  if (!values.length) return null;
  const retrievedAt = [review.issuer.issuer.capturedAt, review.capture.capturedAt].sort().at(-1)!;
  return tltCloseSignal(review.through, values, retrievedAt, digest({
    method: METHOD, observation: review.through, source: review.capture.sha256,
    issuer: review.issuer.issuer.sha256, raw: review.raw, splits: review.splits, values,
  }));
}

async function latest(root: string) {
  const dir = directory(root);
  const pointer = await readResearchReceipt<{ sha256: string }>(resolve(dir, "latest.json"));
  if (!pointer) return null;
  if (!/^[a-f0-9]{64}$/.test(pointer.sha256)) throw new Error("Invalid TLT closing-hour pointer");
  const review = await readResearchReceipt<Review>(resolve(dir, pointer.sha256 + ".json"));
  if (!review || digest(review) !== pointer.sha256) throw new Error("TLT closing-hour receipt changed");
  return review;
}

async function controls(dir: string, dates: string[], cachedOnly: boolean) {
  const options = { cachedOnly, reviewedExchangeCalendar: true };
  const raw = await collectResearchPrices(dir, "TLT", dates, options);
  const splits = await collectResearchPrices(dir, "TLT", dates, { ...options, splitAdjusted: true });
  return { raw, splits };
}

export async function loadTltClosingTrend(root: string, cutoff: string) {
  const review = await latest(root);
  if (!review || review.checkedAt > cutoff || Date.parse(cutoff) - Date.parse(exchangeSession(review.through)!.closeAt) > 5 * DAY) return null;
  const { raw, splits } = await controls(directory(root), exchangeSessions(review.from, review.through), true);
  return verifiedCloses(review, raw, splits);
}

/** Called under the existing preparation lock. All exchange prices and controls remain owner-local. */
export async function prepareTltClosingTrend(root: string, recheck = false) {
  const now = new Date().toISOString();
  const issuer = await loadReviewedTltCash(root, now);
  if (!issuer) return { status: "waiting_for_issuer_history" };
  const old = await latest(root);
  if (!recheck && old && newYorkDate(old.checkedAt) === newYorkDate(now) && old.issuer.through === issuer.through &&
      old.issuer.issuer.sha256 === issuer.issuer.sha256) {
    const reading = await loadTltClosingTrend(root, now);
    return { status: reading ? "reused" : "withheld", through: old.through, metrics: reading?.metrics.length ?? 0 };
  }
  const start = new Date(Date.parse(issuer.through) - 35 * DAY).toISOString().slice(0, 10);
  const from = start < EXCHANGE_CALENDAR.from ? EXCHANGE_CALENDAR.from : start;
  const capture = await fetchMarketHistoryHours("TLT", from, issuer.through);
  const dates = exchangeSessions(from, issuer.through).filter(day =>
    Date.parse(exchangeSession(day)!.closeAt) <= Date.parse(capture.through));
  const through = dates.at(-1);
  if (!through || dates.length < 2) throw new Error("The source has too few completed TLT closing hours");
  const dir = directory(root);
  await durableDirectory(dir, 0o700);
  const { raw, splits } = await controls(dir, dates, false);
  const review: Review = { method: METHOD, checkedAt: new Date().toISOString(), issuer, capture, from, through,
    raw: controlIds(raw), splits: controlIds(splits) };
  const reading = verifiedCloses(review, raw, splits);
  const sha256 = digest(review);
  await durableJSON(resolve(dir, sha256 + ".json"), review, true);
  await durableJSON(resolve(dir, "latest.json"), { sha256 });
  return { status: reading ? "verified_closing_trend" : "withheld", through,
    metrics: reading?.metrics.map(({ label, value, unit }) => ({ label, value, unit })) ?? [] };
}
