import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { firstRateIssuerActionProof, type MarketHistoryActionProof } from "./market-history-actions.ts";
import { ComparisonUnavailable, collectMarketHistoryPriceControls, type HourlyControlProof } from "./market-history-price-controls.ts";
import { promisify } from "node:util";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { collectCtaReference, ctaReferenceUrl, CTA_REFERENCE_SYMBOLS, type CtaReference } from "./cta-reference.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions, trailingExchangeSessions, availableExchangeSessions, hasReviewedCalendar, hasReviewedCalendarRange, isUnresolvedExchangeDate } from "./exchange-calendar.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
import { confirmedHoldingPeriods } from "./holding-periods.ts";
import { firstRateControlSeries, firstRateHoldingSource, priorFirstRateHoldingSources, readFirstRateHoldingSource,
  type FirstRateHoldingSource } from "./firstrate-holding-periods.ts";
import { digest } from "./history.ts";
import { isFullKibotSession } from "./kibot.ts";
import { ETF_SYMBOLS } from "./marketparquet.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { collectResearchPrices, readResearchReceipt } from "./research-price-capture.ts";
import { SourceMissingError, SourceTransportError } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";
import { FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS, technicalSignals } from "./firstrate-technicals.ts";
import { firstRatePremarketSignal, type PremarketSample } from "./firstrate-premarket.ts";
import { NASDAQ_WEBSITE_PRICE_PERMISSION } from "./nasdaq-website-access.ts";
import { readQqqAuction, validQqqAuction, type QqqAuction } from "./firstrate-nasdaq-auction.ts";

export { FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS, replaceTechnicalSignals } from "./firstrate-technicals.ts";
export { replaceFirstRatePremarket } from "./firstrate-premarket.ts";
const FIRST_RATE_SAMPLE_HOST = "https://frd001.s3.us-east-2.amazonaws.com/";
const FIRST_EDITION_DAY = "2026-11-03";
const BASIS_POINTS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;
type Symbol = (typeof FIRST_RATE_SYMBOLS)[number];
type Bar = Pick<SessionPrice, "session" | "open" | "close">;
type CoreBar = Bar & { minutes: number };
type PriceSource = { symbol: Symbol; url: string; sha256: string; basis: "split-adjusted";
  capturedAt: string; modifiedAt: string; rows: Bar[] };
type Sample = PriceSource & { regularMinutes: CoreBar[] };
type Issuer = { symbol: typeof ETF_SYMBOLS[number]; source: string; sha256: string;
  capturedAt: string; cash: CashDistribution[] };
type SampleFailure = { symbol: Symbol; reason: string; kind?: "unavailable" | "integrity" | "disagreement" };
type ListingProof = { session: string; source: string; sha256: string };
type MinuteRepair = {
  session: string; captureSession: string; source: Omit<PriceSource, "rows">;
  rawSha256: string; splitSha256: string; minutes?: number;
} & ({ listing: ListingProof; auction?: never } | { listing?: never; auction: QqqAuction; daily: Bar });
type ApprovedSymbol = {
  symbol: Symbol;
  reviewedThrough?: string;
  earlierComparisons?: FirstRateHoldingSource[];
  rows: SessionPrice[];
  withheld: { session: string; reason: "short-session" | "price" | "direction" }[];
  proof: { source: Omit<PriceSource, "rows">; comparison: string[]; splitComparison: string[];
    listingReferences: ListingProof[]; subscriber?: { from: string; through: string; sha256: string }; marketHistory?: HourlyControlProof; actions?: MarketHistoryActionProof; minuteRepairs?: MinuteRepair[] };
};
type ReviewedSymbol = ApprovedSymbol & { reviewedThrough: string };
type Approval = {
  schemaVersion: 1;
  source: typeof FIRST_RATE_SOURCE;
  from: string;
  through: string;
  approvedAt: string;
  issuers: Issuer[];
  symbols: ApprovedSymbol[];
};
type StoredApproval = { approval: Approval; sha256: string };

const directoryName = ".consensus/private-firstrate";
const sourceURL = (symbol: Symbol) => `${FIRST_RATE_SAMPLE_HOST}frd_sample_etf_${symbol}.zip`;

export function latestFirstRateSession(now: string): string {
  const observed = Date.parse(now);
  let day = newYorkDate(now);
  while (day >= EXCHANGE_CALENDAR.from) {
    const session = exchangeSession(day);
    if (session && Date.parse(session.closeAt) <= observed) return day;
    day = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
  }
  throw new Error("No reviewed completed session for FirstRate");
}

export function firstRateCaptureDates(now: string, approvedThrough: string[]) {
  const latest = latestFirstRateSession(now);
  if (latest <= FIRST_EDITION_DAY) return [latest];
  // A new host starts with the latest completed ZIP on the morning run.
  if (latest !== newYorkDate(now) && !approvedThrough.some(Boolean)) return [latest];
  // The independent feed can deliver the previous close while the newest close is still unavailable.
  const lookback = new Date(Date.parse(latest) - 7 * 86_400_000).toISOString().slice(0, 10);
  const prior = trailingExchangeSessions(lookback, latest).at(-2);
  return prior && approvedThrough.some(through => through < prior) ? [prior, latest] : [latest];
}

type CatchUp = { session: string; funds: Symbol[]; retained: Symbol[] };

async function captureEntries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Choose at most one older original per fund before opening any comparison prices. */
async function pendingFirstRateCaptures(root: string, latest: string, approvedThrough: string[], prior?: string) {
  const earliest = new Map<Symbol, string>();
  const next = new Map<Symbol, string>();
  const folder = resolve(root, directoryName, "captures");
  const oldestApproval = approvedThrough.map(day => day || FIRST_EDITION_DAY).sort()[0] ?? latest;
  if (oldestApproval >= latest) return { reviews: [], next };
  const calendar = new Set(availableExchangeSessions(oldestApproval, latest));
  const dates = (await captureEntries(folder)).filter(entry => entry.name < latest && calendar.has(entry.name)).map(entry => {
    if (!entry.isDirectory()) throw new Error("A dated FirstRate capture must be a real directory");
    return entry.name;
  }).sort();
  for (const day of dates) {
    const waiting = FIRST_RATE_SYMBOLS.filter((fund, i) => !next.has(fund) && approvedThrough[i] < day);
    if (!waiting.length) continue;
    const files = new Set((await captureEntries(resolve(folder, day))).map(file => file.name));
    // Either half makes this an existing original. Missing or damaged counterparts must fail native replay.
    for (const fund of waiting) {
      if (!files.has("sample-" + fund + ".bin") && !files.has("sample-" + fund + ".json")) continue;
      (earliest.has(fund) ? next : earliest).set(fund, day);
    }
  }
  const grouped = new Map<string, CatchUp>();
  for (const [i, fund] of FIRST_RATE_SYMBOLS.entries()) {
    const saved = earliest.get(fund);
    const day = saved ?? prior;
    if (!day || approvedThrough[i] >= day) continue;
    const group = grouped.get(day) ?? { session: day, funds: [], retained: [] };
    group.funds.push(fund);
    if (saved) group.retained.push(fund);
    grouped.set(day, group);
  }
  return { reviews: [...grouped.values()].sort((a, b) => a.session.localeCompare(b.session)), next };
}

