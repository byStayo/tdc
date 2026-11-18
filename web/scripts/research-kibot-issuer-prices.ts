import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import type { CashDistribution } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeCalendarVersion, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { kibotIssuerCollectionStart, reviewIssuerBoundaries, scorePriceSensitivity } from "../lib/consensus/kibot-issuer-review.ts";
import { ETF_SYMBOLS, MARKETPARQUET_SOURCE, reviewedMarketParquetDays, type MarketParquetDay } from "../lib/consensus/marketparquet.ts";

type Symbol = typeof ETF_SYMBOLS[number];
type Issuer = { symbol: Symbol; source: string; sha256: string; cash: CashDistribution[] };
type FileProof = Pick<MarketParquetDay, "session" | "sha256">;
type SampleLedger = { schemaVersion: 1; capturedAt: string; bars: MarketParquetDay[]; distributions: Issuer[] };
type EvaluationManifest = { schemaVersion: 1; source: string; evaluatedAt: string; inputs: {
  mode: string; calendar: string; sameRunSessions: string[]; files: FileProof[]; issuers: Pick<Issuer, "symbol" | "sha256">[];
} };

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-marketparquet");
const ledgerPath = resolve(directory, "sample.json");
const manifestPath = resolve(directory, "sample-evaluation.json");
const evidencePath = resolve(directory, "kibot-issuer-review.json");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

function readProvenance(ledger: SampleLedger, manifest: EvaluationManifest) {
  const inputs = manifest.inputs;
  if (ledger.schemaVersion !== 1 || manifest.schemaVersion !== 1 || manifest.source !== MARKETPARQUET_SOURCE ||
      inputs?.mode !== "sample" ||
      !Array.isArray(ledger.bars) || !ledger.bars.length || !Array.isArray(ledger.distributions) ||
      !Array.isArray(inputs.files) || !Array.isArray(inputs.sameRunSessions) || !Array.isArray(inputs.issuers))
    throw new Error("Missing private sample provenance");
  const files = ledger.bars;
  if (inputs.calendar !== exchangeCalendarVersion(files[0].session, files.at(-1)!.session))
    throw new Error("Sample calendar differs from the official dates covered by the ledger");
  const byDate = new Map(files.map(file => [file.session, file.sha256]));
  const manifestFiles = new Map(inputs.files.map(file => [file.session, file.sha256]));
  const sameRun = new Set(inputs.sameRunSessions);
  const normal = reviewedMarketParquetDays(files, []);
  if (byDate.size !== files.length || files.some((file, i) => !validHash(file.sha256) ||
      (i > 0 && file.session <= files[i - 1].session)) ||
      manifestFiles.size !== inputs.files.length ||
      inputs.files.some(file => byDate.get(file.session) !== file.sha256) ||
      normal.some(file => manifestFiles.get(file.session) !== file.sha256) ||
      sameRun.size !== inputs.sameRunSessions.length ||
      inputs.sameRunSessions.some(day => !manifestFiles.has(day)))
    throw new Error("The sample manifest does not identify the ledger's captured or cached files");
  if (ledger.distributions.length !== ETF_SYMBOLS.length || inputs.issuers.length !== ETF_SYMBOLS.length ||
      ETF_SYMBOLS.some(symbol => {
        const issuer = ledger.distributions.find(row => row.symbol === symbol);
        return !issuer || !validHash(issuer.sha256) || !Array.isArray(issuer.cash) ||
          !inputs.issuers.some(row => row.symbol === symbol && row.sha256 === issuer.sha256);
      }))
    throw new Error("Issuer history differs from the private sample manifest");
  return { files, sameRunSessions: inputs.sameRunSessions };
}

