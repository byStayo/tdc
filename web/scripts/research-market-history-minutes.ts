import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adjustETFPrices } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeSessions, hasReviewedCalendar } from "../lib/consensus/exchange-calendar.ts";
import { extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { readNasdaqHistoricalControl } from "../lib/consensus/kibot-session-witnesses.ts";
import { boundaryClock, compareMarketHistoryBoundary, contiguousTltWindows } from "../lib/consensus/market-history-boundaries.ts";
import {
  cachedPaidMinute, collectPaidMinutes, confirmedPaidMinutes, paidMinuteLimits, paidMinutePlan,
  type PaidMinuteEntitlement
} from "../lib/consensus/market-history-paid-minutes.ts";
import { readTltIssuer, tltNativeBar, type NativeOriginal } from "../lib/consensus/market-history-settlement.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const usage = [
  "research-market-history-minutes.ts CONTROL_REVIEW_SHA256 [--issuer SHA256] [--collect [--retry]]",
  "The default replays private controls and cached minutes without network or writes.",
  "An optional issuer digest pins a separately verified iShares original, for example a later post-close capture.",
  "Paid collection requires an owner-only ~/.local/share/daily-consensus/market-history-paid-minutes/entitlement.json",
  'with {"paidMinutes":"owner-activated","apiKey":"<dedicated prepaid key>","maxBars":8000,"maxRequests":40}.',
  "Limits apply cumulatively across runs. The gross reservation survives interrupted requests. The command publishes nothing.",
].join("\n");
const [reviewId, ...flags] = process.argv.slice(2);
if (!reviewId || reviewId === "--help") {
  console.log(usage);
  process.exit(0);
}
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const issuerAt = flags.indexOf("--issuer");
const issuerArg = issuerAt < 0 ? undefined : flags.splice(issuerAt, 2)[1];
if ((issuerAt >= 0 && !sha(issuerArg)) || !sha(reviewId) || new Set(flags).size !== flags.length || flags.some(f => f !== "--collect" && f !== "--retry") ||
  (flags.includes("--retry") && !flags.includes("--collect"))) throw new Error(usage);
const root = fileURLToPath(new URL("../", import.meta.url));
const priorDir = resolve(root, ".consensus/private-market-history/tlt-settlement");
const rawDir = resolve(root, ".consensus/private-kibot/sources");
const paidDir = resolve(homedir(), ".local/share/daily-consensus/market-history-paid-minutes");
const cutoff = new Date().toISOString();
type Source = { sha256: string; location?: { kind: string; sha256: string; capturedAt?: string; generation?: string } };
type Day = { day: string; raw: Source | null; split: Source | null; listed: Source | null };
type ControlReview = { scope: string; from: string; through: string; review: Day[]; issuer: string | null };
const review = await readResearchReceipt<ControlReview>(resolve(priorDir, reviewId + ".json"));
if (!review || digest(review) !== reviewId || review.scope !== "private-source-qualification" ||
  !sha(review.issuer) || !Array.isArray(review.review) || Date.parse(review.through) - Date.parse(review.from) > 35 * 86_400_000)
  throw new Error("An original private TLT control review and issuer digest are required");
const sessions = (hasReviewedCalendar(review.from) ? exchangeSessions : extendedResearchSessions)(review.from, review.through);
if (!sessions.length || sessions.length !== review.review.length || sessions.some((d, i) => d !== review.review[i].day))
  throw new Error("Pinned review does not contain the complete reviewed calendar");

async function originalIssuer(expected: string) {
  const sources = [{ kind: "kibot" as const, directory: rawDir }, {
    kind: "firstrate" as const,
    directory: resolve(root, ".consensus/private-firstrate/captures")
  }];
  for (const { kind, directory } of sources) {
    const names = await readdir(directory).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    for (const session of names.filter(n => /^\d{4}-\d\d-\d\d$/.test(n)).sort().reverse()) {
      const p = kind === "kibot" ? resolve(directory, session, "issuer-post-close/TLT/issuer-TLT.json") : resolve(directory, session, "issuer-TLT.json");
      const meta = await readResearchReceipt<{ sha256: string }>(p);
      if (meta?.sha256 === expected) return readTltIssuer(root, { kind, session }, cutoff);
    }
  }
  return null;
}

async function originalNative(day: string, expected: Source | null, split: boolean) {
  if (!expected || !sha(expected.sha256)) return undefined;
  const loc = expected.location;
  if (loc && (loc.sha256 !== expected.sha256 || !["kibot", "qualification"].includes(loc.kind) || (split && loc.kind !== "qualification")))
    throw new Error("Invalid pinned native control location");
  const folders = [];
  if (!split && (!loc || loc.kind === "kibot")) folders.push(resolve(rawDir, day));
  if (!loc || loc.kind === "qualification") folders.push(resolve(priorDir, "controls", day));
  for (const folder of folders) {
    const original = await readResearchReceipt<NativeOriginal>(resolve(folder, split ? "TLT-splits.json" : "TLT-kibot.json"));
    if (original?.sha256 === expected.sha256 && (!loc?.capturedAt || original.capturedAt === loc.capturedAt))
      return tltNativeBar(original, day, split, cutoff);
  }
  throw new Error("Original TLT price control differs from pinned private review");
}

