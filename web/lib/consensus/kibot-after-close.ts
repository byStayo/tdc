import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { ETF_CASH_SOURCES, type CashDistribution } from "./corporate-adjustment.ts";
import { ctaReferenceUrl, CTA_REFERENCE_SYMBOLS } from "./cta-reference.ts";
import { asIssuedOutcomeCall, outcomeKey, type SessionPrice } from "./evaluation.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { digest, verifyPublicationTree } from "./history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "./kibot.ts";
import { ETF_SYMBOLS } from "./marketparquet.ts";
import { dailySessionOutcomes } from "./outcome-coverage-audit.ts";
import { PUBLIC_ORIGIN, verifyPreopenReceipt } from "./preopen-receipt.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";
import type { Snapshot } from "./types.ts";
import { nasdaqDaily, retainedPriorPrices, retainedSessionWitnesses, STOCKLAKE_HISTORY } from "./kibot-session-witnesses.ts";

type ETF = typeof ETF_SYMBOLS[number];
export type Stamp = { source: string; capturedAt: string; sha256: string };
type PriceStamp = Stamp & { basis: string; summaryAt?: string };
export type SessionFundProof = {
  symbol: ETF; cashBoundary?: { native: Stamp; independent: Stamp }; selectedBars: SessionPrice[]; asTraded: SessionPrice[];
  sources: { listing?: PriceStamp; historical?: PriceStamp; secondary?: PriceStamp;
    kibot: PriceStamp; issuer: Stamp & { targetExDates: CashDistribution[] } };
};
type EditionPin = { edition: string; session?: string; source?: string; origin?: string;
  publiclyObservedAt?: string; observedAt?: string; byteSha256?: string; archiveSha256?: string };
export type CloseProof = { schemaVersion: number; purpose: string; day: string; previous: string; edition: string;
  market: ReturnType<typeof exchangeSession>; pin?: EditionPin | null; preopen?: EditionPin | null; publicPin?: EditionPin | null; sources: Partial<Record<ETF, SessionFundProof>> };

const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function completedRegularSession(day: string, now: string) {
  const market = exchangeSession(day);
  if (!market || !isFullKibotSession(market.openAt, market.closeAt) || !iso(now) || now <= market.closeAt)
    throw new Error("After-close evaluation requires a completed full exchange session");
  return market;
}
function checkPair(native: SessionPrice, control: SessionPrice, day: string) {
  const clock = exchangeSession(day)!;
  for (const row of [native, control])
    if (!row || row.session !== day || row.openAt !== clock.openAt || row.closeAt !== clock.closeAt ||
        ![row.open, row.close].every(n => Number.isFinite(n) && n > 0))
      throw new Error("Unverified price or regular-session clock");
  if (Math.abs(control.open / native.open - 1) * 10000 > 3 ||
      Math.abs(control.close / native.close - 1) * 10000 > 15 ||
      Math.sign(control.close - control.open) !== Math.sign(native.close - native.open))
    throw new Error("Independent regular-session prices or directions disagree");
}

