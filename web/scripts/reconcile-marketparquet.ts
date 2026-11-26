import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { collectKibotPrices, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { authenticateKibotSubscriber, type KibotSubscriberProof } from "../lib/consensus/kibot-subscriber.ts";
import { collectMarketParquetDaily, marketParquetDailyPolicy } from "../lib/consensus/marketparquet-daily.ts";
import { MARKETPARQUET_HOURLY_REFERENCE, marketParquetHourlyControls,
  type MarketParquetHourlyReference } from "../lib/consensus/marketparquet-market-history.ts";
import { collectLicensedControls, licensedSettlementPrices, recordLicensedSettlement, reserveMarketParquetControl, verifyMarketParquetControlEntitlement,
  type LicensedControlChunk, type LicensedMarketParquetLedger, type LicensedSettlement } from "../lib/consensus/marketparquet-settlement.ts";
import { ETF_SYMBOLS, reconcileMarketParquet, marketParquetIssuerFingerprints, type MarketParquetDay, type ReferenceBars } from "../lib/consensus/marketparquet.ts";

// Independent check of the private vendor ledger. Prints differences, never prices.
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? false : !!args.splice(at, 1); };
const licensed = flag("--licensed"), record = flag("--record-review");
const referenceAt = args.indexOf("--reference");
const referencePath = referenceAt < 0 ? undefined : args.splice(referenceAt, 2)[1];
const controlAt = args.indexOf("--control");
const selected = controlAt < 0 ? undefined : args.splice(controlAt, 2)[1];
const root = fileURLToPath(new URL("../", import.meta.url));
const configured = selected ?? (licensed && !referencePath ? process.env.MARKETPARQUET_CONTROL || undefined : undefined);
const policy = licensed && !referencePath && (!configured || configured === "market-history") ? await marketParquetDailyPolicy(root) : null;
const control = configured ?? policy?.control ?? "kibot";
if (args.length || (referenceAt >= 0 && !referencePath) || (controlAt >= 0 && (!selected || !licensed || referencePath)) ||
    !["kibot", "market-history"].includes(control))
  throw new Error("Usage: reconcile-marketparquet.ts [--licensed] [--control kibot|market-history] [--reference /absolute/private/reference.json] [--record-review]");
if (licensed && record && referencePath)
  throw new Error("Operator-supplied reference files support private comparison. Recording a new licensed review requires verified production control provenance.");

const directory = resolve(root, ".consensus/private-marketparquet");
const release = await acquirePublicationLock(root, "marketparquet-reconciliation");
let failure: { error: unknown } | undefined;
let daily: Awaited<ReturnType<typeof collectMarketParquetDaily>> | undefined;

function dailyUpdate() {
  return daily ? { daily, shouldRunProspectiveEvaluation: daily.accepted.length > 0 } : {};
}