function fullSession(day: string) {
  const session = exchangeSession(day);
  return session !== null && isFullKibotSession(session.openAt, session.closeAt);
}

function sessionMinutes(clock: Pick<SessionPrice, "openAt" | "closeAt">) {
  return (Date.parse(clock.closeAt) - Date.parse(clock.openAt)) / 60_000;
}

function withinBasisPoints(value: number, reference: number, limit: number) {
  return Number.isFinite(value) && value > 0 && Number.isFinite(reference) && reference > 0 &&
    Math.abs(value / reference - 1) * BASIS_POINTS <= limit;
}

function withinPriceLimits(row: Bar, reference: Bar) {
  return withinBasisPoints(row.open, reference.open, 3) && withinBasisPoints(row.close, reference.close, 15);
}

export function verifiedCorePair(pair: CoreBar | undefined, expected: Bar, listed: Bar | undefined, minutes: number) {
  return pair !== undefined && listed !== undefined && pair.minutes === minutes &&
    pair.session === expected.session && listed.session === expected.session &&
    pair.open === expected.open && pair.close === expected.close && withinPriceLimits(pair, listed) &&
    Math.sign(pair.close - pair.open) === Math.sign(listed.close - listed.open);
}

function qqqContinuousPair(daily: Bar, pair: CoreBar | undefined, expected: Bar) {
  return pair !== undefined && pair.minutes === 390 && pair.session === daily.session &&
    pair.session === expected.session && pair.open === expected.open && pair.close === expected.close &&
    withinPriceLimits(pair, expected) && withinBasisPoints(daily.open, expected.open, 3) &&
    Math.sign(daily.close - daily.open) === Math.sign(pair.close - pair.open);
}

/** Use independent references to qualify regular-session prices and clocked minute pairs. */
export function reconcileFirstRateRows(
  symbol: Symbol, candidate: Bar[], raw: SessionPrice[], splitOnly: SessionPrice[], listing: Bar[] = [], regularMinutes: CoreBar[] = [],
  auctions: QqqAuction[] = [],
) {
  if (candidate.length !== raw.length || candidate.length !== splitOnly.length)
    throw new Error(`${symbol} FirstRate comparison has missing sessions`);
  const withheld: ApprovedSymbol["withheld"] = [];
  const regularMinuteSessions: string[] = [];
  const rows = candidate.flatMap((row, i) => {
    const expected = raw[i], split = splitOnly[i];
    const clock = exchangeSession(row.session);
    if (!clock || row.session !== expected.session || row.session !== split.session)
      throw new Error(`${symbol} FirstRate comparison has different session dates`);
    if (expected.open !== split.open || expected.close !== split.close)
      throw new Error(`${symbol} has a split-basis difference on ${row.session}`);
    const listed = listing.find(mark => mark.session === row.session);
    const listedMatch = listed?.open === row.open && listed.close === row.close;
    const duration = sessionMinutes(clock);
    const minutes = regularMinutes.find(bar => bar.session === row.session);
    const priceChecked = withinPriceLimits(row, expected);
    const directionDisagrees = Math.sign(row.close - row.open) !== Math.sign(expected.close - expected.open) && !listedMatch;
    let reason: ApprovedSymbol["withheld"][number]["reason"] | undefined;
    const auction = auctions.find(proof => proof.session === row.session);
    if (symbol === "QQQ" && duration === 390 && !priceChecked && minutes && qqqContinuousPair(row, minutes, expected) &&
        auction && auction.officialClose === row.close && validQqqAuction(auction)) {
      regularMinuteSessions.push(row.session);
      return [{ ...clock, open: minutes.open, close: minutes.close }];
    }
    if (duration === 210 || (duration === 390 && directionDisagrees && priceChecked)) {
      if (minutes && verifiedCorePair(minutes, expected, listed, duration)) {
        regularMinuteSessions.push(row.session);
        return [{ ...clock, open: minutes.open, close: minutes.close }];
      }
    }
    if (duration !== 390) reason = "short-session";
    else if (!priceChecked) reason = "price";
    else if (directionDisagrees) reason = "direction";
    if (reason) {
      withheld.push({ session: row.session, reason });
      return [];
    }
    return [{ ...clock, open: row.open, close: row.close }];
  });
  return { rows, withheld, regularMinuteSessions };
}

function validMinuteWitness(repair: MinuteRepair, symbol: Symbol, row: SessionPrice, asOf: string) {
  if (repair.auction) return symbol === "QQQ" && repair.minutes === 390 && repair.auction.session === row.session &&
    repair.source.basis === "split-adjusted" && exchangeSession(repair.captureSession)!.closeAt <= repair.source.modifiedAt &&
    repair.source.modifiedAt <= repair.source.capturedAt && repair.source.capturedAt <= asOf &&
    validQqqAuction(repair.auction, asOf) && repair.auction.officialClose === repair.daily.close &&
    !withinPriceLimits(repair.daily, row) && qqqContinuousPair(repair.daily, { ...row, minutes: 390 }, row);
  return CTA_REFERENCE_SYMBOLS.some(covered => covered === symbol) && repair.listing?.session === repair.session &&
    repair.listing.source === ctaReferenceUrl(repair.session) && SHA256.test(repair.listing.sha256);
}

async function listingReferences(directory: string, symbol: Symbol, dates: string[]) {
  if (!CTA_REFERENCE_SYMBOLS.some(covered => covered === symbol)) return [];
  const references = [];
  for (const session of dates) {
    const record = await readResearchReceipt<CtaReference>(resolve(directory, `cta-${session}.json`));
    if (!record) continue;
    const mark = record.rows.find(row => row.symbol === symbol && row.session === session);
    const clock = exchangeSession(session)!;
    const url = ctaReferenceUrl(session);
    if (!mark || record.scope !== "private-price-reconciliation" || record.source !== url ||
        record.basis !== "as-traded-primary-listing-participant-eod-summary" || !SHA256.test(record.sha256) ||
        mark.openAt !== clock.openAt || mark.closeAt !== clock.closeAt ||
        !Number.isFinite(Date.parse(mark.summaryAt)) || Date.parse(mark.summaryAt) < Date.parse(clock.closeAt) + 240 * 60_000)
      throw new Error(`Unverified exact listing reference for ${symbol} ${session}`);
    references.push({ mark, session, source: url, sha256: record.sha256 });
  }
  return references;
}

