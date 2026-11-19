import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { exchangeSession, exchangeSessions, EXCHANGE_CALENDAR } from "../lib/consensus/exchange-calendar.ts";
import type { CashDistribution } from "../lib/consensus/corporate-adjustment.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { closeMomentum, coreSessionCloses, fetchMarketHistoryHours, parseMarketHistoryHours, reconcileCoreCloses,
  type CoreClock, type MarketHistoryCapture, type MarketHistoryHour } from "../lib/consensus/market-history-closes.ts";
import { collectResearchPrices } from "../lib/consensus/research-price-capture.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { sourceChunk } from "../lib/consensus/source-failure.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-market-history");
const sourceFrom = "2026-10-13", sourceThrough = "2026-11-17";
const method = "market-history-core-close-qualification-v1";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;
const HOUR = 3_600_000;

async function privateBytes(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.() || !stat.size || stat.size > 4_000_000)
    throw new Error("Expected a bounded owner-only research receipt");
  return readFile(path);
}

async function readCapture(symbol: typeof ETF_SYMBOLS[number]) {
  const path = resolve(directory, `${symbol}-2025-1h.json`);
  const bytes = await privateBytes(path);
  const capture = JSON.parse(bytes.toString("utf8")) as MarketHistoryCapture;
  return { path, fileSha256: hash(bytes), capture, hours: parseMarketHistoryHours(capture, symbol) };
}

function openingBucketComparison(hours: MarketHistoryHour[], calendar: CoreClock[], controls: SessionPrice[]) {
  const byTime = new Map(hours.map(row => [Date.parse(row.timestamp), row]));
  const reference = new Map(controls.map(row => [row.session, row]));
  let compared = 0, matched = 0, maxErrorBps = 0;
  for (const clock of calendar) {
    const bucket = byTime.get(Math.floor(Date.parse(clock.openAt) / HOUR) * HOUR);
    const control = reference.get(clock.session);
    if (!bucket || !control) continue;
    const error = Math.abs(bucket.open / control.open - 1) * 10000;
    compared++;
    if (error <= 3) matched++;
    maxErrorBps = Math.max(maxErrorBps, error);
  }
  return { compared, matched, toleranceBps: 3, maxErrorBps: round(maxErrorBps), bucketBeginsAtNewYork: "09:00" };
}

async function issuerCash() {
  const folder = resolve(root, ".consensus/private-firstrate/captures/2026-11-17");
  const path = resolve(folder, "issuer-TLT.bin"), metadataPath = resolve(folder, "issuer-TLT.json");
  const [bytes, metadataBytes] = await Promise.all([privateBytes(path), privateBytes(metadataPath)]);
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as { symbol: string; url: string; sha256: string; capturedAt: string };
  if (metadata.symbol !== "TLT" || metadata.sha256 !== hash(bytes) ||
      metadata.url !== "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd" ||
      !Number.isFinite(Date.parse(metadata.capturedAt)) || Date.parse(metadata.capturedAt) > Date.now())
    throw new Error("Issuer original differs from its dated receipt");
  // Reuse the repository's official iShares parser against the saved original.
  const { stdout } = await promisify(execFile)("python3", ["-B", "-c",
    "import json,sys; from pathlib import Path; from issuer_corporate_actions import issuer_cash; print(json.dumps(issuer_cash('TLT',Path(sys.argv[1]).read_bytes())))",
    path], { cwd: resolve(root, "scripts"), timeout: 10_000, maxBuffer: 100_000 });
  const parsed = JSON.parse(stdout) as { symbol: string; source: string; sha256: string; cash: CashDistribution[] };
  if (parsed.sha256 !== metadata.sha256 ||
      !parsed.cash.some(action => action.session === "2026-11-02" && action.amount === 0.343177))
    throw new Error("Issuer November cash boundary is missing");
  return { path, metadataPath, metadataSha256: hash(metadataBytes), ...metadata, cash: parsed.cash };
}

async function probe(source: string) {
  const response = await fetch(source, { redirect: "error", credentials: "omit",
    signal: AbortSignal.timeout(30_000), headers: { Accept: "application/x-ndjson" } });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Market History probe has no body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 8192) throw new Error("Market History probe exceeds its small response bound");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return { source, capturedAt: new Date().toISOString(), status: response.status, sha256: hash(text), text,
    headers: Object.fromEntries(["content-type", "x-feed", "x-data-through", "x-row-count", "x-bars-charged", "x-next-cursor"]
      .map(name => [name, response.headers.get(name)])) };
}