function unavailableScope(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("shortened session")) return "short_session_auction_missing";
  if (message.includes("licensed capture calendar")) return "incomplete_archive_calendar";
  if (message.includes("already fixed") || message.includes("selected another source")) return "comparison_source_fixed";
  if (message.includes("horizon direction")) return "different_horizon_direction";
  return "independent_review_unavailable";
}
try {
  const startedAt = new Date().toISOString();
  const ledgerText = await readFile(resolve(directory, licensed ? "licensed.json" : "sample.json"), "utf8");
  const ledger = JSON.parse(ledgerText) as { schemaVersion: number; capturedAt?: string; expectedSessions?: string[]; bars: MarketParquetDay[];
    distributions: { symbol: typeof ETF_SYMBOLS[number]; sha256: string; cash: { session: string; amount: number }[] }[] };
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.bars) || !ledger.bars.length ||
      ledger.distributions?.length !== ETF_SYMBOLS.length)
    throw new Error("Run the MarketParquet evaluator before reconciling its ledger");
  const files = ledger.bars.slice().sort((a, b) => a.session.localeCompare(b.session));
  if (licensed && (!Array.isArray(ledger.expectedSessions) || !ledger.expectedSessions.length))
    throw new Error("Recapture the licensed ledger with its expected session calendar");
  const calendar = licensed ? ledger.expectedSessions! : exchangeSessions(files[0].session, files.at(-1)!.session);
  const first = calendar[0], through = calendar.at(-1)!;
  const cash = Object.fromEntries(ETF_SYMBOLS.map(symbol => {
    const issuer = ledger.distributions.find(row => row.symbol === symbol);
    if (!issuer) throw new Error(`Missing issuer history for ${symbol}`);
    return [symbol, issuer.cash.filter(action => action.session >= first && action.session <= through)];
  })) as Parameters<typeof reconcileMarketParquet>[2];

  // An operator reference quoted to the cent is held to one cent-scale
  // tolerance. The built-in as-traded reference uses its last regular trade, which can
  // sit several basis points from the listing venue's closing auction.
  let reference: ReferenceBars, source: string, hashes: Record<string, string> | undefined;
  let controlChunks: LicensedControlChunk[] | undefined;
  let hourlyProof: MarketParquetHourlyReference | undefined;
  let subscriber: KibotSubscriberProof | undefined;
  if (licensed && !referencePath) {
    if (record && control === "market-history" && policy) {
      daily = await collectMarketParquetDaily(root, JSON.parse(ledgerText) as LicensedMarketParquetLedger, policy);
    }
    const input = verifyMarketParquetControlEntitlement(ledgerText, through, startedAt);
    await reserveMarketParquetControl(directory, input.ledger, control === "market-history" ? control : "kibot");
  }
  let tolerance = { openBps: 3, closeBps: 15 };
  if (referencePath) {
    if (!isAbsolute(referencePath)) throw new Error("Provide an absolute private reference path");
    const file = await lstat(referencePath);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 2_000_000)
      throw new Error("Expected an owner-only regular reference file");
    const text = await readFile(referencePath, "utf8");
    const supplied = JSON.parse(text) as { source: string; bars: ReferenceBars };
    if (typeof supplied.source !== "string" || !/^https:\/\/[^\s@]+$/.test(supplied.source) || !supplied.bars)
      throw new Error("Reference needs an HTTPS source citation and bars for all five ETFs");
    reference = supplied.bars;
    source = supplied.source;
    hashes = { reference: createHash("sha256").update(text).digest("hex") };
    tolerance = { openBps: 0.5, closeBps: 0.5 };
  } else if (licensed && control === "market-history") {
    const controls = await marketParquetHourlyControls(root, calendar, cash);
    reference = controls.reference;
    hourlyProof = controls.proof;
    source = MARKETPARQUET_HOURLY_REFERENCE;
  } else if (licensed) {
    const account = await authenticateKibotSubscriber(root);
    subscriber = account.proof;
    const controls = await collectLicensedControls(calendar, account);
    reference = controls.reference;
    controlChunks = controls.chunks;
    source = KIBOT_PRICE_CITATION;
  } else {
    const collected = await collectKibotPrices(first, startedAt, fetch, true);
    reference = Object.fromEntries(collected.evidence.map(series => [series.instrument,
      series.sessions.map(({ session, open, close }) => ({ session, open, close }))])) as ReferenceBars;
    source = collected.evidence[0].source;
    hashes = collected.hashes;
  }

  const controlsAt = new Date().toISOString();
  const result = reconcileMarketParquet(calendar, files, cash, reference, tolerance, { requireDirection: true });
  const now = new Date().toISOString();
  const capturedAfterClose = !!ledger.capturedAt &&
    Date.parse(ledger.capturedAt) >= Date.parse(exchangeSession(through)!.closeAt);
  const summary = { schemaVersion: 2, reconciledAt: now, mode: licensed ? "licensed" : "sample",
    ledgerSha256: createHash("sha256").update(ledgerText).digest("hex"), ledgerCapturedAt: ledger.capturedAt ?? null,
    files: files.map(({ session, sha256 }) => ({ session, sha256 })),
    issuers: ledger.distributions.map(({ symbol, sha256 }) => ({ symbol, sha256 })),
    issuerActions: marketParquetIssuerFingerprints(ledger.distributions, first, through),
    reference: { source, tolerance, ...(controlChunks ? {
      chunks: controlChunks.map(({ from, through, capturedAt, hashes }) => ({ from, through, capturedAt, hashes })),
    } : hourlyProof ? { capturedAt: hourlyProof.capturedAt, chunks: hourlyProof.chunks } : { hashes }) }, capturedAfterClose, ...result };
  const evidenceName = `reconciliation-${through}-${now.replace(/[:.]/g, "-")}.json`;
  await durableJSON(resolve(directory, evidenceName), summary, true);

  let reviewed = false;
  if (record && result.passed && capturedAfterClose) {
    let settlement: LicensedSettlement | undefined;
    if (controlChunks && subscriber) {
      settlement = { schemaVersion: 3, mode: "licensed", through, reconciledAt: now,
        ledgerText, ledgerSha256: summary.ledgerSha256, earlyClosesVerified: result.earlyClosesVerified,
        reference: { source, capturedAt: controlsAt, chunks: controlChunks, subscriber } };
      licensedSettlementPrices(settlement, now);
    } else if (hourlyProof) {
      settlement = { schemaVersion: 4, mode: "licensed", through, reconciledAt: now, ledgerText,
        ledgerSha256: summary.ledgerSha256, earlyClosesVerified: result.earlyClosesVerified, reference: hourlyProof };
    }
    if (licensed && !settlement) throw new Error("Missing independently authorized production controls for MarketParquet");
    if (settlement) await recordLicensedSettlement(directory, settlement, now);
    // Extending the review asserts one unbroken share basis from the first
    // captured session and issuer histories read after the final close.
    await durableJSON(resolve(directory, licensed ? "licensed-actions-review.json" : "actions-review.json"), { through, issuerActionsVerified: true,
      splitBasisVerified: true, earlyClosesVerified: result.earlyClosesVerified, evidence: evidenceName, reviewedAt: now });
    reviewed = true;
  }
  console.log(JSON.stringify({ mode: summary.mode, sessions: result.sessions, reference: source, tolerance, ...dailyUpdate(),
    ...(daily ? { multiSession: { status: reviewed ? "reviewed" : "withheld",
      reason: reviewed ? null : result.horizonDifferences.length ? "different_horizon_direction" : "incomplete_reconciliation" } } : {}),
    passed: result.passed, verifiedThrough: result.verifiedThrough, capturedAfterClose,
    horizonDifferences: result.horizonDifferences,
    earlyClosesVerified: result.earlyClosesVerified, boundarySymbolsVerified: result.boundarySymbolsVerified,
    symbols: result.symbols.map(({ symbol, compared, unmatched, differing, maxOpenBps, maxCloseBps, boundaries }) =>
      ({ symbol, compared, unmatched, differing, maxOpenBps: +maxOpenBps.toFixed(3), maxCloseBps: +maxCloseBps.toFixed(3), boundaries })),
    evidence: evidenceName, reviewRecorded: reviewed, journalEligible: licensed && !referencePath && reviewed }, null, 2));
  if (record && !reviewed) console.error("Review not recorded. Every session and distribution boundary must reconcile and the issuer capture must follow the final close.");
  if ((!result.passed || (record && !reviewed)) && !daily?.accepted.length) process.exitCode = 2;
} catch (error) {
  failure = { error };
  if (!daily) throw error;
  console.log(JSON.stringify({ mode: "licensed", reference: MARKETPARQUET_HOURLY_REFERENCE, passed: false,
    reviewRecorded: false, journalEligible: false, ...dailyUpdate(), multiSession: { status: "withheld", reason: unavailableScope(error) } }, null, 2));
  if (!daily.accepted.length) process.exitCode = 2;
} finally {
  await finishPublicationLock(release, failure);
}
