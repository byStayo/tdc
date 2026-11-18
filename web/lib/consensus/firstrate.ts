import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { CTA_REFERENCE_SYMBOLS, type CtaReference } from "./cta-reference.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
import { digest } from "./history.ts";
import { isFullKibotSession } from "./kibot.ts";
import { ETF_SYMBOLS } from "./marketparquet.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { collectResearchPrices, readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";

export const FIRST_RATE_SOURCE = "https://firstratedata.com/stock-data";
export const FIRST_RATE_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA"] as const;
const FIRST_RATE_SAMPLE_HOST = "https://frd001.s3.us-east-2.amazonaws.com/";
const FIRST_EDITION_DAY = "2026-11-03";
const BASIS_POINTS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;
type Symbol = (typeof FIRST_RATE_SYMBOLS)[number];
type Bar = Pick<SessionPrice, "session" | "open" | "close">;
type PriceSource = { symbol: Symbol; url: string; sha256: string; basis: "split-adjusted";
  capturedAt: string; modifiedAt: string; rows: Bar[] };
type Issuer = { symbol: typeof ETF_SYMBOLS[number]; source: string; sha256: string;
  capturedAt: string; cash: CashDistribution[] };
type ApprovedSymbol = {
  symbol: Symbol;
  rows: SessionPrice[];
  withheld: { session: string; reason: "short-session" | "price" | "direction" }[];
  proof: { source: Omit<PriceSource, "rows">; comparison: string[]; splitComparison: string[];
    listingReferences: { session: string; source: string; sha256: string }[] };
};
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

function priorSession(now: string) {
  const yesterday = new Date(Date.parse(newYorkDate(now)) - 86_400_000).toISOString().slice(0, 10);
  const through = exchangeSessions(EXCHANGE_CALENDAR.from, yesterday).at(-1);
  if (!through) throw new Error("No reviewed prior session for FirstRate");
  return through;
}

function fullSession(day: string) {
  const session = exchangeSession(day);
  return session !== null && isFullKibotSession(session.openAt, session.closeAt);
}

/** Require one intact, independently compared price basis for each confirmed full session. */
export function reconcileFirstRateRows(
  symbol: Symbol, candidate: Bar[], raw: SessionPrice[], splitOnly: SessionPrice[], listing: Bar[] = [],
) {
  if (candidate.length !== raw.length || candidate.length !== splitOnly.length)
    throw new Error(`${symbol} FirstRate comparison has missing sessions`);
  const withheld: ApprovedSymbol["withheld"] = [];
  const rows = candidate.flatMap((row, i) => {
    const expected = raw[i], split = splitOnly[i];
    const clock = exchangeSession(row.session);
    if (!clock || row.session !== expected.session || row.session !== split.session)
      throw new Error(`${symbol} FirstRate comparison has different session dates`);
    if (expected.open !== split.open || expected.close !== split.close)
      throw new Error(`${symbol} has a split-basis difference on ${row.session}`);
    const open = Math.abs(row.open / expected.open - 1) * BASIS_POINTS;
    const close = Math.abs(row.close / expected.close - 1) * BASIS_POINTS;
    const listedMatch = listing.some(mark => mark.session === row.session && mark.open === row.open && mark.close === row.close);
    let reason: ApprovedSymbol["withheld"][number]["reason"] | undefined;
    if (!fullSession(row.session)) reason = "short-session";
    else if (![row.open, row.close].every(price => Number.isFinite(price) && price > 0) || open > 3 || close > 15)
      reason = "price";
    else if (Math.sign(row.close - row.open) !== Math.sign(expected.close - expected.open) && !listedMatch)
      reason = "direction";
    if (reason) {
      withheld.push({ session: row.session, reason });
      return [];
    }
    return [{ ...clock, open: row.open, close: row.close }];
  });
  return { rows, withheld };
}

