import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { ETF_SYMBOLS, reconcileMarketParquet, type MarketParquetDay, type ReferenceBars } from "../lib/consensus/marketparquet.ts";

// Independent check of the private vendor ledger. Prints differences, never prices.
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? false : !!args.splice(at, 1); };
const licensed = flag("--licensed"), record = flag("--record-review");
const referenceAt = args.indexOf("--reference");
const referencePath = referenceAt < 0 ? undefined : args.splice(referenceAt, 2)[1];
if (args.length || (referenceAt >= 0 && !referencePath))
  throw new Error("Usage: reconcile-marketparquet.ts [--licensed] [--reference /absolute/private/reference.json] [--record-review]");

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-marketparquet");
const release = await acquirePublicationLock(root, "marketparquet-reconciliation");
let failure: { error: unknown } | undefined;
try {
  const now = new Date().toISOString();
  const ledgerText = await readFile(resolve(directory, licensed ? "licensed.json" : "sample.json"), "utf8");
  const ledger = JSON.parse(ledgerText) as { schemaVersion: number; capturedAt?: string; bars: MarketParquetDay[];
    distributions: { symbol: typeof ETF_SYMBOLS[number]; sha256: string; cash: { session: string; amount: number }[] }[] };
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.bars) || !ledger.bars.length ||
      ledger.distributions?.length !== ETF_SYMBOLS.length)
    throw new Error("Run the MarketParquet evaluator before reconciling its ledger");
  const files = ledger.bars.slice().sort((a, b) => a.session.localeCompare(b.session));
  const first = files[0].session, through = files.at(-1)!.session;
  const calendar = exchangeSessions(first, through);
  const cash = Object.fromEntries(ETF_SYMBOLS.map(symbol => {
    const issuer = ledger.distributions.find(row => row.symbol === symbol);
    if (!issuer) throw new Error(`Missing issuer history for ${symbol}`);
    return [symbol, issuer.cash.filter(action => action.session >= first && action.session <= through)];
  })) as Parameters<typeof reconcileMarketParquet>[2];

  // An operator reference quoted to the cent is held to one cent-scale
  // tolerance. The built-in guest feed uses its last regular trade, which can
  // sit several basis points from the listing venue's closing auction.
  let reference: ReferenceBars, source: string, hashes: Record<string, string>;
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
  } else {
    const collected = await collectKibotPrices(first, now, fetch, true);
    reference = Object.fromEntries(collected.evidence.map(series => [series.instrument,
      series.sessions.map(({ session, open, close }) => ({ session, open, close }))])) as ReferenceBars;
    source = collected.evidence[0].source;
    hashes = collected.hashes;
  }

  const result = reconcileMarketParquet(calendar, files, cash, reference, tolerance);
  const capturedAfterClose = !!ledger.capturedAt &&
    Date.parse(ledger.capturedAt) >= Date.parse(exchangeSession(through)!.closeAt);
  const summary = { schemaVersion: 1, reconciledAt: now, mode: licensed ? "licensed" : "sample",
    ledgerSha256: createHash("sha256").update(ledgerText).digest("hex"), ledgerCapturedAt: ledger.capturedAt ?? null,
    files: files.map(({ session, sha256 }) => ({ session, sha256 })),
    issuers: ledger.distributions.map(({ symbol, sha256 }) => ({ symbol, sha256 })),
    reference: { source, hashes, tolerance }, capturedAfterClose, ...result };
  const evidenceName = `reconciliation-${through}-${now.replace(/[:.]/g, "-")}.json`;
  await durableJSON(resolve(directory, evidenceName), summary, true);

  let reviewed = false;
  if (record) {
    // Extending the review asserts one unbroken share basis from the first
    // captured session and issuer histories read after the final close.
    if (!result.passed || !capturedAfterClose)
      throw new Error("Review not recorded. Every session must reconcile and the issuer capture must follow the final close.");
    await durableJSON(resolve(directory, "actions-review.json"), { through, issuerActionsVerified: true,
      splitBasisVerified: true, earlyClosesVerified: result.earlyClosesVerified, evidence: evidenceName, reviewedAt: now });
    reviewed = true;
  }
  console.log(JSON.stringify({ mode: summary.mode, sessions: result.sessions, reference: source, tolerance,
    passed: result.passed, verifiedThrough: result.verifiedThrough, capturedAfterClose,
    earlyClosesVerified: result.earlyClosesVerified, boundarySymbolsVerified: result.boundarySymbolsVerified,
    symbols: result.symbols.map(({ symbol, compared, unmatched, differing, maxOpenBps, maxCloseBps, boundaries }) =>
      ({ symbol, compared, unmatched, differing, maxOpenBps: +maxOpenBps.toFixed(3), maxCloseBps: +maxCloseBps.toFixed(3), boundaries })),
    evidence: evidenceName, reviewRecorded: reviewed }, null, 2));
  if (!result.passed) process.exitCode = 2;
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}