async function originalListed(day: Day, range: { from: string; through: string }) {
  if (!day.listed) return undefined;
  const loc = day.listed.location;
  if (loc && !["kibot", "range"].includes(loc.kind)) throw new Error("Invalid pinned listing control location");
  let directory = resolve(rawDir, day.day);
  if (loc?.kind === "range") {
    if (!/^\d{4}-\d\d-\d\d(?:T\d\d-\d\d-\d\d\.\d{3}Z)?$/.test(loc.generation ?? "")) throw new Error("Invalid Nasdaq original location");
    directory = resolve(priorDir, "controls", loc.generation!);
  }
  const original = await readNasdaqHistoricalControl(directory, "TLT", day.day, false, fetch, boundaryClock, loc?.kind === "range" ? range : undefined);
  if (!sha(day.listed.sha256) || original.stamp.sha256 !== day.listed.sha256 || original.stamp.capturedAt > cutoff ||
    (loc && (loc.sha256 !== original.stamp.sha256 || (loc.capturedAt && loc.capturedAt !== original.stamp.capturedAt))))
    throw new Error("Independent listing history differs from pinned TLT review");
  return { session: day.day, ...original.prices };
}

async function originalAuction(day: string) {
  if (day !== "2025-11-28") return undefined;
  // Same previously independently reviewed Nasdaq ITCH original used for the free hourly comparison.
  const path = resolve(root, ".consensus/private-nasdaq-crosses/2025-11-28-e965ea6f9779.json");
  const original = await readResearchReceipt<{ comparison: { symbol: string; open: { price: number }; close: { price: number } }[] }>(path);
  if (!original) return undefined;
  if (createHash("sha256").update(await readFile(path)).digest("hex") !== "2cc16cfd6ff2b5f8051384488352a7c6df2350e6f47acb23dca79ae8d0f0d485")
    throw new Error("Previously reviewed Nasdaq shortened session original changed");
  const tlt = original.comparison.find(r => r.symbol === "TLT");
  return tlt && { session: day, open: tlt.open.price, close: tlt.close.price };
}

const issuerId = issuerArg ?? review.issuer;
const issuer = await originalIssuer(issuerId);
if (!issuer || issuer.sha256 !== issuerId) throw new Error("Missing pinned iShares distribution original");
const controls = await Promise.all(review.review.map(async row => {
  const [raw, split, listed, auction] = await Promise.all([originalNative(row.day, row.raw, false), originalNative(row.day, row.split, true),
  originalListed(row, { from: sessions[0], through: sessions.at(-1)! }), originalAuction(row.day)]);
  const plan = paidMinutePlan(row.day);
  const issuerCovered = issuer.capturedAt > plan.clock.closeAt && issuer.cash[0].session <= row.day;
  const reference = listed ?? auction;
  const ready = !!raw && !!split && raw.open === split.open && raw.close === split.close && !!reference &&
    Math.sign(raw.close - raw.open) === Math.sign(reference.close - reference.open) && issuerCovered &&
    (plan.count !== 210 || !!auction) && plan.close + 48 * 3_600_000 <= Date.parse(cutoff);
  return { day: row.day, plan, raw, split, reference, auction, issuerCovered, ready };
}));
const readyDays = controls.filter(r => r.ready).map(r => r.day);
if (flags.includes("--collect")) {
  const e = confirmedPaidMinutes(await readResearchReceipt<PaidMinuteEntitlement>(resolve(paidDir, "entitlement.json")));
  if (readyDays.length) await collectPaidMinutes(paidDir, readyDays, e, flags.includes("--retry"));
}
const asOf = new Date().toISOString();
const results = await Promise.all(controls.map(async r => {
  const boundary = await cachedPaidMinute(paidDir, r.day, asOf);
  const status = boundary ? compareMarketHistoryBoundary(boundary, r.raw, r.split, r.reference, r.issuerCovered, r.auction)
    : r.ready ? "awaiting_licensed_minutes" : "controls_or_delivery_pending";
  return { day: r.day, raw: r.raw ?? null, boundary: boundary ?? undefined, status };
}));
const windows = contiguousTltWindows(results, issuer.cash);
const adjusted = windows.flatMap(w => adjustETFPrices(w.map(r => ({ ...boundaryClock(r.day)!, open: r.boundary!.open!, close: r.boundary!.close! })),
  issuer.cash.filter(c => c.session >= w[0].day && c.session <= w.at(-1)!.day), []));
console.log(JSON.stringify({
  scope: "private TLT minute qualification", controlReview: reviewId, issuerSha256: issuerId, issuerCapturedAt: issuer.capturedAt, from: review.from, through: review.through,
  independentlyReady: readyDays.length, pendingMinuteBars: results.filter(r => r.status === "awaiting_licensed_minutes")
    .reduce((n, r) => n + paidMinutePlan(r.day).maximumBars, 0), limits: paidMinuteLimits, qualifiedSessions: adjusted.length,
  adjustedDigest: adjusted.length ? digest(adjusted) : null, days: results.map(({ day, status }) => ({ day, status }))
}, null, 2));
