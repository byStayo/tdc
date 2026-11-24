import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { firstRateIssuerActionProof, type MarketHistoryActionProof } from "./market-history-actions.ts";
import { ComparisonUnavailable, collectMarketHistoryPriceControls, type HourlyControlProof } from "./market-history-price-controls.ts";
import { promisify } from "node:util";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { collectCtaReference, ctaReferenceUrl, CTA_REFERENCE_SYMBOLS, type CtaReference } from "./cta-reference.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
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
type SampleFailure = { symbol: Symbol; reason: string };
type ListingProof = { session: string; source: string; sha256: string };
type MinuteRepair = {
  session: string; captureSession: string; source: Omit<PriceSource, "rows">;
  rawSha256: string; splitSha256: string; minutes?: number;
} & ({ listing: ListingProof; auction?: never } | { listing?: never; auction: QqqAuction; daily: Bar });
type ApprovedSymbol = {
  symbol: Symbol;
  reviewedThrough?: string;
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
  if (latest !== newYorkDate(now) || latest <= FIRST_EDITION_DAY) return [latest];
  const prior = latestFirstRateSession(exchangeSession(latest)!.openAt);
  return approvedThrough.some(through => through < prior) ? [prior, latest] : [latest];
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
          (action.session >= FIRST_EDITION_DAY && action.session <= through && !exchangeSession(action.session)))))
    throw new Error("All five official issuer histories must be captured after the final reviewed close");
}

export function firstRatePriceEvidence(approval: Approval): PriceEvidence[] {
  const dates = exchangeSessions(approval.from, approval.through);
  const ordered = FIRST_RATE_SYMBOLS.filter(symbol => approval.symbols.some(row => row.symbol === symbol));
  if (approval.from < FIRST_EDITION_DAY || approval.source !== FIRST_RATE_SOURCE ||
      !approval.symbols.length || ordered.length !== approval.symbols.length ||
      ordered.some((symbol, index) => symbol !== approval.symbols[index].symbol))
    throw new Error("FirstRate approval has an invalid source or instrument list");
  verifyIssuers(approval.issuers, approval.through, approval.approvedAt);
  return approval.symbols.map(({ symbol, rows, proof, reviewedThrough = approval.through }) => {
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
        if (!block.length) blocks.push(block);
        block.push(row);
      }
    }
    const cash = approval.issuers.find(issuer => issuer.symbol === symbol)!.cash;
    const sessions = blocks.flatMap(block => adjustETFPrices(block,
      cash.filter(action => action.session >= block[0].session && action.session <= block.at(-1)!.session), []));
    return { instrument: symbol, source: FIRST_RATE_SOURCE, adjustment: OUTCOME_PRICE_BASIS, expectedSessions: dates, sessions };
  });
}

async function readApproval(root: string) {
  const directory = resolve(root, directoryName);
  const stored = await readResearchReceipt<StoredApproval>(resolve(directory, "approved.json"));
  if (stored && (stored.approval.schemaVersion !== 1 || stored.sha256 !== digest(stored.approval)))
    throw new Error("FirstRate approved prices differ from their private receipt");
  for (const fund of stored?.approval.symbols ?? []) {
    const proof = fund.proof.marketHistory, paid = fund.proof.subscriber;
    if (paid) {
      if (proof) throw new Error("FirstRate approval names conflicting independent providers");
      const dates = exchangeSessions(paid.from, paid.through);
      const opts = { reviewedExchangeCalendar: true, productionRoot: root, cachedOnly: true };
      const raw = await collectResearchPrices(directory, fund.symbol, dates, opts);
      const splits = await collectResearchPrices(directory, fund.symbol, dates, { ...opts, splitAdjusted: true });
      if (paid.sha256 !== digest({ raw, splits }) || [...raw, ...splits].some(row => !row.paid || row.paid.capturedAt > stored!.approval.approvedAt) ||
          digest(fund.proof.comparison) !== digest(raw.map(r => r.sha256)) ||
          digest(fund.proof.splitComparison) !== digest(splits.map(r => r.sha256))) throw new Error("FirstRate subscriber control changed");
    }
    if (!proof) continue;
    const controls = await collectMarketHistoryPriceControls(root, fund.symbol, exchangeSessions(proof.from, proof.through), true,
      { asOf: stored!.approval.approvedAt });
    const issuer = stored!.approval.issuers.find(row => row.symbol === fund.symbol);
    if (!issuer || !fund.proof.actions) throw new Error("FirstRate hourly control is missing its issuer action check");
    const actions = await firstRateIssuerActionProof(root, fund.symbol, proof.from, proof.through, issuer.cash, true,
      { asOf: stored!.approval.approvedAt });
    if (digest(actions) !== digest(fund.proof.actions)) throw new Error("FirstRate issuer action proof changed");
    if (digest(controls.proof) !== digest(proof) || fund.proof.comparison.length !== 1 ||
        fund.proof.splitComparison.length !== 1 || fund.proof.comparison[0] !== proof.raw ||
        fund.proof.splitComparison[0] !== proof.splits) throw new Error("FirstRate hourly comparison differs from its pinned sources");
  }
  for (const fund of stored?.approval.symbols ?? []) for (const repair of fund.proof.minuteRepairs ?? []) {
    if (repair.auction && digest(await readQqqAuction(directory, repair.session, true)) !== digest(repair.auction))
      throw new Error("FirstRate QQQ approval differs from its archived Nasdaq auction");
  }
  return stored?.approval ?? null;
}

