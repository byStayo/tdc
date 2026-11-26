import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import type { CashDistribution } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeCalendarVersion, exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotPrices, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { kibotIssuerCollectionStart, scorePriceSensitivity } from "../lib/consensus/kibot-issuer-review.ts";
import {
  ETF_SYMBOLS, MARKETPARQUET_SOURCE, reconcileMarketParquet, type MarketParquetDay, type ReferenceBars,
} from "../lib/consensus/marketparquet.ts";
import { sentisenseCredential, sentisenseResponse } from "../lib/consensus/sentisense.ts";
import { parseSentiSenseEod, SENTISENSE_EOD_SOURCE } from "../lib/consensus/sentisense-eod.ts";
import { newYorkDate } from "../lib/consensus/time.ts";

type Symbol = typeof ETF_SYMBOLS[number];
type Issuer = { symbol: Symbol; source: string; sha256: string; cash: CashDistribution[] };
type IssuerLedger = { schemaVersion: 1; capturedAt: string; distributions: Issuer[] };
type IssuerManifest = { schemaVersion: 1; source: string; evaluatedAt: string;
  inputs: { mode: string; issuers: Pick<Issuer, "symbol" | "sha256">[] } };
const NasdaqReferenceFile = "reference-nasdaq-published-2026-11-10.json";
const sampleRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length) throw new Error("The private SentiSense price review takes no arguments");
const marketParquet = resolve(sampleRoot, ".consensus/private-marketparquet");
const privateDirectory = resolve(sampleRoot, ".consensus/private-sentisense");

async function readPrivate(file: string): Promise<string> {
  const meta = await lstat(file);
  if (!meta.isFile() || (meta.mode & 0o077) || meta.size > 2_000_000)
    throw new Error("SentiSense price review inputs require bounded owner-only files");
  return readFile(file, "utf8");
}