let stage = "checking command arguments";
async function main() {
  if (process.argv.length !== 2) throw new Error("The private sample review takes no arguments");
  const now = new Date().toISOString();
  stage = "verifying private sample and edition inputs";
  const [ledgerText, manifestText, { history, snapshots }] = await Promise.all([
    readFile(ledgerPath, "utf8"), readFile(manifestPath, "utf8"), verifyPublicationTree(root),
  ]);
  const ledger = JSON.parse(ledgerText) as SampleLedger;
  const manifest = JSON.parse(manifestText) as EvaluationManifest;
  const { files, sameRunSessions } = readProvenance(ledger, manifest);
  const through = files.at(-1)!.session;
  const finalClose = Date.parse(exchangeSession(through)!.closeAt);
  const captured = Date.parse(ledger.capturedAt);
  if (!Number.isFinite(captured) || captured < finalClose || captured > Date.parse(now))
    throw new Error("Sample was not captured after its final close");
  const cash = Object.fromEntries(ledger.distributions.map(issuer => [issuer.symbol, issuer.cash])) as
    Parameters<typeof kibotIssuerCollectionStart>[0];
  const from = kibotIssuerCollectionStart(cash, through);
  // Noon UTC the following calendar day bounds Kibot's completed-session
  // query to the exact end date of this sample even on later reruns.
  const cutoff = new Date(Date.parse(through) + 36 * 3600000).toISOString();

  stage = "collecting the two Kibot guest price bases";
  const [raw, advertised] = await Promise.all([
    collectKibotPrices(from, cutoff, fetch, true),
    collectKibotPrices(from, cutoff),
  ]);
  if (raw.through !== through || advertised.through !== through)
    throw new Error("Kibot collection does not end at the sample cutoff");

  stage = "comparing issuer adjustments and matched session labels";
  const boundaries = reviewIssuerBoundaries(raw.evidence, advertised.evidence, cash);
  const sensitivity = scorePriceSensitivity({ snapshots, files, cash, raw: raw.evidence, sameRunSessions, now });
  const ledgerSha256 = hash(ledgerText), manifestSha256 = hash(manifestText);
  const evidence = {
    schemaVersion: 1, purpose: "internal-price-sensitivity", evaluatedAt: now,
    archive: { calendar: manifest.inputs.calendar, sha256: digest(history), editions: history.length },
    marketParquet: { source: MARKETPARQUET_SOURCE, mode: "sample", ledgerSha256, manifestSha256,
      capturedAt: ledger.capturedAt, manifestEvaluatedAt: manifest.evaluatedAt,
      files: files.map(({ session, sha256 }) => ({
        session, sha256, capture: sameRunSessions.includes(session) ? "same-run" : "cached",
      })),
      issuers: ledger.distributions.map(({ symbol, source, sha256 }) => ({ symbol, source, sha256 })),
    },
    kibot: { access: "guest", from, through,
      raw: { source: raw.evidence[0].source, hashes: raw.hashes },
      advertised: { source: advertised.evidence[0].source, hashes: advertised.hashes } },
    issuerBoundaries: boundaries,
    sensitivity,
  };

  stage = "saving private research evidence";
  const release = await acquirePublicationLock(root, "private-kibot-issuer-research");
  let failure: { error: unknown } | undefined;
  try {
    const [currentLedger, currentManifest] = await Promise.all([readFile(ledgerPath, "utf8"), readFile(manifestPath, "utf8")]);
    if (hash(currentLedger) !== ledgerSha256 || hash(currentManifest) !== manifestSha256)
      throw new Error("The captured sample changed during the research run");
    await durableJSON(evidencePath, evidence);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }

  const rounded = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;
  const summarize = ({ selected, labelDisagreements, meanAbsReturnErrorBps, maxAbsReturnErrorBps }:
    typeof sensitivity.cohorts.daily) =>
    ({ selected, labelDisagreements, meanAbsReturnErrorBps: rounded(meanAbsReturnErrorBps),
      maxAbsReturnErrorBps: rounded(maxAbsReturnErrorBps) });
  console.log(JSON.stringify({
    matchedSessions: sensitivity.matchedSessions.length,
    sameRunSessions: sensitivity.matchedSessions.filter(row => row.capture === "same-run").length,
    cachedSessions: sensitivity.matchedSessions.filter(row => row.capture === "cached").length,
    issuerBoundaries: { compared: boundaries.length, symbols: new Set(boundaries.map(row => row.symbol)).size,
      matching: boundaries.filter(row => row.status === "matches-issuer").length,
      missing: boundaries.filter(row => row.status === "missing").length,
      different: boundaries.filter(row => row.status === "different").length },
    cohorts: Object.fromEntries(Object.entries(sensitivity.cohorts).map(([horizon, row]) => [
      horizon, { ...summarize(row), sameRun: row.byCapture["same-run"].selected,
        cached: row.byCapture.cached.selected, mixed: row.byCapture.mixed.selected },
    ])),
  }));
}

main().catch(() => {
  // Raw response bodies, request URLs and private inputs can appear in errors.
  console.error("Private Kibot issuer review failed while " + stage + ".");
  process.exitCode = 1;
});