export function reviewedFund(row: SessionFundProof, symbol: ETF, day: string, previous: string, edition: Snapshot, now: string) {
  const market = completedRegularSession(day, now);
  const dates = exchangeSessions(previous, day);
  if (dates.length !== 2 || dates[0] !== previous || dates[1] !== day) throw new Error("Missing immediately preceding exchange session");
  const { sources } = row;
  if (row.symbol !== symbol || !sources?.kibot || !sources.issuer ||
      sources.kibot.source !== KIBOT_PRICE_CITATION || sources.kibot.basis !== "as-traded regular-session first and last trade" ||
      sources.issuer.source !== ETF_CASH_SOURCES[symbol])
    throw new Error("Missing the instrument's as-traded or official issuer evidence");
  const control = sources.listing ?? sources.historical ?? sources.secondary;
  if (!control) throw new Error("Missing independent price control");
  if (sources.listing) {
    if (!CTA_REFERENCE_SYMBOLS.some(s => s === symbol) || control.source !== ctaReferenceUrl(day) ||
        control.basis !== "as-traded-primary-listing-participant-eod-summary" || !iso(control.summaryAt) ||
        Date.parse(control.summaryAt) < Date.parse(market.closeAt) + 4 * 3600_000 || control.summaryAt > control.capturedAt)
      throw new Error("Invalid final CTA participant report");
  } else if (sources.historical) {
    if (!["QQQ", "TLT"].includes(symbol) ||
        ![nasdaqDaily(symbol, day), `https://www.nasdaq.com/market-activity/etf/${symbol.toLowerCase()}/historical`].includes(control.source) ||
        !["Nasdaq historical Open and Close/Last", "Nasdaq published historical Open and Close/Last"].includes(control.basis))
      throw new Error("Invalid dated Nasdaq historical control");
  } else if (control.source !== STOCKLAKE_HISTORY ||
      control.basis !== "provider daily OHLCV; venue, eligible trade and adjustment method unspecified") {
    throw new Error("Unrecognized secondary market control");
  }
  const clocks = [sources.kibot, control, sources.issuer].map(item => {
    if (!sha(item.sha256) || !iso(item.capturedAt) || item.capturedAt <= market.closeAt || item.capturedAt > now)
      throw new Error("Missing post-close source hash or capture time");
    return item.capturedAt;
  });
  if (!Array.isArray(row.asTraded) || ![1, 2].includes(row.asTraded.length) || row.selectedBars?.length !== row.asTraded.length)
    throw new Error("Missing native or independent target session");
  const native = row.asTraded.at(-1)!, independent = row.selectedBars.at(-1)!;
  checkPair(native, independent, day);
  if (row.asTraded.length === 2) checkPair(row.asTraded[0], row.selectedBars[0], previous);
  const cash = sources.issuer.targetExDates;
  const prior = row.asTraded.length === 2 ? row.asTraded[0].close : null;
  if (!Array.isArray(cash) || cash.length > 1 || cash.some(e => e.session !== day ||
      !Number.isFinite(e.amount) || e.amount <= 0 || (prior !== null && (e.amount >= prior ||
      Math.abs(prior - row.selectedBars[0].close) >= e.amount / 2))))
    throw new Error("Unverified issuer ex-date or previous-session cash basis");

  const { call, called, score } = asIssuedOutcomeCall(edition, symbol, "daily");
  const { open, close } = native;
  // The holder enters after the ex-date boundary at the open. A common intraday
  // split/distribution factor cancels in this ratio. Keep the native endpoint basis.
  const returnPct = (close / open - 1) * 100;
  if (!Number.isFinite(returnPct)) throw new Error("Invalid native session return");
  const target = { snapshotId: edition.id, instrument: symbol, horizon: "daily" as const };
  if (row.cashBoundary) {
    if (!cash.length || row.cashBoundary.native.source !== KIBOT_PRICE_CITATION ||
        row.cashBoundary.independent.source === KIBOT_PRICE_CITATION) throw new Error("Unexpected issuer boundary source");
    for (const { capturedAt, sha256 } of [row.cashBoundary.native, row.cashBoundary.independent]) {
      if (!iso(capturedAt) || !sha(sha256) || capturedAt <= exchangeSession(previous)!.closeAt || capturedAt > now)
        throw new Error("Invalid prior issuer boundary source time");
      clocks.push(capturedAt);
    }
  }
  const observedAt = clocks.sort().at(-1)!;
  return { key: outcomeKey(target), ...target, engineVersion: edition.engineVersion, issuedAt: edition.issuedAt,
    entryAt: market.openAt, exitAt: market.closeAt, observedAt, asIssuedCall: call,
    directionCorrect: called ? Math.sign(score!) === Math.sign(returnPct) : null, returnPct,
    endpointBasis: "Kibot as-traded regular-session open and close", returnBasis: "same-session open-to-close",
    ...(row.cashBoundary ? { cashBoundary: row.cashBoundary } : {}),
    sources: { native: sources.kibot, independent: control, issuer: sources.issuer } };
}