async function captureShortListing(directory: string, samples: Sample[]) {
  const day = samples.filter(sample => CTA_REFERENCE_SYMBOLS.some(symbol => symbol === sample.symbol))
    .flatMap(sample => sample.regularMinutes.filter(row => row.minutes === 210).map(row => row.session)).sort().at(-1);
  if (!day) return;
  const destination = resolve(directory, `cta-${day}.json`);
  if (await readResearchReceipt<CtaReference>(destination)) return;
  try {
    const { reference } = await collectCtaReference(day);
    await durableJSON(destination, reference, true);
  } catch (error) {
    return { session: day, reason: error instanceof Error ? error.message.slice(0, 240) : "Short-session listing reference unavailable" };
  }
}

function verifyIssuers(issuers: Issuer[], through: string, now: string) {
  const close = exchangeSession(through)!.closeAt;
  if (issuers.length !== ETF_SYMBOLS.length || new Set(issuers.map(row => row.symbol)).size !== ETF_SYMBOLS.length ||
      ETF_SYMBOLS.some(symbol => !issuers.some(row => row.symbol === symbol)) || issuers.some(row =>
        !SHA256.test(row.sha256) || !row.source.startsWith("https://") ||
        !Number.isFinite(Date.parse(row.capturedAt)) || row.capturedAt <= close || row.capturedAt > now ||
        !Array.isArray(row.cash) || new Set(row.cash.map(action => action.session)).size !== row.cash.length ||
        row.cash.some(action => !Number.isFinite(action.amount) || action.amount <= 0 ||
          (action.session >= FIRST_EDITION_DAY && action.session <= through && !isUnresolvedExchangeDate(action.session) && !exchangeSession(action.session)))))
    throw new Error("All five official issuer histories must be captured after the final reviewed close");
}

function firstRateApprovalCalendar(approval: Approval) {
  if (!hasReviewedCalendar(approval.from) || !hasReviewedCalendar(approval.through))
    throw new Error("FirstRate approval dates are outside the reviewed exchange calendar");
  const dates = availableExchangeSessions(approval.from, approval.through);
  const ordered = FIRST_RATE_SYMBOLS.filter(symbol => approval.symbols.some(row => row.symbol === symbol));
  if (approval.from < FIRST_EDITION_DAY || approval.source !== FIRST_RATE_SOURCE ||
      !approval.symbols.length || ordered.length !== approval.symbols.length ||
      ordered.some((symbol, index) => symbol !== approval.symbols[index].symbol))
    throw new Error("FirstRate approval has an invalid source or instrument list");
  verifyIssuers(approval.issuers, approval.through, approval.approvedAt);
  return dates;
}

function firstRateFundPrices(approval: Approval, dates: string[], { symbol, rows, proof, reviewedThrough = approval.through }: ApprovedSymbol): PriceEvidence {
  const byDate = new Map(rows.map(row => [row.session, row]));
  const repairs = proof.minuteRepairs ?? [];
  const early = new Set(repairs.filter(repair => repair.minutes === 210).map(repair => repair.session));
  if (!dates.includes(reviewedThrough) || byDate.size !== rows.length ||
      rows.some(row => row.session < approval.from || row.session > reviewedThrough ||
      (!fullSession(row.session) && (!early.has(row.session) || sessionMinutes(row) !== 210 ||
        !CTA_REFERENCE_SYMBOLS.some(covered => covered === symbol))) || row.openAt !== exchangeSession(row.session)!.openAt ||
      row.closeAt !== exchangeSession(row.session)!.closeAt))
    throw new Error(`FirstRate approval has invalid sessions for ${symbol}`);
  if (new Set(repairs.map(repair => repair.session)).size !== repairs.length || repairs.some(repair =>
    !byDate.has(repair.session) || repair.captureSession < repair.session || repair.captureSession > reviewedThrough ||
    repair.source.symbol !== symbol || repair.source.url !== sourceURL(symbol) ||
    !validMinuteWitness(repair, symbol, byDate.get(repair.session)!, approval.approvedAt) ||
    (repair.minutes !== undefined && repair.minutes !== sessionMinutes(byDate.get(repair.session)!)) ||
    ![repair.source.sha256, repair.rawSha256, repair.splitSha256].every(hash => SHA256.test(hash))))
    throw new Error(`FirstRate ${symbol} minute repair lacks its pinned independent evidence`);
  const blocks: SessionPrice[][] = [];
  let block: SessionPrice[] = [];
  for (const day of dates) {
    const row = byDate.get(day);
    if (!row) block = [];
    else {
      const previous = block.at(-1);
      if (previous && !hasReviewedCalendarRange(previous.session, day)) block = [];
      if (!block.length) blocks.push(block);
      block.push(row);
    }
  }
  const cash = approval.issuers.find(issuer => issuer.symbol === symbol)!.cash;
  const sessions = blocks.flatMap(block => adjustETFPrices(block,
    cash.filter(action => action.session >= block[0].session && action.session <= block.at(-1)!.session), []));
  return { instrument: symbol, source: FIRST_RATE_SOURCE, adjustment: OUTCOME_PRICE_BASIS, expectedSessions: dates, sessions };
}

export function firstRatePriceEvidence(approval: Approval): PriceEvidence[] {
  const dates = firstRateApprovalCalendar(approval);
  return approval.symbols.map(fund => firstRateFundPrices(approval, dates, fund));
}