async function listingReferences(directory: string, symbol: Symbol, dates: string[]) {
  if (!CTA_REFERENCE_SYMBOLS.some(covered => covered === symbol)) return [];
  const references = [];
  for (const session of dates) {
    const record = await readResearchReceipt<CtaReference>(resolve(directory, `cta-${session}.json`));
    if (!record) continue;
    const mark = record.rows.find(row => row.symbol === symbol && row.session === session);
    const url = `https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.${session.replaceAll("-", "")}.csv`;
    if (!mark || record.scope !== "private-price-reconciliation" || record.source !== url ||
        record.basis !== "as-traded-primary-listing-participant-eod-summary" || !SHA256.test(record.sha256))
      throw new Error(`Unverified exact listing reference for ${symbol} ${session}`);
    references.push({ mark, session, source: url, sha256: record.sha256 });
  }
  return references;
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
  if (approval.from < FIRST_EDITION_DAY || approval.source !== FIRST_RATE_SOURCE ||
      approval.symbols.length !== FIRST_RATE_SYMBOLS.length ||
      FIRST_RATE_SYMBOLS.some((symbol, index) => symbol !== approval.symbols[index].symbol))
    throw new Error("FirstRate approval has an invalid source or instrument list");
  verifyIssuers(approval.issuers, approval.through, approval.approvedAt);
  return approval.symbols.map(({ symbol, rows }) => {
    const byDate = new Map(rows.map(row => [row.session, row]));
    if (byDate.size !== rows.length || rows.some(row => row.session < approval.from || row.session > approval.through ||
        !fullSession(row.session) || row.openAt !== exchangeSession(row.session)!.openAt ||
        row.closeAt !== exchangeSession(row.session)!.closeAt))
      throw new Error(`FirstRate approval has invalid sessions for ${symbol}`);
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
  const stored = await readResearchReceipt<StoredApproval>(resolve(root, directoryName, "approved.json"));
  if (stored && (stored.approval.schemaVersion !== 1 || stored.sha256 !== digest(stored.approval)))
    throw new Error("FirstRate approved prices differ from their private receipt");
  return stored?.approval ?? null;
}

export async function loadFirstRatePrices(root: string) {
  const approval = await readApproval(root);
  return approval ? firstRatePriceEvidence(approval) : [];
}

/** Caller holds the existing publication lock. The only committed output is an owner-local receipt. */
export async function prepareFirstRate(root: string, cachedOnly = false, now = new Date().toISOString()) {
  const through = priorSession(now);
  if (through < FIRST_EDITION_DAY) return { status: "no_issued_targets", through };
  const directory = resolve(root, directoryName);
  const previous = await readApproval(root);
  if (previous && previous.through >= through)
    return { status: "reused", through: previous.through, approved: firstRatePriceEvidence(previous).map(({ instrument, sessions }) =>
      ({ instrument, sessions: sessions.length })) };
  await durableDirectory(directory, 0o700);
  const { stdout } = await promisify(execFile)("python3",
    ["-B", resolve(root, "scripts/collect-firstrate-inputs.py"), through, ...(cachedOnly ? ["--cached-only"] : [])],
    { timeout: 105_000, maxBuffer: 256_000 });
  const { samples, issuers } = JSON.parse(stdout) as { samples: PriceSource[]; issuers: Issuer[] };
  const observed = new Date().toISOString();
  const closingAt = exchangeSession(through)!.closeAt;
  verifyIssuers(issuers, through, observed);
  if (samples.length !== FIRST_RATE_SYMBOLS.length ||
      FIRST_RATE_SYMBOLS.some((symbol, index) => samples[index].symbol !== symbol))
    throw new Error("FirstRate did not supply the four documented equity samples");

  const from = previous?.from ?? [FIRST_EDITION_DAY, ...samples.map(sample => sample.rows[0].session)].sort().at(-1)!;
  const approved: ApprovedSymbol[] = [];
  for (const { rows, ...source } of samples) {
    const { symbol } = source;
    const dates = exchangeSessions(rows[0].session, through);
    if (dates.join() !== rows.map(row => row.session).join() || source.url !== sourceURL(symbol) ||
        source.basis !== "split-adjusted" || !SHA256.test(source.sha256) ||
        !(closingAt <= source.modifiedAt && source.modifiedAt <= source.capturedAt && source.capturedAt <= observed))
      throw new Error(`FirstRate ${symbol} sample is stale or differs from the reviewed calendar or source`);

    const old = previous?.symbols.find(row => row.symbol === symbol);
    const issuer = issuers.find(row => row.symbol === symbol)!;
    const pastCash = previous?.issuers.find(row => row.symbol === symbol)?.cash.filter(row =>
      row.session >= from && row.session <= previous.through);
    if (previous && digest(pastCash) !== digest(issuer.cash.filter(row => row.session >= from && row.session <= previous.through)))
      throw new Error(`Issuer history changed for previously checked ${symbol} sessions`);

    const raw = await collectResearchPrices(directory, symbol, dates, { reviewedExchangeCalendar: true, cachedOnly });
    const splits = await collectResearchPrices(directory, symbol, dates, {
      reviewedExchangeCalendar: true, splitAdjusted: true, cachedOnly,
    });
    const asTraded = raw.flatMap(row => row.sessions), splitOnly = splits.flatMap(row => row.sessions);
    const check = reconcileFirstRateRows(symbol, rows, asTraded, splitOnly);
    const listing = await listingReferences(directory, symbol,
      check.withheld.filter(row => row.reason === "direction").map(row => row.session));
    const normalized = listing.length
      ? reconcileFirstRateRows(symbol, rows, asTraded, splitOnly, listing.map(row => row.mark))
      : check;
    const merged = new Map(old?.rows.map(row => [row.session, row]));
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
    approved.push({ symbol, rows: [...merged.values()].sort((a, b) => a.session.localeCompare(b.session)),
      withheld: normalized.withheld,
      proof: { source, comparison: raw.map(row => row.sha256), splitComparison: splits.map(row => row.sha256),
        listingReferences: listing.map(({ session, source, sha256 }) => ({ session, source, sha256 })) } });
  }
  const approval: Approval = { schemaVersion: 1, source: FIRST_RATE_SOURCE, from, through,
    approvedAt: new Date().toISOString(), issuers, symbols: approved };
  const evidence = firstRatePriceEvidence(approval);
  // Archive each accepted capture before advancing the current receipt.
  const stored = { approval, sha256: digest(approval) };
  const captured = resolve(directory, "approvals", `${through}.json`);
  const replay = await readResearchReceipt<StoredApproval>(captured);
  if (replay && (replay.sha256 !== digest(replay.approval) ||
      digest({ ...replay.approval, approvedAt: approval.approvedAt }) !== stored.sha256))
    throw new Error("A previous capture for that FirstRate session differs");
  if (!replay) await durableJSON(captured, stored, true);
  await durableJSON(resolve(directory, "approved.json"), replay ?? stored);
  return { status: "qualified", from, through, approved: evidence.map(({ instrument, sessions }) =>
    ({ instrument, sessions: sessions.length })), withheld: approved.flatMap(({ symbol, withheld }) =>
    withheld.map(row => ({ symbol, ...row }))) };
}