let stage = "validating arguments";
async function main() {
  if (process.argv.length !== 2) throw new Error("This source qualification uses a fixed bounded window");
  await durableDirectory(directory, 0o700);
  stage = "verifying the historical private originals";
  const historical = [];
  const historicalDays = historicalResearchSessions(2025);
  const historicalClock = historicalDays.map(day => historicalResearchSession(day)!);
  for (const symbol of ETF_SYMBOLS) {
    const { path, fileSha256, capture, hours } = await readCapture(symbol);
    const [raw, splits] = await Promise.all([
      collectResearchPrices(resolve(root, ".consensus/private-technical-momentum"), symbol, historicalDays, { cachedOnly: true }),
      collectResearchPrices(resolve(root, ".consensus/private-technical-momentum"), symbol, historicalDays, { cachedOnly: true, splitAdjusted: true }),
    ]);
    const core = coreSessionCloses(hours, historicalClock, capture.through);
    const reconciliation = reconcileCoreCloses(core.closes, raw[0].sessions, splits[0].sessions);
    const early = core.closes.filter(row => row.earlyClose);
    historical.push({ symbol, original: { path, fileSha256, bodySha256: capture.sha256,
      capturedAt: capture.capturedAt, through: capture.through, count: capture.count,
      feedHeaderStored: false }, source: capture.source, expectedSessions: historicalDays.length,
      closes: core.closes.length, missingSessions: core.missingSessions,
      controls: { raw: { sha256: raw[0].sha256, priceDigest: raw[0].priceDigest },
        splits: { sha256: splits[0].sha256, priceDigest: splits[0].priceDigest } },
      reconciliation, earlyCloses: { sessions: early.map(row => row.session),
        ...reconcileCoreCloses(early, raw[0].sessions, splits[0].sessions) },
      openingBucket: openingBucketComparison(hours, historicalClock, raw[0].sessions) });
  }

  stage = "collecting the anonymous hourly source";
  const captured = await fetchMarketHistoryHours("TLT", sourceFrom, sourceThrough);
  const hours = parseMarketHistoryHours(captured, "TLT");
  const calendar = exchangeSessions(sourceFrom, sourceThrough);
  const core = coreSessionCloses(hours, calendar.map(day => exchangeSession(day)!), captured.through);
  if (!core.closes.length) throw new Error("The source has no completed core closes");

  stage = "checking the free mode and opening bucket responses";
  const modeProbes = [];
  for (const adjustment of ["all", "splits"]) {
    const url = new URL(captured.source);
    url.searchParams.set("adjust", adjustment);
    modeProbes.push({ mode: adjustment, ...await probe(url.href) });
  }
  const filtered = new URL(captured.source);
  filtered.searchParams.set("start", "2026-11-02T14:30:00Z");
  filtered.searchParams.set("end", "2026-11-02T14:59:59Z");
  const openingProbe = await probe(filtered.href);
  const openingRows = openingProbe.status === 200 ? openingProbe.text.trim().split(/\r?\n/).map(line =>
    JSON.parse(line) as MarketHistoryHour) : [];
  const includesPreOpenBucket = openingRows.some(row => row.timestamp === "2026-11-02T14:00:00Z");

  stage = "reconciling current as-traded and split-only controls";
  const oldDays = exchangeSessions("2026-01-02", "2026-11-02");
  const [oldRaw, newerRaw, splitOnly, issuer] = await Promise.all([
    collectResearchPrices(resolve(root, ".consensus/private-technical-momentum"), "TLT", oldDays,
      { cachedOnly: true, reviewedExchangeCalendar: true }),
    collectResearchPrices(resolve(root, ".consensus/private-stocklake"), "TLT",
      exchangeSessions("2026-11-03", sourceThrough), { cachedOnly: true, reviewedExchangeCalendar: true }),
    collectResearchPrices(directory, "TLT", calendar, { splitAdjusted: true, reviewedExchangeCalendar: true }),
    issuerCash(),
  ]);
  const rawControls = [...oldRaw[0].sessions.filter(row => row.session >= sourceFrom), ...newerRaw[0].sessions];
  const splitControls = splitOnly[0].sessions;
  const reconciliation = reconcileCoreCloses(core.closes, rawControls, splitControls);
  const splitByDate = new Map(splitControls.map(row => [row.session, row]));
  const stableSplitBasis = rawControls.every(row => {
    const split = splitByDate.get(row.session);
    return split && Math.abs(row.close / split.close - 1) < 0.000001 && Math.abs(row.open / split.open - 1) < 0.000001;
  });
  const cash = issuer.cash.filter(action => action.session >= sourceFrom && action.session <= sourceThrough);
  const momentum = closeMomentum(core.closes, calendar, cash);
  const boundaryDays = ["2026-10-30", "2026-11-02"];
  const boundary = closeMomentum(core.closes.filter(row => boundaryDays.includes(row.session)), boundaryDays, cash)[0];
  const baseline = historical.find(row => row.symbol === "TLT")!;
  const qualified = baseline.closes === historicalDays.length && baseline.reconciliation.qualified &&
    baseline.earlyCloses.qualified && reconciliation.qualified && stableSplitBasis &&
    boundary.status === "contiguous" && modeProbes.every(row => row.status === 400) && includesPreOpenBucket;
  const status = qualified ? (core.missingSessions.length ? "qualified_close_only_lagged" : "qualified_close_only_current") :
    "source_qualification_incomplete";
  const evaluatedAt = new Date().toISOString();
  const recent = {
    source: captured.source, capturedAt: captured.capturedAt, bodySha256: captured.sha256,
    dataThrough: captured.through, hourlyRows: captured.count, request: { from: sourceFrom, through: sourceThrough },
    expectedSessions: calendar.length, closes: core.closes.length, latestCoreSession: core.closes.at(-1)!.session,
    missingSessions: core.missingSessions, reconciliation, stableSplitBasis,
    controls: { raw: [...oldRaw, ...newerRaw].map(({ from, through, sha256, priceDigest }) => ({ from, through, sha256, priceDigest })),
      splits: splitOnly.map(({ from, through, sha256, priceDigest }) => ({ from, through, sha256, priceDigest })) },
    momentum, issuerBoundary: boundary, closesEvidence: core.closes,
  };
  const stamp = evaluatedAt.replace(/[:.]/g, "-");
  const reportPath = resolve(directory, "core-close-qualification.json");
  const runPath = resolve(directory, "runs", `core-close-${stamp}.json`);
  const capturePath = resolve(directory, "runs", `TLT-${stamp}-raw.json`);
  const probePath = resolve(directory, "runs", `TLT-${stamp}-free-mode-probes.json`);
  const report = {
    schemaVersion: 1, method, status, evaluatedAt,
    semantics: "Last consolidated trade in the final complete hourly bucket ending at the scheduled core close.",
    calendars: { historical: HISTORICAL_RESEARCH_CALENDAR.id, recent: EXCHANGE_CALENDAR.id },
    rights: { reviewedAt: evaluatedAt, effective: "2026-11-17",
      terms: "https://getmarkethistory.com/docs/terms/", partners: "https://getmarkethistory.com/docs/partners/",
      access: "https://getmarkethistory.com/docs/bars/#free-sample",
      internalResearch: "permitted", derivedIndicatorsWithoutBulkReconstruction: "permitted",
      rawPriceDisplay: "separate-agreement", rawRedistribution: "separate-agreement" },
    receipts: { capturePath, probePath, runPath },
    historical, recent, issuer,
    freeModeProbes: modeProbes.map(({ mode, source, capturedAt, status, sha256, headers }) =>
      ({ mode, source, capturedAt, status, sha256, headers })),
    filteredOpeningProbe: { source: openingProbe.source, status: openingProbe.status, sha256: openingProbe.sha256,
      requestedStart: "2026-11-02T14:30:00Z", includesPreOpenBucket, count: openingRows.length },
  };

  stage = "saving owner-only source evidence";
  // This lock is scoped to private source receipts and is independent of the publisher.
  const release = await acquirePublicationLock(directory, method);
  let failure: { error: unknown } | undefined;
  try {
    await durableJSON(capturePath, captured, true);
    await durableJSON(probePath, { modeProbes, openingProbe }, true);
    await durableJSON(runPath, report, true);
    await durableJSON(reportPath, report);
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
  const roundedChanges = momentum.map(row => ({ sessions: row.sessions, status: row.status,
    rawChangePct: round(row.rawChangePct), issuerAdjustedChangePct: round(row.issuerAdjustedChangePct),
    cashEffectBps: round(row.cashEffectBps) }));
  console.log(JSON.stringify({ status, through: recent.latestCoreSession, hourlyRows: captured.count,
    historical: { matched: baseline.reconciliation.raw.matched, sessions: historicalDays.length,
      maxCloseErrorBps: round(baseline.reconciliation.raw.maxErrorBps), earlyCloses: baseline.earlyCloses.raw.matched,
      openingBucketMatched: baseline.openingBucket.matched },
    recent: { matched: reconciliation.raw.matched, expected: calendar.length, missing: core.missingSessions.length,
      maxCloseErrorBps: round(reconciliation.raw.maxErrorBps), stableSplitBasis },
    changes: roundedChanges, issuerBoundary: { rawChangePct: round(boundary.rawChangePct),
      issuerAdjustedChangePct: round(boundary.issuerAdjustedChangePct), cashEffectBps: round(boundary.cashEffectBps) },
    modes: modeProbes.map(row => ({ mode: row.mode, status: row.status })), includesPreOpenBucket, reportPath }));
}

main().catch(() => {
  console.error("Private Market History qualification failed while " + stage + ".");
  process.exitCode = 1;
});