async function readApproval(root: string, holdingControls?: Map<Symbol, ReturnType<typeof firstRateControlSeries>>, cutoff?: string,
  warn?: (message: string) => void) {
  const directory = resolve(root, directoryName);
  if (cutoff !== undefined && (!Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff))
    throw new Error("Invalid FirstRate approval cutoff");
  let stored = await readResearchReceipt<StoredApproval>(resolve(directory, "approved.json"));
  if (stored && (stored.approval.schemaVersion !== 1 || stored.sha256 !== digest(stored.approval)))
    throw new Error("FirstRate approved prices differ from their private receipt");
  if (cutoff && stored && stored.approval.approvedAt > cutoff) {
    stored = null;
    for (const file of await captureEntries(resolve(directory, "approvals"))) {
      if (!file.isFile() || !/^\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{64})?\.json$/.test(file.name)) continue;
      const entry = await readResearchReceipt<StoredApproval>(resolve(directory, "approvals", file.name));
      if (!entry || entry.approval.schemaVersion !== 1 || entry.sha256 !== digest(entry.approval) ||
          (file.name !== entry.approval.through + ".json" &&
           file.name !== entry.approval.through + "-" + digest({ ...entry.approval, approvedAt: null }) + ".json"))
        throw new Error("FirstRate archived approval differs from its receipt");
      if (entry.approval.approvedAt <= cutoff && (!stored || stored.approval.approvedAt < entry.approval.approvedAt)) stored = entry;
    }
  }
  if (!stored) return null;
  const approval = stored.approval;
  if (holdingControls) firstRateApprovalCalendar(approval);
  async function verifyFund(fund: ApprovedSymbol) {
    const asOf = approval.approvedAt;
    const current = firstRateHoldingSource(fund.proof, asOf);
    const cash = approval.issuers.find(row => row.symbol === fund.symbol)?.cash ?? [];
    const rows = current && await readFirstRateHoldingSource(root, fund.symbol, current, asOf, cash);
    if (holdingControls) {
      const ranges = current && rows ? [{ provider: current.provider, rows }] : [];
      const unavailable = new Set<string>();
      for (const previous of fund.earlierComparisons ?? []) {
        try { ranges.push({ provider: previous.provider, rows: await readFirstRateHoldingSource(root, fund.symbol, previous, asOf, cash) }); }
        catch {
          (warn ?? console.warn)(`Earlier FirstRate holding-period control is unavailable for ${fund.symbol}, ${previous.from} through ${previous.through}.`);
          for (const row of fund.rows)
            if (previous.from <= row.session && row.session <= previous.through) unavailable.add(row.session);
        }
      }
      const series = firstRateControlSeries(ranges);
      const primary = new Map(fund.rows.map(row => [row.session, row]));
      for (const range of ranges) for (const reference of range.rows) {
        const row = primary.get(reference.session);
        if (row && (!withinPriceLimits(row, reference) || Math.sign(row.close - row.open) !== Math.sign(reference.close - reference.open)))
          series.disputed.add(reference.session);
      }
      for (const day of unavailable) series.disputed.add(day);
      holdingControls.set(fund.symbol, series);
    }
    for (const repair of fund.proof.minuteRepairs ?? []) {
      if (repair.auction && digest(await readQqqAuction(directory, repair.session, true)) !== digest(repair.auction))
        throw new Error("FirstRate QQQ approval differs from its archived Nasdaq auction");
    }
  }
  const verified: ApprovedSymbol[] = [];
  for (const fund of approval.symbols ?? []) {
    try { await verifyFund(fund); verified.push(fund); }
    catch (error) {
      if (!warn) throw error;
      warn(`FirstRate ${fund.symbol} withheld because its current independent price or auction receipt did not verify.`);
    }
  }
  return warn && approval.symbols && verified.length !== approval.symbols.length ? { ...approval, symbols: verified } : approval;
}

export async function loadFirstRatePrices(root: string, cutoff = new Date().toISOString(), warn?: (message: string) => void) {
  const controls = new Map<Symbol, ReturnType<typeof firstRateControlSeries>>();
  const approval = await readApproval(root, controls, cutoff, warn);
  if (!approval?.symbols?.length) return [];
  const dates = availableExchangeSessions(approval.from, approval.through);
  return approval.symbols.flatMap(fund => {
    try {
      const prices = firstRateFundPrices(approval, dates, fund), reference = controls.get(fund.symbol)!;
      const cash = approval.issuers.find(issuer => issuer.symbol === fund.symbol)!.cash;
      const rows = fund.rows.filter(row => !reference.disputed.has(row.session));
      return [{ ...prices, confirmedHoldingPeriods: confirmedHoldingPeriods(dates, rows, reference.references, cash, prices.sessions) }];
    } catch (error) {
      if (!warn) throw error;
      warn(`FirstRate ${fund.symbol} withheld because its regular-session prices or corporate adjustments did not verify.`);
      return [];
    }
  });
}

export async function loadReviewedTltCash(root: string, cutoff: string) {
  const approval = await readApproval(root);
  if (!approval || approval.approvedAt > cutoff) return null;
  verifyIssuers(approval.issuers, approval.through, approval.approvedAt);
  const issuer = approval.issuers.find(row => row.symbol === "TLT")!;
  if (issuer.source !== "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd")
    throw new Error("Unrecognized TLT issuer distribution history");
  return { through: approval.through, issuer };
}

export function firstRateTechnicalSignals(approval: Approval, cutoff: string) {
  if (approval.approvedAt > cutoff) return [];
  const evidence = firstRatePriceEvidence(approval);
  return technicalSignals(approval.symbols.map(({ symbol, proof, reviewedThrough }, i) => {
    const { source } = proof;
    const issuer = approval.issuers.find(row => row.symbol === symbol)!;
    if (source.symbol !== symbol || source.url !== sourceURL(symbol) || source.basis !== "split-adjusted" ||
        !SHA256.test(source.sha256) || !Number.isFinite(Date.parse(source.capturedAt)) ||
        new Date(source.capturedAt).toISOString() !== source.capturedAt || source.capturedAt > approval.approvedAt ||
        source.capturedAt < source.modifiedAt)
      throw new Error(`Invalid ${symbol} technical input receipt`);
    return { symbol, sessions: evidence[i].sessions, expectedSessions: evidence[i].expectedSessions,
      reviewedThrough: reviewedThrough ?? approval.through, vintageAt: source.modifiedAt,
      retrievedAt: [source.capturedAt, issuer.capturedAt].sort().at(-1)!,
      sha256: digest({ symbol, source: source.sha256, issuer: issuer.sha256, proof, adjusted: evidence[i].sessions }) };
  }), cutoff);
}

export async function loadFirstRateTechnicals(root: string, cutoff: string) {
  const approval = await readApproval(root);
  return approval ? firstRateTechnicalSignals(approval, cutoff) : [];
}

const premarketPolicy = "firstrate-premarket-minute-to-five-v1";
type CapturedPremarket = PremarketSample & { url: string; verifiedBuckets?: number };
type PremarketReview = { policy: typeof premarketPolicy; symbol: Symbol; session: string; approvedAt: string; sampleDigest: string };
type StoredPremarketReview = { review: PremarketReview; sha256: string };
const premarketDirectory = (root: string, day: string) => resolve(root, directoryName, "premarket-reviewed", day);

async function capturedPremarket(root: string, symbol: Symbol, day: string, compareGrids: boolean) {
  const clock = exchangeSession(day);
  if (!clock) throw new Error("Expected an exchange session for the premarket archive");
  const { stdout } = await promisify(execFile)("python3", ["-B", resolve(root, "scripts/collect-firstrate-inputs.py"),
    day, "--cached-premarket", symbol, "--expected-close", clock.closeAt.replace(/Z$/, "+00:00"),
    ...(compareGrids ? ["--compare-premarket-grids"] : [])], { timeout: 15_000, maxBuffer: 4096 });
  const sample: CapturedPremarket = JSON.parse(stdout);
  if (sample.symbol !== symbol || sample.session !== day || sample.url !== sourceURL(symbol) ||
      (compareGrids && !(Number.isInteger(sample.verifiedBuckets) && sample.verifiedBuckets! >= 2 && sample.verifiedBuckets! <= 66)))
    throw new Error("Premarket sample differs from the requested source or window");
  return sample;
}