async function verifiedPriorCashBoundary(root: string, sourceRoot: string, symbol: ETF, fund: SessionFundProof, previous: string, collect: boolean) {
  const cash = fund.sources.issuer.targetExDates[0];
  if (!cash) return fund;
  const directory = resolve(root, ".consensus/private-kibot/after-close", previous);
  const record = await readResearchReceipt<{ proofDigest: string; instrument: ETF; exitAt: string; observedAt: string; retrospective: boolean }>(
    resolve(directory, symbol + ".json"));
  let native, independent, nativeSource, independentSource;
  // Older research-only rows have no operational standing. Original source files can still qualify independently.
  if (record && record.retrospective === false) {
    if (!sha(record.proofDigest) || record.instrument !== symbol || record.exitAt !== exchangeSession(previous)!.closeAt ||
        !iso(record.observedAt) || record.observedAt > new Date().toISOString()) throw new Error("Invalid previously confirmed issuer boundary");
    const proof = await readResearchReceipt<CloseProof>(resolve(directory, previous + "-" + record.proofDigest + ".json"));
    const prior = proof?.sources[symbol];
    if (!proof || digest(proof) !== record.proofDigest || proof.day !== previous || prior?.symbol !== symbol)
      throw new Error("Invalid previous issuer boundary proof");
    native = prior.asTraded.at(-1);
    independent = prior.selectedBars.at(-1);
    nativeSource = prior.sources.kibot;
    independentSource = prior.sources.listing ?? prior.sources.historical ?? prior.sources.secondary;
  } else {
    const previousPrices = await retainedPriorPrices(sourceRoot, symbol, previous, collect);
    native = previousPrices.native;
    independent = previousPrices.independent;
    nativeSource = previousPrices.nativeSource;
    independentSource = previousPrices.controlSource;
  }
  if (!native || !independent || !nativeSource || !independentSource) throw new Error("Missing earlier independently confirmed ex-date reference");
  checkPair(native, independent, previous);
  if ((fund.asTraded.length === 2 && (native.open !== fund.asTraded[0].open || native.close !== fund.asTraded[0].close)) ||
      cash.amount >= native.close || Math.abs(native.close - independent.close) >= cash.amount / 2)
    throw new Error("Earlier independent close differs across the ex-date boundary");
  const lineage = ({ source, capturedAt, sha256 }: Stamp) => ({ source, capturedAt, sha256 });
  const cashBoundary = { native: lineage(nativeSource), independent: lineage(independentSource) };
  if (fund.cashBoundary && digest(fund.cashBoundary) !== digest(cashBoundary))
    throw new Error("Previously captured issuer boundary lineage differs");
  return { ...fund, cashBoundary, asTraded: [native, fund.asTraded.at(-1)!],
    selectedBars: [independent, fund.selectedBars.at(-1)!] };
}