const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const unlock = await acquirePublicationLock(sampleRoot, "sentisense-price-research");
let failure: { error: unknown } | undefined;
try {
  const begun = new Date().toISOString();
  const today = newYorkDate(begun);
  const { history, snapshots } = await verifyPublicationTree(sampleRoot);
  const [issuerText, manifestText, nasdaqText] = await Promise.all([
    readPrivate(resolve(marketParquet, "sample.json")),
    readPrivate(resolve(marketParquet, "sample-evaluation.json")),
    readPrivate(resolve(marketParquet, NasdaqReferenceFile)),
  ]);
  const issuer = JSON.parse(issuerText) as IssuerLedger;
  const manifest = JSON.parse(manifestText) as IssuerManifest;
  const nasdaq = JSON.parse(nasdaqText) as { source: string; bars: ReferenceBars };
  const archiveHash = digest(history);
  const through = exchangeSessions(newYorkDate(snapshots[0].issuedAt), today).filter(day => day < today).at(-1);
  if (!through || issuer.schemaVersion !== 1 || manifest.schemaVersion !== 1 ||
      manifest.source !== MARKETPARQUET_SOURCE || manifest.inputs?.mode !== "sample" ||
      !canonicalInstant(issuer.capturedAt) || !canonicalInstant(manifest.evaluatedAt) ||
      !(exchangeSession(through)!.closeAt <= manifest.evaluatedAt &&
        manifest.evaluatedAt <= issuer.capturedAt && issuer.capturedAt <= begun) ||
      !Array.isArray(issuer.distributions) || issuer.distributions.length !== ETF_SYMBOLS.length ||
      !Array.isArray(manifest.inputs.issuers) || manifest.inputs.issuers.length !== ETF_SYMBOLS.length ||
      !ETF_SYMBOLS.every(symbol => issuer.distributions.some(row =>
        row.symbol === symbol && /^https:\/\//.test(row.source) && /^[a-f0-9]{64}$/.test(row.sha256) &&
        Array.isArray(row.cash) && manifest.inputs.issuers.some(
          saved => saved.symbol === symbol && saved.sha256 === row.sha256))))
    throw new Error("Independent issuer histories for all five funds must follow the final reviewed close");
  const output = resolve(privateDirectory, `eod-review-${through}-${archiveHash.slice(0, 12)}.json`);
  const existing = await readPrivate(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const stored = JSON.parse(existing);
    if (stored.schemaVersion !== 1 || stored.archiveHash !== archiveHash || stored.summary?.through !== through ||
        stored.issuer?.capturedAt !== issuer.capturedAt || stored.nasdaq?.sha256 !== digest(nasdaq) ||
        !issuer.distributions.every(row => stored.issuer.sources?.some(
          (saved: Pick<Issuer, "symbol" | "sha256">) => saved.symbol === row.symbol && saved.sha256 === row.sha256)))
      throw new Error("Saved SentiSense price review differs from the current reviewed inputs");
    console.log(JSON.stringify({ ...stored.summary, status: "retained-private-review" }, null, 2));
  } else {
    const { apiKey } = await sentisenseCredential(privateDirectory);
    if (!apiKey) throw new Error("Free SentiSense evaluation access is unavailable");
    const cash = Object.fromEntries(issuer.distributions.map(row => [row.symbol, row.cash])) as Record<Symbol, CashDistribution[]>;
    const from = kibotIssuerCollectionStart(cash, through);
    const sessions = exchangeSessions(from, through);
    const responses: (ReturnType<typeof parseSentiSenseEod> & {
      symbol: Symbol; path: string; retrievedAt: string; sha256: string;
    })[] = [];
    for (const symbol of ETF_SYMBOLS) {
      const path = `stocks/chart?ticker=${symbol}&timeframe=1Y`;
      const { body, retrievedAt, sha256 } = await sentisenseResponse(path, apiKey);
      if (newYorkDate(retrievedAt) !== today) throw new Error("SentiSense capture crossed the New York date boundary");
      responses.push({ symbol, path, retrievedAt, sha256, ...parseSentiSenseEod(JSON.parse(body.toString("utf8")), sessions, today) });
    }
    const files: MarketParquetDay[] = sessions.map((session, i) => {
      const bars = Object.fromEntries(responses.map(row =>
        [row.symbol, { open: row.bars[i].open, close: row.bars[i].close }])) as MarketParquetDay["bars"];
      return { session, bars, sha256: digest({ session, bars }) };
    });

    // Nasdaq published daily opens and closes cover a pinned subset. Keep that
    // exact check distinct from the broader as-traded Kibot comparison.
    const officialDates = nasdaq.bars.SPY.map(row => row.session);
    if (!nasdaq.source.startsWith("https://www.nasdaq.com/") || !officialDates.length ||
        !ETF_SYMBOLS.every(symbol => nasdaq.bars[symbol].map(row => row.session).join() === officialDates.join()))
      throw new Error("Independent Nasdaq reference must cover the same dates for all five ETFs");
    const requested = new Set(officialDates);
    const officialFiles = files.filter(file => requested.has(file.session));
    if (officialFiles.length !== officialDates.length)
      throw new Error("SentiSense sample does not reach every saved Nasdaq checkpoint");
    const official = reconcileMarketParquet(
      officialDates, officialFiles, cash, nasdaq.bars, { openBps: 0.5, closeBps: 0.5 },
    );

    const raw = await collectKibotPrices(from, begun, fetch, true);
    if (raw.through !== through) throw new Error("Kibot raw reference differs from the intended date");
    const sensitivity = scorePriceSensitivity({ snapshots, files, cash, raw: raw.evidence,
      sameRunSessions: sessions, now: begun, candidateSource: SENTISENSE_EOD_SOURCE });
    const { reconciliation } = sensitivity;
    const boundaries = reconciliation.symbols.flatMap(row => row.boundaries);
    const summary = {
      status: "private-price-research",
      from, through, reviewedSessions: sessions.length, symbols: ETF_SYMBOLS.length,
      droppedCurrentSession: responses.filter(row => row.ignoredToday).length,
      earlyReferencePresent: responses.filter(row => row.containsHistoricalShortSession).length,
      nasdaqComparisons: official.symbols.reduce((sum, row) => sum + row.compared, 0),
      nasdaqMatches: official.symbols.reduce((sum, row) => sum + row.matched.length, 0),
      asTradedComparisons: reconciliation.symbols.reduce((sum, row) => sum + row.compared, 0),
      asTradedMatches: reconciliation.symbols.reduce((sum, row) => sum + row.matched.length, 0),
      verifiedThrough: reconciliation.verifiedThrough,
      issuerBoundaries: boundaries.length, verifiedBoundaries: boundaries.filter(row => row.status === "verified").length,
      pairedOutcomes: Object.fromEntries(Object.entries(sensitivity.cohorts).map(([horizon, row]) =>
        [horizon, { selected: row.selected, labelDisagreements: row.labelDisagreements }])),
    };
    await durableJSON(output, {
      schemaVersion: 1, archiveHash, capturedAt: new Date().toISOString(),
      source: SENTISENSE_EOD_SOURCE, calendar: exchangeCalendarVersion(from, through),
      priceBasis: "split-adjusted with issuer cash applied after reconciliation",
      approval: "private only pending upstream rights and trade-session definitions",
      issuer: { startedAt: manifest.evaluatedAt, capturedAt: issuer.capturedAt,
        sources: issuer.distributions.map(({ symbol, source, sha256 }) => ({ symbol, source, sha256 })) },
      responses, nasdaq: { source: nasdaq.source, sha256: digest(nasdaq), comparison: official },
      kibot: { source: KIBOT_PRICE_CITATION, hashes: raw.hashes },
      sensitivity, summary,
    }, true);
    console.log(JSON.stringify(summary, null, 2));
  }
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(unlock, failure);
}