function replayPremarket(stored: StoredPremarketReview, sample: CapturedPremarket, cutoff: string) {
  const { review } = stored;
  if (stored.sha256 !== digest(review) || review.policy !== premarketPolicy || review.symbol !== sample.symbol ||
      review.session !== sample.session || review.sampleDigest !== digest(sample))
    throw new Error("Premarket archive differs from its minute and five-minute review");
  return firstRatePremarketSignal(sample, review.approvedAt, cutoff);
}

/** Qualify only a prior premarket window. The daily open, close, dividends and settlement have separate approvals. */
export async function prepareFirstRatePremarket(root: string, now = () => new Date().toISOString()) {
  const session = latestFirstRateSession(now());
  const directory = premarketDirectory(root, session);
  const funds = await Promise.all(FIRST_RATE_SYMBOLS.map(async symbol => {
    try {
      const path = resolve(directory, symbol + ".json");
      const sample = await capturedPremarket(root, symbol, session, true);
      const existing = await readResearchReceipt<StoredPremarketReview>(path);
      if (existing) {
        const signal = replayPremarket(existing, sample, now());
        return { symbol, status: signal.status, verifiedBuckets: sample.verifiedBuckets, approvedAt: existing.review.approvedAt };
      }
      const approvedAt = now();
      const review: PremarketReview = { policy: premarketPolicy, symbol, session, approvedAt, sampleDigest: digest(sample) };
      const stored = { review, sha256: digest(review) };
      const signal = replayPremarket(stored, sample, approvedAt);
      if (signal.status !== "available") return { symbol, status: "expired" };
      await durableDirectory(directory, 0o700);
      await durableJSON(path, stored, true);
      return { symbol, status: signal.status, verifiedBuckets: sample.verifiedBuckets, approvedAt };
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      const reason = stderr?.trim().split("\n").at(-1) || (error instanceof Error ? error.message : "Premarket check failed");
      return { symbol, status: "unavailable", reason: reason.slice(0, 200) };
    }
  }));
  return { session, funds };
}

/** Replay the independently reviewed tape or an archive pinned by an earlier per-symbol approval. */
export async function loadFirstRatePremarket(root: string, cutoff: string) {
  const latest = latestFirstRateSession(cutoff);
  let legacy: ReturnType<typeof readApproval> | undefined;
  const observations = await Promise.all(FIRST_RATE_SYMBOLS.map(async symbol => {
    try {
      const sealed = await readResearchReceipt<StoredPremarketReview>(resolve(premarketDirectory(root, latest), symbol + ".json"));
      if (sealed && sealed.review.approvedAt <= cutoff)
        return [replayPremarket(sealed, await capturedPremarket(root, symbol, latest, true), cutoff)];
      const approval = await (legacy ??= readApproval(root));
      if (!approval || approval.source !== FIRST_RATE_SOURCE || approval.approvedAt > cutoff) return [];
      const matches = approval.symbols.filter(row => row.symbol === symbol);
      if (matches.length !== 1) return [];
      const [entry] = matches, { source } = entry.proof;
      const day = entry.reviewedThrough ?? approval.through;
      const clock = exchangeSession(day);
      // Approval pins the archive. Its regular-session settlement is independent of the premarket boundary prices.
      if (!clock || day < approval.from || day > approval.through || source.symbol !== symbol || source.url !== sourceURL(symbol) ||
          source.basis !== "split-adjusted" || !SHA256.test(source.sha256) ||
          ![entry.proof.comparison, entry.proof.splitComparison].every(refs => refs.length && refs.every(hash => SHA256.test(hash)))) return [];
      const sample = await capturedPremarket(root, symbol, day, false);
      if (sample.symbol !== symbol || sample.session !== day || sample.url !== source.url || sample.sha256 !== source.sha256 ||
          sample.retrievedAt !== source.capturedAt || sample.vintageAt !== source.modifiedAt) return [];
      return [firstRatePremarketSignal(sample, approval.approvedAt, cutoff)];
    } catch {
      // One unavailable instrument must not suppress verified bars from another ETF.
      return [];
    }
  }));
  return observations.flat();
}