export type AfterCloseInput = string | { sources: string; collect?: boolean };
export async function evaluatePrivateAfterClose(root: string, day: string, input: AfterCloseInput) {
  const startedAt = new Date().toISOString();
  const market = completedRegularSession(day, startedAt);
  const previous = exchangeSessions(EXCHANGE_CALENDAR.from, day).at(-2);
  if (!previous) throw new Error("Missing reviewed previous exchange session");
  const { snapshots, current } = await verifyPublicationTree(root);
  const target = dailySessionOutcomes(snapshots, [], day, current.engineVersion, { asOf: startedAt, ledgerObservedAt: startedAt });
  const edition = snapshots.find(s => s.id === target.edition);
  if (!edition) throw new Error("Missing last issued edition before the entry open");
  const archive = await readFile(resolve(root, "public/consensus", edition.id + ".json"));
  const preopen = await verifyPreopenReceipt(root, day, edition.id, archive, startedAt);
  const archiveSha256 = preopen.archiveSha256;
  const sourceRoot = typeof input === "string" ? resolve(dirname(input), "sources") : resolve(input.sources);
  let proof: CloseProof;
  if (typeof input === "string") {
    const saved = await readResearchReceipt<CloseProof>(input);
    if (!saved || basename(input) !== day + "-" + digest(saved) + ".json" || saved.schemaVersion !== 1 ||
        saved.purpose !== "owner-private-after-close-ETF-proof" || saved.day !== day || saved.previous !== previous ||
        saved.market?.session !== day || saved.market.openAt !== market.openAt || saved.market.closeAt !== market.closeAt ||
        saved.edition !== edition.id || !saved.sources || Object.keys(saved.sources).some(s => !ETF_SYMBOLS.some(symbol => symbol === s)))
      throw new Error("After-close receipt differs from its digest, edition or exchange calendar");
    for (const pin of [saved.pin, saved.preopen, saved.publicPin]) {
      if (pin == null) continue;
      const clocks = [pin.publiclyObservedAt, pin.observedAt].filter(at => at !== undefined);
      const hashes = [pin.byteSha256, pin.archiveSha256].filter(hash => hash !== undefined);
      if (pin.edition !== edition.id || (pin.session !== undefined && pin.session !== day) ||
          (pin.origin !== undefined && pin.origin !== PUBLIC_ORIGIN) ||
          !hashes.length || hashes.some(hash => hash !== archiveSha256) || !clocks.length ||
          new Set(clocks).size !== 1 || clocks.some(at => !iso(at) || at < edition.issuedAt || at >= market.openAt))
        throw new Error("Another pre-open observation differs from the verified edition or pre-open window");
    }
    proof = saved;
  } else {
    proof = { schemaVersion: 1, purpose: "owner-private-after-close-ETF-proof", day, previous,
      edition: edition.id, market, sources: {} };
  }
  const fromFiles = typeof input !== "string", collect = fromFiles && input.collect === true;
  if (collect) {
    const published = await realpath(resolve(root, "public"));
    if (sourceRoot === published || sourceRoot.startsWith(published + "/")) throw new Error("Private source directory required");
    await durableDirectory(sourceRoot, 0o700);
    const location = await realpath(sourceRoot), mode = await lstat(sourceRoot);
    if (!mode.isDirectory() || mode.mode & 0o077 || location === published || location.startsWith(published + "/"))
      throw new Error("Capture requires an owner-only private source directory");
  }
  const readFund = retainedSessionWitnesses(root, sourceRoot, day, collect);
  const qualified: ReturnType<typeof reviewedFund>[] = [];
  const pending: { instrument: ETF; reason: string }[] = [];
  for (const symbol of ETF_SYMBOLS) {
    try {
      const declared = proof.sources[symbol];
      if (!fromFiles && !declared) throw new Error("Missing source evidence");
      const fund = await readFund(symbol, declared);
      // Check captured prices and issuer cash before requesting any necessary prior-date evidence.
      const original = reviewedFund(fund, symbol, day, previous, edition, new Date().toISOString());
      const joined = await verifiedPriorCashBoundary(root, sourceRoot, symbol, fund, previous, collect);
      const outcome = joined === fund ? original : reviewedFund(joined, symbol, day, previous, edition, new Date().toISOString());
      if (fromFiles) proof.sources[symbol] = joined;
      qualified.push(outcome);
    } catch (error) {
      pending.push({ instrument: symbol, reason: error instanceof Error && /^[A-Za-z][A-Za-z -]{1,70}$/.test(error.message)
        ? error.message : "Invalid or missing retained source evidence" });
    }
  }
  const proofDigest = digest(proof), now = new Date().toISOString();
  const directory = resolve(root, ".consensus/private-kibot/after-close", day);
  let added = 0;
  if (qualified.length) {
    await durableDirectory(directory, 0o700);
    const retained = resolve(directory, day + "-" + proofDigest + ".json");
    const saved = await readResearchReceipt<CloseProof>(retained);
    if (saved !== null && digest(saved) !== proofDigest) throw new Error("Retained source receipt changed");
    if (!saved) await durableJSON(retained, proof, true);
    for (const row of qualified) {
      const path = resolve(directory, row.instrument + ".json");
      const record = { schemaVersion: 1, recordedAt: now, archiveSha256, proofDigest, retrospective: false, ...row };
      const prior = await readResearchReceipt<typeof record>(path);
      if (prior) {
        // Keep the first verified observation under its original identity on later checks.
        if (!sha(prior.proofDigest) || !iso(prior.recordedAt) || prior.recordedAt < prior.observedAt || prior.recordedAt > now)
          throw new Error("Invalid previously retained private outcome");
        const frozen = await readResearchReceipt<CloseProof>(resolve(directory, day + "-" + prior.proofDigest + ".json"));
        const oldFund = frozen?.sources[row.instrument], newNative = proof.sources[row.instrument]!.asTraded.at(-1)!;
        if (!frozen || digest(frozen) !== prior.proofDigest || !oldFund ||
            oldFund.asTraded.at(-1)?.open !== newNative.open || oldFund.asTraded.at(-1)?.close !== newNative.close ||
            prior.archiveSha256 !== archiveSha256 || prior.key !== row.key || prior.returnPct !== row.returnPct ||
            digest(prior) !== digest({ schemaVersion: 1, recordedAt: prior.recordedAt, archiveSha256, proofDigest: prior.proofDigest,
              retrospective: false,
              ...reviewedFund(prior.cashBoundary ? { ...oldFund, cashBoundary: prior.cashBoundary } : oldFund, row.instrument, day, previous, edition, now) }))
          throw new Error("Retained private daily identity or outcome changed");
      } else {
        await durableJSON(path, record, true);
        added++;
      }
    }
  }
  return { session: day, edition: edition.id, preopenObservedAt: preopen.observedAt, qualified: qualified.length, added, pending,
    eligibleInputs: target.funds.filter(fund => fund.inputEligible && qualified.some(row => row.instrument === fund.instrument)).length,
    called: qualified.filter(row => row.asIssuedCall !== "withheld").length,
    allInputsCapturedOnSessionDate: qualified.filter(row => newYorkDate(row.observedAt) === day).length,
    allInputsCapturedBy: qualified.length === ETF_SYMBOLS.length ? qualified.map(row => row.observedAt).sort().at(-1) : null };
}
