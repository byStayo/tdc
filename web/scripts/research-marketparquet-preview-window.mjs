/** Offline, private sample evaluation. Reads only specified owner originals and never writes to a production ledger. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adjustETFPrices, officialCashLocation } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { SESSION_HORIZONS } from "../lib/consensus/evaluation.ts";
import { readQqqAuction } from "../lib/consensus/firstrate-nasdaq-auction.ts";
import { marketHistoryIssuerActionProofFromCapture } from "../lib/consensus/market-history-actions.ts";
import { readMarketHistoryPriceControl } from "../lib/consensus/market-history-price-controls.ts";
import {
  marketParquetFundReference,
  verifyMarketParquetHorizonSigns,
} from "../lib/consensus/marketparquet-market-history.ts";
import { ETF_SYMBOLS, reconcileMarketParquet } from "../lib/consensus/marketparquet.ts";
import { collectResearchPrices } from "../lib/consensus/research-price-capture.ts";

const scripts = dirname(fileURLToPath(import.meta.url));
const [host, store] = process.argv.slice(2);
assert.ok(
  host && store && process.argv.length === 4,
  "Pass the existing web evidence root and separate private preview originals directory",
);
const native = resolve(host, ".consensus/private-market-history");
const editorial = resolve(host, ".editorial/nov24-dealers-payroll");
const earlier = resolve(editorial, "nov23-independent-price-replay");
const technical = resolve(host, ".consensus/private-technical-momentum");
const first = "2026-10-23",
  from = "2026-10-30",
  exDate = "2026-11-02",
  through = "2026-11-20",
  short = "2025-11-28";
const days = exchangeSessions(first, through),
  signedDays = exchangeSessions(from, through);
assert.equal(days.length, 21);
assert.equal(signedDays.length, 16);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function original(path, pin) {
  const stat = await lstat(path);
  assert.ok(
    stat.isFile() && !(stat.mode & 0o077) && stat.size > 0 && stat.size < 4000000,
    "Expected bounded owner-only source " + basename(path),
  );
  const bytes = await readFile(path);
  if (pin) assert.equal(sha(bytes), pin, "Frozen source changed: " + basename(path));
  return bytes;
}
async function receipt(path, pin) {
  return JSON.parse(await original(path, pin));
}
function kept(collection, day) {
  const found = collection.filter((row) => row.session === day);
  assert.equal(found.length, 1, "Missing or duplicate retained session " + day);
  return found[0];
}
function errorBps(price, reference) {
  return (price / reference - 1) * 10000;
}
const tolerance = { openBps: 3, closeBps: 15 };
function comparison(provider, reference) {
  const openBps = errorBps(provider.open, reference.open),
    closeBps = errorBps(provider.close, reference.close);
  const sameDirection = Math.sign(provider.close - provider.open) === Math.sign(reference.close - reference.open);
  return {
    openBps,
    closeBps,
    sameDirection,
    pass: Math.abs(openBps) <= tolerance.openBps && Math.abs(closeBps) <= tolerance.closeBps && sameDirection,
  };
}

const held = await receipt(
  resolve(host, ".consensus/private-marketparquet/sample.json"),
  "379c3fd2a170f9e572d1721de2d65debc85b5e8f5e97d60d23ff8af921713719",
);
const later = await receipt(
  resolve(earlier, "new-sample-rows.json"),
  "e4cc84aee5808ff3337c64097f7c11153183cbf2020f412cdf9eb232d63409ab",
);
const oldReview = await receipt(
  resolve(earlier, "review.json"),
  "6a21d1264ccf0782ac63e0aa45eba25c155df27a9ac3d6f0e40b1c2061b780e5",
);
const nativeReview = await receipt(
  resolve(earlier, "native-marketparquet-reference-review.json"),
  "5d35e1af0a07b36ae2c1824a3eb256174c1cfaa484346a9735e15bb99504e679",
);
const asOf = nativeReview.asOf;
const archive = oldReview.overlap.originalSampleHashes.map(({ session, sha256 }) => {
  const row = kept([...held.bars, ...later.filter((row) => row.status === 200 && row.bars)], session);
  assert.equal(row.sha256, sha256);
  return row;
});
const needed = [short, ...days.filter((day) => !archive.some((file) => file.session === day))];
// Always regenerate selected fields directly from both native originals in the cached catalogue. No network flag.
execFileSync("python3", ["-B", resolve(scripts, "qualify-marketparquet-previews.py"), store, ...needed], {
  stdio: ["ignore", "pipe", "inherit"],
});
const previewPins = [],
  received = [];
const previews = await Promise.all(
  needed.map(async (day) => {
    const filename = day + ".private.json";
    const extracted = await original(resolve(store, filename));
    previewPins.push(filename + " " + sha(extracted));
    for (const form of ["html", "csv"]) {
      const meta = await receipt(resolve(store, day + "." + form + ".source.json"));
      received.push(Date.parse(meta.receivedAt));
    }
    const item = JSON.parse(extracted);
    assert.equal(item.scope, "private-evaluation-preview");
    const bars = Object.fromEntries(
      ETF_SYMBOLS.map((symbol) => [
        symbol,
        { open: Number(item.funds[symbol].open), close: Number(item.funds[symbol].close) },
      ]),
    );
    return { session: day, sha256: item.csvSha256, bars };
  }),
);
assert.equal(
  sha(previewPins.sort().join("\n")),
  "eac740bc5cecf8c8c9bf778e3a0adbb16762e44388bb1efd6dc01d7795ec366e",
);
const latestPreviewReceiptAt = new Date(Math.max(...received)).toISOString();
const files = days.map((day) => kept([...previews, ...archive], day));
const half = kept(previews, short);
const rawTlt = [
  "711bd2441bcb7f6d50f9fd0ee0a23f5001cdefa447fbf161ec295b09dd9871a0",
  "1e1eb35301bcb651d3a38f17c364e0a848b51c75959ef23db9d0dc59091eeabb",
];
const references = {},
  issuerCash = {},
  signedReferences = {},
  kibot = {},
  originalPins = [],
  actionProofs = {};
for (const symbol of [...ETF_SYMBOLS].sort()) {
  const issuerDir = resolve(host, ".consensus/private-kibot/sources/2026-11-23/issuer-post-close", symbol);
  const meta = await receipt(resolve(issuerDir, "issuer-" + symbol + ".json"));
  assert.ok(officialCashLocation(symbol, meta.url, meta.responseUrl));
  assert.ok(meta.capturedAt >= exchangeSession(through).closeAt && meta.capturedAt <= asOf);
  assert.equal(meta.sha256, oldReview.issuerSources[symbol].sha256);
  const input = await original(resolve(issuerDir, "issuer-" + symbol + ".bin"), meta.sha256);
  const command =
    "import json,sys; from issuer_corporate_actions import issuer_cash; print(json.dumps(issuer_cash(sys.argv[1],sys.stdin.buffer.read(),'2026-01-01')))";
  const parsed = JSON.parse(execFileSync("python3", ["-B", "-c", command, symbol], { cwd: scripts, input }));
  assert.equal(parsed.sha256, meta.sha256);
  issuerCash[symbol] = parsed.cash.filter((row) => row.session >= first && row.session <= through);

  const rawPaths =
    symbol === "TLT"
      ? rawTlt.map((hash) => resolve(native, "tlt-settlement", hash + ".json"))
      : ["opening", "closing"].map((edge) =>
          resolve(native, "five-etf-qualification", [symbol, from, through, edge].join("-") + ".json"),
        );
  const splitPaths = ["open", "close"].map((edge) =>
    resolve(native, "firstrate-controls", [symbol, from, through, "splits", edge].join("-") + ".json"),
  );
  const pair = async (paths) => {
    const [opening, closing] = await Promise.all(paths.map((path) => receipt(path)));
    return { opening, closing };
  };
  const raw = readMarketHistoryPriceControl(symbol, signedDays, await pair(rawPaths), "raw", asOf);
  const splits = readMarketHistoryPriceControl(symbol, signedDays, await pair(splitPaths), "splits", asOf);
  const source = await receipt(resolve(editorial, "extra-actions-" + symbol + ".json"));
  assert.equal(source.sha256, oldReview.secondaryActionCoverage.perSymbol[symbol].rawSha256);
  const actions = marketHistoryIssuerActionProofFromCapture(
    symbol,
    from,
    through,
    issuerCash[symbol],
    source,
    asOf,
  );
  const checked = marketParquetFundReference(symbol, signedDays, raw, splits, actions);
  assert.deepEqual(checked.proof, nativeReview.byFund[symbol][from].receipts);
  actionProofs[symbol] = {
    primaryRows: actions.primaryCount,
    issuerMirrors: actions.issuerMirrorCount,
    issuer: meta.sha256,
    actions: source.sha256,
    raw: raw.sha256,
    splits: splits.sha256,
  };
  signedReferences[symbol] = checked.prices;
  if (symbol === "TLT") {
    const rows = source.raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.ex_date === exDate);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cusip, "464287432");
    assert.equal(rows[0].record_date, exDate);
    assert.equal(rows[0].payable_date, "2026-11-05");
    assert.equal(rows[0].type, "cash_dividends");
    assert.equal(rows[0].source, null);
    assert.equal(rows[0].rate, kept(issuerCash.TLT, exDate).amount);
  }
  const byYear = {};
  for (const [year, last] of [
    [2025, "2025-12-31"],
    [2026, exDate],
  ]) {
    const dates = extendedResearchSessions(year + "-01-01", last),
      samples = [];
    for (const basis of ["raw", "splits"]) {
      const filename = [symbol, year, dates[0], last, basis].join("-") + ".json";
      originalPins.push({
        key: [year, symbol, basis].join("/"),
        value: filename + " " + sha(await original(resolve(technical, filename))),
      });
      const [item] = await collectResearchPrices(technical, symbol, dates, {
        cachedOnly: true,
        splitAdjusted: basis === "splits",
      });
      samples.push(item);
    }
    const relevant = year === 2025 ? [short] : days.filter((day) => day <= exDate);
    byYear[year] = relevant.map((day) => {
      const row = kept(samples[0].sessions, day),
        split = kept(samples[1].sessions, day);
      assert.deepEqual(row, split, "As-traded and split-only guest controls differ: " + symbol + " " + day);
      return row;
    });
  }
  kibot[symbol] = byYear;
  references[symbol] = days.map((day) => (day < from ? kept(byYear[2026], day) : kept(checked.prices, day)));
}
assert.equal(
  sha(
    originalPins
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((row) => row.value)
      .join("\n"),
  ),
  "b14ad669bf672af686608e3e9f28b46e77dbb7172f72a6970ebbc5e87407300f",
);
const report = reconcileMarketParquet(days, files, issuerCash, references, tolerance, { requireDirection: true });
const signedReport = reconcileMarketParquet(
  signedDays,
  files.filter((row) => row.session >= from),
  issuerCash,
  signedReferences,
  tolerance,
  { requireDirection: true },
);
const exceptions = report.symbols.flatMap((fund) =>
  fund.differing.map((day) => ({
    symbol: fund.symbol,
    day,
    control: day < from ? "Kibot guest archive" : "Market History signed consolidated hours",
    ...comparison(kept(files, day).bars[fund.symbol], kept(references[fund.symbol], day)),
  })),
);
const overlaps = ETF_SYMBOLS.flatMap((symbol) =>
  [from, exDate].map((day) => ({
    symbol,
    day,
    ...comparison(kept(files, day).bars[symbol], kept(kibot[symbol][2026], day)),
  })),
);
const horizons = {};
for (const span of [SESSION_HORIZONS.weekly, SESSION_HORIZONS.monthly]) {
  const windows = [];
  for (const symbol of ETF_SYMBOLS) {
    const cashevents = issuerCash[symbol];
    const vendor = adjustETFPrices(
      files.map((file) => ({ ...exchangeSession(file.session), ...file.bars[symbol] })),
      cashevents,
      [],
    );
    const independent = adjustETFPrices(
      references[symbol].map((row) => ({ ...exchangeSession(row.session), ...row })),
      cashevents,
      [],
    );
    const approved = new Set(report.symbols.find((row) => row.symbol === symbol).matched);
    for (let i = 0; i + span <= days.length; ++i) {
      const last = i + span - 1;
      windows.push({
        symbol,
        from: days[i],
        through: days[last],
        sampleReturnBps: errorBps(vendor[last].close, vendor[i].open),
        controlReturnBps: errorBps(independent[last].close, independent[i].open),
        matchedDirection:
          Math.sign(vendor[last].close - vendor[i].open) ===
          Math.sign(independent[last].close - independent[i].open),
        allConstituentsWithinTolerance: days.slice(i, last + 1).every((day) => approved.has(day)),
        allControlsSigned: days[i] >= from,
      });
    }
  }
  horizons[span] = {
    tested: windows.length,
    matchingDirections: windows.filter((r) => r.matchedDirection).length,
    allConstituentsAgree: windows.filter((r) => r.matchedDirection && r.allConstituentsWithinTolerance).length,
    allConstituentsAgreeAndSigned: windows.filter(
      (r) => r.matchedDirection && r.allConstituentsWithinTolerance && r.allControlsSigned,
    ).length,
    differingDirections: windows
      .filter((r) => !r.matchedDirection)
      .map(({ symbol, from, through, sampleReturnBps, controlReturnBps }) => ({
        symbol,
        from,
        through,
        sampleReturnBps,
        controlReturnBps,
      })),
  };
}
// The production check stops at its first discrepancy. Independently enumerate all
// windows above, then verify its failure identifies an identical fund and span.
const horizonErrors = Object.values(horizons).flatMap((scope) =>
  scope.differingDirections.map(
    (row) =>
      "Market History adjusted horizon direction differs for " +
      row.symbol +
      " from " +
      row.from +
      " through " +
      row.through,
  ),
);
let nativeHorizonFailure = null;
try {
  verifyMarketParquetHorizonSigns(files, references, issuerCash);
} catch (error) {
  assert.ok(
    error instanceof Error && horizonErrors.includes(error.message),
    "Unexpected native horizon reconciliation result",
  );
  nativeHorizonFailure = error.message;
}
assert.equal(nativeHorizonFailure === null, horizonErrors.length === 0);

const prior = kept(files, from),
  ex = kept(files, exDate),
  cash = kept(issuerCash.TLT, exDate);
const nativeRows = [prior, ex].map((file) => ({ ...exchangeSession(file.session), ...file.bars.TLT }));
const adjusted = adjustETFPrices(nativeRows, [cash], []);
const precise = JSON.parse(
  execFileSync("python3", [
    "-B",
    resolve(scripts, "research-marketparquet-dividend.py"),
    String(prior.bars.TLT.open),
    String(prior.bars.TLT.close),
    String(ex.bars.TLT.open),
    String(ex.bars.TLT.close),
    String(cash.amount),
  ]),
);
for (const [i, row] of adjusted.entries())
  for (const field of ["open", "close"])
    assert.ok(Math.abs(row[field] - Number(precise.adjusted[i][field])) < 1e-11);
const boundary = signedReport.symbols
  .find((row) => row.symbol === "TLT")
  .boundaries.find((row) => row.exDate === exDate);
assert.equal(boundary?.status, "verified");
const official = await readQqqAuction(
  resolve(host, ".consensus/private-firstrate"),
  through,
  true,
  () => {
    throw Error("Network prohibited");
  },
  () => asOf,
);
assert.ok(official);
const qqq = {
  sampleVsAuctionBps: errorBps(kept(files, through).bars.QQQ.close, official.officialClose),
  signedHourlyVsAuctionBps: errorBps(kept(signedReferences.QQQ, through).close, official.officialClose),
  shares: official.crossShares,
  officialSources: [official.nocp.sha256, official.cross.sha256],
  status: "retained-qualification-only",
};

const crossDir = resolve(host, ".consensus/private-nasdaq-crosses");
const tape = await receipt(
  resolve(crossDir, short + "-e965ea6f9779.json"),
  "2cc16cfd6ff2b5f8051384488352a7c6df2350e6f47acb23dca79ae8d0f0d485",
);
const crossStats = await receipt(
  resolve(crossDir, "crossstats-" + short + ".json"),
  "d433fd0cbb8d8133fe1ca47c488e26d9c31edce442adf16f82c014654c27596c",
);
const independent = await receipt(
  resolve(crossDir, "review-" + short + ".json"),
  "bf63d7b615aa1c42e8e15ecf95a49acaa50f45077d4e5afc85a464b00d1a3e19",
);
assert.equal(tape.sha256, independent.archiveSha256);
assert.equal(crossStats.sha256, independent.crossStatsSha256);
assert.equal(tape.day, short);
assert.equal(extendedResearchSession(short).closeAt, "2025-11-28T18:00:00.000Z");
assert.deepEqual(
  tape.comparison.map((row) => row.symbol),
  ["QQQ", "TLT"],
);
const shortAuctions = tape.comparison.map((row) => {
  const counts = crossStats.rows.find((s) => s.instrument === row.symbol);
  assert.equal(row.open.type, "O");
  assert.equal(row.close.type, "C");
  assert.equal(row.brokenCrosses, 0);
  assert.ok(
    row.listing.market === "G" &&
      counts.openShares === Number(row.open.shares) &&
      counts.closeShares === Number(row.close.shares),
  );
  const qual = independent.check.find((s) => s.symbol === row.symbol);
  assert.ok(
    qual.auctionVolumeMatches === 2 &&
      qual.secLevel1CloseMatches > 0 &&
      qual.openDelayMs >= 0 &&
      qual.openDelayMs < 1000 &&
      qual.closeDelayMs >= 0 &&
      qual.closeDelayMs < 1000,
  );
  return {
    symbol: row.symbol,
    ...comparison(half.bars[row.symbol], { open: row.open.price, close: row.close.price }),
  };
});
const arca = await receipt(
  resolve(host, ".consensus/private-early-close-review/cta-" + short + ".json"),
  "9a0c3c2dd8cb8507577e66445802b2480bb6a9111dabe058a1c2cd6bd1a8cdd1",
);
assert.equal(arca.scope, "private-price-reconciliation");
assert.equal(arca.basis, "as-traded-primary-listing-participant-eod-summary");
assert.equal(arca.source, "https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.20251128.csv");
assert.equal(arca.sha256, "ac07349bbba51c210c779bbf4594befab3d5965c0c6add3addbc56000bdf1639");
assert.deepEqual(
  arca.rows.map((row) => row.symbol),
  ["SPY", "IWM", "DIA"],
);
const arcaSummary = arca.rows.map((row) => {
  const clock = extendedResearchSession(short);
  assert.ok(
    row.session === short &&
      row.openAt === clock.openAt &&
      row.closeAt === clock.closeAt &&
      row.summaryAt >= clock.closeAt,
  );
  return { symbol: row.symbol, ...comparison(half.bars[row.symbol], row) };
});
const halfGuest = ETF_SYMBOLS.map((symbol) => ({
  symbol,
  ...comparison(half.bars[symbol], kept(kibot[symbol][2025], short)),
}));
const publicRawBars = 0,
  productionSettlements = 0;
console.log(
  JSON.stringify(
    {
      scope: "private-evaluation-of-samples",
      asOfIndependentControls: asOf,
      latestPreviewReceiptAt,
      evaluationPreviewDays: previews.map((row) => row.session),
      previewSourceSeals: previews.map((row) => row.sha256),
      existingArchiveDays: archive.length,
      first,
      through,
      ordinarySessions: days.length,
      ordinaryFundSessions: days.length * ETF_SYMBOLS.length,
      passes: report.symbols.reduce((n, f) => n + f.matched.length, 0),
      exceptions,
      alternateKibotGuestOverlap: {
        tested: overlaps.length,
        matches: overlaps.filter((r) => r.pass).length,
        failures: overlaps.filter((r) => !r.pass),
      },
      signedControls: {
        sessions: signedDays.length,
        passes: signedReport.symbols.reduce((n, f) => n + f.matched.length, 0),
        from,
        through,
        boundaries: signedReport.symbols.flatMap((f) =>
          f.boundaries.map((boundary) => ({ symbol: f.symbol, ...boundary })),
        ),
        actionProofs,
      },
      matchedAllFiveDates: days.filter((day) => report.symbols.every((row) => row.matched.includes(day))),
      nativeHorizonFailure,
      horizons,
      tltExDate: { boundary, issuerAndPrimaryAction: true, cash: cash.amount, ...precise.bps },
      qqq,
      shortSession: {
        day: short,
        guest: halfGuest,
        nasdaqExecutedCrosses: shortAuctions,
        arcaClosingParticipant: arcaSummary,
      },
      publicRawBars,
      productionSettlements,
    },
    null,
    2,
  ),
);