async function reviewSample(directory: string, sample: Sample, through: string, from: string,
  cachedOnly: boolean, observed: string, old: ApprovedSymbol | undefined, issuerCash: CashDistribution[],
  failures: SampleFailure[], previouslyApprovedAt?: string): Promise<ReviewedSymbol> {
  const { rows: delivered, regularMinutes, ...source } = sample;
  const { symbol } = source;
  const dates = trailingExchangeSessions(delivered[0].session, through);
  // The original ZIP can include an unresolved market day. Reconcile only the
  // independently dated suffix, retaining the digest of the complete delivery.
  const rows = delivered.filter(bar => bar.session >= dates[0]);
  const closingAt = exchangeSession(through)!.closeAt;
  if (!dates.length || delivered.some((bar, i) => i > 0 && bar.session <= delivered[i - 1].session) ||
      dates.join() !== rows.map(row => row.session).join() || source.url !== sourceURL(symbol) ||
      source.basis !== "split-adjusted" || !SHA256.test(source.sha256) ||
      !(closingAt <= source.modifiedAt && source.modifiedAt <= source.capturedAt && source.capturedAt <= observed))
    throw new Error(`FirstRate ${symbol} sample is stale or differs from the reviewed calendar or source`);

  const root = resolve(directory, "../..");
  let comparisons;
  try {
    comparisons = await collectMarketHistoryPriceControls(root, symbol, dates, cachedOnly);
  } catch (error) {
    if (!(error instanceof ComparisonUnavailable || error instanceof SourceMissingError || error instanceof SourceTransportError)) throw error;
    // The paid namespace verifies an active subscriber and never imports guest comparisons.
    const comparison = { reviewedExchangeCalendar: true, cachedOnly, productionRoot: root };
    try {
      const raw = await collectResearchPrices(directory, symbol, dates, comparison);
      const splits = await collectResearchPrices(directory, symbol, dates, { ...comparison, splitAdjusted: true });
      comparisons = { raw, splits, proof: undefined };
    } catch (paidError) {
      if (!unavailableComparison(paidError)) throw paidError;
      throw new ComparisonUnavailable(error.message + ". " + paidError.message);
    }
  }
  const { raw, splits } = comparisons;
  const actions = comparisons.proof
    ? await firstRateIssuerActionProof(root, symbol, dates[0], through, issuerCash, cachedOnly)
    : undefined;
  const asTraded = raw.flatMap(row => row.sessions), splitOnly = splits.flatMap(row => row.sessions);
  const repairs = new Map(old?.proof.minuteRepairs?.map(repair => [repair.session, repair]));
  const priorRows = new Map(old?.rows.map(row => [row.session, row]));
  const candidates = rows.map(row => repairs.has(row.session) ? priorRows.get(row.session)! : row);
  const shortReplays = candidates.flatMap(row => repairs.get(row.session)?.minutes === 210 ? [{ ...row, minutes: 210 }] : []);
  const minutesToReview = [...shortReplays, ...regularMinutes.filter(row => row.session >= dates[0] && !repairs.has(row.session))];
  const check = reconcileFirstRateRows(symbol, candidates, asTraded, splitOnly);
  const listing = await listingReferences(directory, symbol,
    check.withheld.filter(row => row.reason === "direction" || (row.reason === "short-session" &&
      minutesToReview.some(bar => bar.session === row.session && bar.minutes === 210))).map(row => row.session));
  const auctions: QqqAuction[] = [];
  if (symbol === "QQQ") for (const { session, reason } of check.withheld) {
    const i = candidates.findIndex(row => row.session === session);
    if (reason !== "price" || !fullSession(session) ||
        !qqqContinuousPair(candidates[i], minutesToReview.find(row => row.session === session), asTraded[i])) continue;
    // A website receipt can reproduce a sealed repair, but does not license a new one.
    const previous = repairs.get(session)?.auction;
    if (!previous) {
      failures.push({ symbol, kind: "unavailable", reason: session + " " + NASDAQ_WEBSITE_PRICE_PERMISSION });
      continue;
    }
    try {
      const auction = await readQqqAuction(directory, session, true);
      if (!auction || digest(auction) !== digest(previous)) throw new Error("Sealed QQQ auction changed");
      auctions.push(auction);
    } catch (error) {
      failures.push({ symbol, reason: session + " auction verification: " + (error instanceof Error ? error.message.slice(0, 180) : "unavailable") });
    }
  }
  const normalized = listing.length || auctions.length
    ? reconcileFirstRateRows(symbol, candidates, asTraded, splitOnly, listing.map(row => row.mark), minutesToReview, auctions)
    : check;
  const merged = new Map(priorRows);
  const priorLast = old?.rows.at(-1)?.session;
  const incomingFirst = normalized.rows[0]?.session;
  if (priorLast && incomingFirst && incomingFirst > priorLast &&
      hasReviewedCalendarRange(priorLast, incomingFirst) && exchangeSessions(priorLast, incomingFirst).length === 2)
    throw new Error(`${symbol} needs an overlapping raw share-basis check before joining these adjacent sessions`);
  for (const issue of normalized.withheld) {
    if (merged.has(issue.session))
      throw new Error(`Previously approved ${symbol} session no longer reconciles on ${issue.session}`);
  }
  for (const row of normalized.rows.filter(row => row.session >= from)) {
    const prior = merged.get(row.session);
    if (prior && (row.open !== prior.open || row.close !== prior.close))
      throw new Error(`Previously approved ${symbol} prices changed for ${row.session}`);
    merged.set(row.session, row);
  }
  if (!merged.size) throw new Error(`${symbol} has no independently verified price sessions`);
  const references = listing.map(({ session, source, sha256 }) => ({ session, source, sha256 }));
  for (const session of normalized.regularMinuteSessions) {
    if (repairs.has(session)) continue;
    const rawReference = raw.find(receipt => receipt.from <= session && receipt.through >= session)!;
    const splitReference = splits.find(receipt => receipt.from <= session && receipt.through >= session)!;
    const auction = auctions.find(proof => proof.session === session);
    repairs.set(session, { session, captureSession: through, source, minutes: minutesToReview.find(bar => bar.session === session)!.minutes,
      rawSha256: rawReference.sha256,
      splitSha256: splitReference.sha256, ...(auction ? { auction, daily: rows.find(bar => bar.session === session)! } :
        { listing: references.find(reference => reference.session === session)! }) });
  }
  const previousDisagreements = (old?.withheld ?? []).filter(issue => issue.session < dates[0]);
  const proof = { source, comparison: raw.map(row => row.sha256), splitComparison: splits.map(row => row.sha256),
      listingReferences: references, ...(comparisons.proof ? { marketHistory: comparisons.proof, actions } :
        { subscriber: { from: dates[0], through, sha256: digest({ raw, splits }) } }),
      ...(repairs.size ? { minuteRepairs: [...repairs.values()] } : {}) };
  const previous = old && previouslyApprovedAt && firstRateHoldingSource(old.proof, previouslyApprovedAt);
  const earlierComparisons = priorFirstRateHoldingSources([...(old?.earlierComparisons ?? []), ...(previous ? [previous] : [])],
    firstRateHoldingSource(proof, observed)!);
  return { symbol, reviewedThrough: through, rows: [...merged.values()].sort((a, b) => a.session.localeCompare(b.session)),
    withheld: [...previousDisagreements, ...normalized.withheld], proof, ...(earlierComparisons.length ? { earlierComparisons } : {}) };
}

function approvedCounts(approval: Approval) {
  return firstRatePriceEvidence(approval).map(({ instrument, sessions }) => ({ instrument, sessions: sessions.length }));
}

function unavailableComparison(error: unknown): error is Error {
  return error instanceof ComparisonUnavailable || error instanceof SourceMissingError || error instanceof SourceTransportError;
}

class UnsettledFirstRateSample extends Error {
  readonly failures: SampleFailure[];
  readonly captured: Symbol[];
  constructor(message: string, failures: SampleFailure[], captured: Symbol[]) {
    super(message);
    this.failures = failures;
    this.captured = captured;
  }
}
class NoVerifiedSample extends UnsettledFirstRateSample {}
class RejectedFirstRateSample extends UnsettledFirstRateSample {}

function unresolvedSample(through: string, failures: SampleFailure[], captured: Symbol[]) {
  const details = failures.map(row => row.reason).join(". ");
  if (failures.some(row => row.kind !== "unavailable"))
    return new RejectedFirstRateSample("FirstRate source integrity or price comparison failed for " + through + ". " + details, failures, captured);
  return new NoVerifiedSample("FirstRate could not verify a sample for " + through + ". " + details, failures, captured);
}

const reviewableIssue = (symbol: Symbol, reason: ApprovedSymbol["withheld"][number]["reason"]) =>
  symbol === "QQQ" ? reason === "price" : CTA_REFERENCE_SYMBOLS.some(covered => covered === symbol) && reason !== "price";

function hasReplayableDispute(approval: ApprovedSymbol) {
  const from = approval.proof.marketHistory?.from ?? approval.proof.subscriber?.from ?? FIRST_EDITION_DAY;
  return approval.withheld.some(issue => issue.session >= from && reviewableIssue(approval.symbol, issue.reason));
}