export async function loadFirstRatePrices(root: string) {
  const approval = await readApproval(root);
  return approval ? firstRatePriceEvidence(approval) : [];
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

/** Replay only captured ZIPs pinned by the per-symbol approval, without changing any price receipt. */
export async function loadFirstRatePremarket(root: string, cutoff: string) {
  const approval = await readApproval(root);
  if (!approval || approval.source !== FIRST_RATE_SOURCE || approval.approvedAt > cutoff) return [];
  const observations = await Promise.all(FIRST_RATE_SYMBOLS.map(async symbol => {
    try {
      const matches = approval.symbols.filter(row => row.symbol === symbol);
      if (matches.length !== 1) return [];
      const [entry] = matches, { source } = entry.proof;
      const day = entry.reviewedThrough ?? approval.through;
      const clock = exchangeSession(day);
      // Approval pins the archive. Its regular-session settlement is independent of the premarket boundary prices.
      if (!clock || day < approval.from || day > approval.through || source.symbol !== symbol || source.url !== sourceURL(symbol) ||
          source.basis !== "split-adjusted" || !SHA256.test(source.sha256) ||
          ![entry.proof.comparison, entry.proof.splitComparison].every(refs => refs.length && refs.every(hash => SHA256.test(hash)))) return [];
      const { stdout } = await promisify(execFile)("python3", ["-B", resolve(root, "scripts/collect-firstrate-inputs.py"),
        day, "--cached-premarket", symbol, "--expected-close", clock.closeAt.replace(/Z$/, "+00:00")],
      { timeout: 15_000, maxBuffer: 4096 });
      const sample: PremarketSample & { url: string } = JSON.parse(stdout);
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
  failures: SampleFailure[]): Promise<ReviewedSymbol> {
  const { rows, regularMinutes, ...source } = sample;
  const { symbol } = source;
  const dates = exchangeSessions(rows[0].session, through);
  const closingAt = exchangeSession(through)!.closeAt;
  if (dates.join() !== rows.map(row => row.session).join() || source.url !== sourceURL(symbol) ||
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
      throw new Error(error.message + ". " + (paidError instanceof Error ? paidError.message : "Subscriber comparison unavailable"));
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
  const minutesToReview = [...shortReplays, ...regularMinutes.filter(row => !repairs.has(row.session))];
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
      failures.push({ symbol, reason: session + " " + NASDAQ_WEBSITE_PRICE_PERMISSION });
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
      exchangeSessions(priorLast, incomingFirst).length === 2)
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
  return { symbol, reviewedThrough: through, rows: [...merged.values()].sort((a, b) => a.session.localeCompare(b.session)),
    withheld: normalized.withheld,
    proof: { source, comparison: raw.map(row => row.sha256), splitComparison: splits.map(row => row.sha256),
      listingReferences: references, ...(comparisons.proof ? { marketHistory: comparisons.proof, actions } :
        { subscriber: { from: dates[0], through, sha256: digest({ raw, splits }) } }),
      ...(repairs.size ? { minuteRepairs: [...repairs.values()] } : {}) } };
}

function approvedCounts(approval: Approval) {
  return firstRatePriceEvidence(approval).map(({ instrument, sessions }) => ({ instrument, sessions: sessions.length }));
}

class NoVerifiedSample extends Error {}

const reviewableIssue = (symbol: Symbol, reason: ApprovedSymbol["withheld"][number]["reason"]) =>
  symbol === "QQQ" ? reason === "price" : CTA_REFERENCE_SYMBOLS.some(covered => covered === symbol) && reason !== "price";

async function reviewFirstRateSession(root: string, through: string, cachedOnly: boolean, reviewWithheld: boolean) {
  const directory = resolve(root, directoryName);
  const previous = await readApproval(root);
  if (reviewWithheld && !previous) throw new Error("FirstRate replay needs a verified capture");
  if (through < FIRST_EDITION_DAY) return { status: "no_issued_targets", through };
  const approved = new Map(previous?.symbols.map(row =>
    [row.symbol, { ...row, reviewedThrough: row.reviewedThrough ?? previous.through }]));
  const pending = FIRST_RATE_SYMBOLS.filter(symbol => {
    const old = approved.get(symbol);
    return reviewWithheld
      ? old?.reviewedThrough === through && old.withheld.some(row => reviewableIssue(symbol, row.reason))
      : (old?.reviewedThrough ?? "") < through;
  });
  if (previous && !pending.length)
    return { status: "reused", through: previous.through, approved: approvedCounts(previous) };
  const pinned = cachedOnly || reviewWithheld;
  const shortArgs = exchangeSessions(EXCHANGE_CALENDAR.from, through).slice(-16)
    .flatMap(day => sessionMinutes(exchangeSession(day)!) === 210 ? ["--short-session", day] : []);
  await durableDirectory(directory, 0o700);
  const { stdout } = await promisify(execFile)("python3",
    ["-B", resolve(root, "scripts/collect-firstrate-inputs.py"), through, "--independent-samples",
      "--expected-close", exchangeSession(through)!.closeAt.replace(/Z$/, "+00:00"),
      ...shortArgs,
      ...(pinned ? ["--cached-only"] : [])],
    { timeout: 105_000, maxBuffer: 256_000 });
  const { samples, sampleFailures, issuers } = JSON.parse(stdout) as {
    samples: Sample[]; sampleFailures: SampleFailure[]; issuers: Issuer[] };
  const inventory = [...samples, ...sampleFailures].map(row => row.symbol);
  if (inventory.length !== FIRST_RATE_SYMBOLS.length || FIRST_RATE_SYMBOLS.some(symbol => !inventory.includes(symbol)))
    throw new Error("FirstRate did not account for each documented sample");
  const observed = new Date().toISOString();
  const failures = sampleFailures.filter(row => pending.includes(row.symbol));
  const availableSamples = samples.filter(row => pending.includes(row.symbol));
  if (!availableSamples.length) {
    if (reviewWithheld)
      return { status: "no_verified_disputes", through, approved: approvedCounts(previous!), failures };
    throw new NoVerifiedSample(`FirstRate could not verify a sample for ${through}. ${failures.map(row => row.reason).join(". ")}`);
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
    try {
      const old = approved.get(sample.symbol);
      const issuer = issuers.find(row => row.symbol === sample.symbol)!;
      const match = await reviewSample(directory, sample, through, from, pinned, observed, old, issuer.cash, failures);
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
      failures.push({ symbol: sample.symbol, reason: error instanceof Error ? error.message.slice(0, 240) : "Price comparison failed" });
    }
  }
  if (reviewWithheld && !reviewed.length)
    return { status: "no_verified_disputes", through, approved: approvedCounts(previous!), failures };
  if (!reviewed.length)
    throw new NoVerifiedSample(`FirstRate could not verify a sample for ${through}. ${failures.map(row => row.reason).join(". ")}`);

  const symbols = FIRST_RATE_SYMBOLS.flatMap(symbol => approved.has(symbol) ? [approved.get(symbol)!] : []);
  const preserveNewer = previous && previous.through > through;
  const approval: Approval = { schemaVersion: 1, source: FIRST_RATE_SOURCE, from,
    through: preserveNewer ? previous.through : through, approvedAt: new Date().toISOString(),
    issuers: preserveNewer ? previous.issuers : issuers, symbols };
  const counts = approvedCounts(approval);
  // Archive each accepted capture before advancing the current receipt.
  const stored = { approval, sha256: digest(approval) };
  const fingerprint = digest({ ...approval, approvedAt: null });
  const captured = resolve(directory, "approvals", `${approval.through}-${fingerprint}.json`);
  const replay = await readResearchReceipt<StoredApproval>(captured);
  if (replay && (replay.sha256 !== digest(replay.approval) ||
      digest({ ...replay.approval, approvedAt: approval.approvedAt }) !== stored.sha256))
    throw new Error("A previous capture for that FirstRate session differs");
  if (!replay) await durableJSON(captured, stored, true);
  await durableJSON(resolve(directory, "approved.json"), replay ?? stored);
  return { status: "qualified", from, through: approval.through, reviewed, approved: counts, failures,
    ...(listingFailure ? { listingFailure } : {}),
    withheld: symbols.flatMap(({ symbol, withheld }) => withheld.map(row => ({ symbol, ...row }))) };
}

/** Caller holds the publication lock. Retain an accepted catch-up even when tonight's new sample is late. */
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
  if (!cachedOnly && qqq && qqq.withheld.some(row => reviewableIssue("QQQ", row.reason))) {
    // A newer ZIP can arrive late. Keep the original ZIP, issuers and comparison prices pinned
    // while collecting only the missing exchange evidence for the outstanding dispute.
    const day = qqq.reviewedThrough ?? previous!.through;
    const repair = await reviewFirstRateSession(root, day, false, true);
    if (repair.status === "qualified") caughtUp = { session: day, result: repair };
  }
  if (dates.length > 1) {
    try {
      const earlier = await reviewFirstRateSession(root, dates[0], cachedOnly, false);
      if (earlier.status === "qualified") caughtUp = { session: dates[0], result: earlier };
    } catch (error) { if (!(error instanceof NoVerifiedSample)) throw error; }
  }
  try {
    const result = await reviewFirstRateSession(root, latest, cachedOnly, false);
    return caughtUp ? { ...result, caughtUp } : result;
  } catch (error) {
    if (!caughtUp || !(error instanceof NoVerifiedSample)) throw error;
    return { ...caughtUp.result, caughtUpSession: caughtUp.session, awaitingSession: latest, latestFailure: error.message };
  }
}