async function reviewFirstRateSession(root: string, through: string, cachedOnly: boolean, reviewWithheld: boolean,
  catchUp?: CatchUp, held: ReadonlyMap<Symbol, string> = new Map()) {
  const directory = resolve(root, directoryName);
  const previous = await readApproval(root);
  if (reviewWithheld && !previous) throw new Error("FirstRate replay needs a verified capture");
  if (through < FIRST_EDITION_DAY) return { status: "no_issued_targets", through };
  const approved = new Map(previous?.symbols.map(row =>
    [row.symbol, { ...row, reviewedThrough: row.reviewedThrough ?? previous.through }]));
  const pending = FIRST_RATE_SYMBOLS.filter(symbol => {
    if (catchUp && !catchUp.funds.includes(symbol)) return false;
    const old = approved.get(symbol);
    return reviewWithheld
      ? old?.reviewedThrough === through && hasReplayableDispute(old)
      : (old?.reviewedThrough ?? "") < through;
  });
  if (previous && !pending.length)
    return { status: "reused", through: previous.through, approved: approvedCounts(previous) };
  const pinned = cachedOnly || reviewWithheld;
  const shortArgs = trailingExchangeSessions(EXCHANGE_CALENDAR.from, through).slice(-16)
    .flatMap(day => sessionMinutes(exchangeSession(day)!) === 210 ? ["--short-session", day] : []);
  await durableDirectory(directory, 0o700);
  const { stdout } = await promisify(execFile)("python3",
    ["-B", resolve(root, "scripts/collect-firstrate-inputs.py"), through, "--independent-samples",
      "--expected-close", exchangeSession(through)!.closeAt.replace(/Z$/, "+00:00"),
      ...shortArgs,
      ...(pinned || (catchUp && catchUp.retained.length === catchUp.funds.length)
        ? ["--cached-only"] : (catchUp?.retained ?? []).flatMap(fund => ["--retained-sample", fund]))],
    { timeout: 105_000, maxBuffer: 256_000 });
  const { samples, sampleFailures, issuers } = JSON.parse(stdout) as {
    samples: Sample[]; sampleFailures: SampleFailure[]; issuers: Issuer[] };
  const inventory = [...samples, ...sampleFailures].map(row => row.symbol);
  if (inventory.length !== FIRST_RATE_SYMBOLS.length || FIRST_RATE_SYMBOLS.some(symbol => !inventory.includes(symbol)))
    throw new Error("FirstRate did not account for each documented sample");
  const observed = new Date().toISOString();
  const failures = sampleFailures.filter(row => pending.includes(row.symbol));
  const availableSamples = samples.filter(row => pending.includes(row.symbol));
  const captured = availableSamples.map(row => row.symbol);
  const heldFunds = pending.filter(fund => held.has(fund));
  if (heldFunds.length === pending.length && heldFunds.length) {
    // The Python capture still pins the newest originals for a later run.
    if (failures.some(row => row.kind !== "unavailable")) throw unresolvedSample(through, failures, captured);
    return { status: "awaiting_earlier_verification", through, failures, captured };
  }
  if (!availableSamples.length) {
    if (reviewWithheld)
      return { status: "no_verified_disputes", through, approved: approvedCounts(previous!), failures };
    throw unresolvedSample(through, failures, captured);
  }
  verifyIssuers(issuers, through, observed);
  const from = previous?.from ?? FIRST_EDITION_DAY;
  if (previous) {
    for (const symbol of ETF_SYMBOLS) {
      const old = approved.get(symbol as Symbol);
      if (!old && previous.through <= through) continue;
      // A lagging ETF may catch up using older source files after another fund has advanced.
      const end = previous.through > through ? through : old!.reviewedThrough;
      const history = (source: Issuer[]) => source.find(row => row.symbol === symbol)!.cash.filter(row =>
        row.session >= from && row.session <= end);
      if (digest(history(previous.issuers)) !== digest(history(issuers)))
        throw new Error(`Issuer history changed for previously checked ${symbol} sessions`);
    }
  }
  const listingFailure = pinned ? undefined : await captureShortListing(directory, availableSamples);
  const reviewed: Symbol[] = [];
  for (const sample of availableSamples) {
    if (held.has(sample.symbol)) continue;
    try {
      const old = approved.get(sample.symbol);
      const issuer = issuers.find(row => row.symbol === sample.symbol)!;
      const match = await reviewSample(directory, sample, through, from, pinned, observed, old, issuer.cash, failures, previous?.approvedAt);
      if (catchUp && !match.rows.some(row => row.session === through)) {
        const issue = match.withheld.find(row => row.session === through);
        if (!issue) throw new Error("The older session has neither a verified price nor a dated comparison decision");
        failures.push({symbol: sample.symbol, kind: "disagreement", reason: "Session withheld after comparison: " + issue.reason});
      }
      if (reviewWithheld && !old!.withheld.some(row => reviewableIssue(sample.symbol, row.reason) &&
          match.rows.some(bar => bar.session === row.session))) continue;
      if (listingFailure?.session === through && CTA_REFERENCE_SYMBOLS.some(symbol => symbol === sample.symbol) &&
          sample.regularMinutes.some(bar => bar.session === through && bar.minutes === 210) &&
          match.withheld.some(row => row.session === through && row.reason === "short-session")) {
        match.reviewedThrough = match.rows.at(-1)!.session;
        failures.push({ symbol: sample.symbol, reason: listingFailure.reason });
      }
      approved.set(sample.symbol, match);
      reviewed.push(sample.symbol);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code) throw error;
      failures.push({ symbol: sample.symbol, kind: unavailableComparison(error) ? "unavailable" : "integrity",
        reason: error instanceof Error ? error.message.slice(0, 240) : "Price comparison failed" });
    }
  }
  if (reviewWithheld && !reviewed.length)
    return { status: "no_verified_disputes", through, approved: approvedCounts(previous!), failures };
  if (!reviewed.length)
    throw unresolvedSample(through, failures, captured);

  const symbols = FIRST_RATE_SYMBOLS.flatMap(symbol => approved.has(symbol) ? [approved.get(symbol)!] : []);
  const preserveNewer = previous && previous.through > through;
  const approval: Approval = { schemaVersion: 1, source: FIRST_RATE_SOURCE, from,
    through: preserveNewer ? previous.through : through, approvedAt: new Date().toISOString(),
    issuers: preserveNewer ? previous.issuers : issuers, symbols };
  const counts = approvedCounts(approval);
  await saveFirstRateApproval(directory, approval);
  const completed = reviewed.filter(symbol => approved.get(symbol)!.reviewedThrough === through);
  return { status: "qualified", from, through: approval.through, reviewed, completed, approved: counts, failures, captured,
    ...(listingFailure ? { listingFailure } : {}),
    withheld: symbols.flatMap(({ symbol, withheld }) => withheld.map(row => ({ symbol, ...row }))) };
}

async function saveFirstRateApproval(directory: string, approval: Approval) {
  // Archive each accepted capture before advancing the current receipt.
  const stored = { approval, sha256: digest(approval) };
  const fingerprint = digest({ ...approval, approvedAt: null });
  const archivePath = resolve(directory, "approvals", `${approval.through}-${fingerprint}.json`);
  const replay = await readResearchReceipt<StoredApproval>(archivePath);
  if (replay && (replay.sha256 !== digest(replay.approval) ||
      digest({ ...replay.approval, approvedAt: approval.approvedAt }) !== stored.sha256))
    throw new Error("A previous capture for that FirstRate session differs");
  if (!replay) await durableJSON(archivePath, stored, true);
  await durableJSON(resolve(directory, "approved.json"), replay ?? stored);
}

/** Attach permitted independent controls to earlier accepted prices, retaining the original approval and its clock. */
export async function confirmFirstRateHoldingPeriods(root: string, cachedOnly = false) {
  const approval = await readApproval(root);
  if (!approval?.symbols.length) return { status: "no_existing_approval", confirmed: [], failures: [] };
  firstRatePriceEvidence(approval);
  const symbols: ApprovedSymbol[] = [], confirmed: Symbol[] = [], failures: { symbol: Symbol; reason: string }[] = [];
  for (const fund of approval.symbols) {
    const from = fund.rows[0]?.session, through = fund.rows.at(-1)?.session;
    if (!from || !through || fund.proof.marketHistory || fund.proof.subscriber) { symbols.push(fund); continue; }
    try {
      const cash = approval.issuers.find(issuer => issuer.symbol === fund.symbol)!.cash;
      const prior = fund.earlierComparisons?.find(source => source.from <= from && source.through >= through);
      if (prior) {
        await readFirstRateHoldingSource(root, fund.symbol, prior, approval.approvedAt, cash);
        symbols.push(fund);
        continue;
      }
      const days = exchangeSessions(from, through);
      const { raw, splits, proof } = await collectMarketHistoryPriceControls(root, fund.symbol, days, cachedOnly);
      const actions = await firstRateIssuerActionProof(root, fund.symbol, from, through, cash, cachedOnly);
      const approvedAt = new Date().toISOString();
      const source = firstRateHoldingSource({ marketHistory: proof, comparison: raw.map(r => r.sha256),
        splitComparison: splits.map(r => r.sha256), actions }, approvedAt)!;
      await readFirstRateHoldingSource(root, fund.symbol, source, approvedAt, cash);
      symbols.push({ ...fund, earlierComparisons: [...(fund.earlierComparisons ?? []), source] });
      confirmed.push(fund.symbol);
    } catch (error) {
      failures.push({ symbol: fund.symbol, reason: error instanceof Error ? error.message : "Independent source unavailable" });
      symbols.push(fund);
    }
  }
  if (confirmed.length) await saveFirstRateApproval(resolve(root, directoryName), { ...approval, approvedAt: new Date().toISOString(), symbols });
  return { status: confirmed.length ? "comparison_sources_recorded" : failures.length ? "awaiting_comparison" : "already_reviewed", confirmed, failures };
}

/** Caller holds the publication lock. Retain a verified catch-up when the newest sample or its control is late. */
export async function prepareFirstRate(root: string, cachedOnly = false, now = new Date().toISOString(), reviewWithheld = false) {
  const previous = await readApproval(root);
  if (reviewWithheld) {
    if (!previous) throw new Error("FirstRate replay needs a verified capture");
    return reviewFirstRateSession(root, previous.through, true, true);
  }
  const approvedThrough = FIRST_RATE_SYMBOLS.map(symbol => {
    const entry = previous?.symbols.find(row => row.symbol === symbol);
    return entry ? entry.reviewedThrough ?? previous!.through : "";
  });
  const dates = cachedOnly ? [latestFirstRateSession(now)] : firstRateCaptureDates(now, approvedThrough);
  const latest = dates.at(-1)!;
  let caughtUp;
  const qqq = previous?.symbols.find(row => row.symbol === "QQQ");
  if (!cachedOnly && qqq && hasReplayableDispute(qqq)) {
    // A newer ZIP can arrive late. Keep the original ZIP, issuers and comparison prices pinned
    // while collecting only the missing exchange evidence for the outstanding dispute.
    const day = qqq.reviewedThrough ?? previous!.through;
    const repair = await reviewFirstRateSession(root, day, false, true);
    if (repair.status === "qualified") caughtUp = { session: day, result: repair };
  }
  const delayedFailures: (SampleFailure & {session: string})[] = [];
  const catchUpReviews: { session: string; funds: Symbol[] }[] = [];
  const catchUps = latest > FIRST_EDITION_DAY
    ? await pendingFirstRateCaptures(root, latest, approvedThrough, dates.length > 1 ? dates[0] : undefined)
    : { reviews: [], next: new Map<Symbol, string>() };
  // A newer tape may be captured, but it cannot leap over a second outstanding original.
  const held = new Map(catchUps.next);
  for (const catchUp of catchUps.reviews) {
    let captured: Symbol[] = [], reviewed: Symbol[] = [], failures: SampleFailure[] = [];
    try {
      const earlier = await reviewFirstRateSession(root, catchUp.session, cachedOnly, false, catchUp);
      captured = earlier.captured ?? [];
      failures = earlier.failures ?? [];
      if ("completed" in earlier && earlier.completed) {
        reviewed = earlier.completed;
        caughtUp = { session: catchUp.session, result: earlier };
        catchUpReviews.push({session: catchUp.session, funds: reviewed});
      }
    } catch (error) {
      // Only per-fund records are recoverable here. Global issuer, prior approval, storage and lock failures escape.
      if (!(error instanceof UnsettledFirstRateSample)) throw error;
      captured = error.captured;
      failures = error.failures;
    }
    delayedFailures.push(...failures.map(failure => ({...failure, session: catchUp.session})));
    const protectedFunds = [...catchUp.retained, ...captured, ...failures.filter(f => f.kind !== "unavailable").map(f => f.symbol)];
    for (const fund of protectedFunds) if (!reviewed.includes(fund)) held.set(fund, catchUp.session);
  }
  const delayed = { ...(delayedFailures.length ? {delayedFailures} : {}), ...(catchUpReviews.length ? {catchUpReviews} : {}),
    ...(held.size ? {heldForEarlierCapture: Object.fromEntries(held)} : {}) };
  try {
    const result = await reviewFirstRateSession(root, latest, cachedOnly, false, undefined, held);
    return caughtUp ? { ...result, caughtUp, ...delayed } : { ...result, ...delayed };
  } catch (error) {
    if (!(error instanceof NoVerifiedSample)) throw error;
    if (!caughtUp) {
      const rejected = delayedFailures.filter(failure => failure.kind !== "unavailable");
      if (rejected.length) throw new RejectedFirstRateSample("Earlier FirstRate source or price comparison failed: " +
        rejected.map(row => row.symbol + " " + row.session + " " + row.reason).join(". "), rejected, [...held.keys()]);
      throw error;
    }
    return { ...caughtUp.result, ...delayed, caughtUpSession: caughtUp.session, awaitingSession: latest,
      latestFailure: error.message };
  }
}
