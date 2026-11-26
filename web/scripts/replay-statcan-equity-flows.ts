import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { METHOD, LAST_TARGET, flowTargets, fxChange, parseEcbChunk, mergeEcbChunks, joinEcbLegs,
  type Flow, type EcbPoint } from "../lib/consensus/canada-equity-flow-research.ts";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { treasuryYieldPoints } from "../lib/consensus/fed-market-data.ts";
import { chronologicalSplit, brierScore, predict, type LogisticModel, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices } from "../lib/consensus/research-price-capture.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_MANIFEST = "f952e3293afd1af56948934c8f5ac55341246e03884168c6d320b1ff354366a6";
const EXPECTED_FROZEN = "6e4c905e16c774bc35bcc39e9e07dd8858f92d4c3fc960e3585c2d3dc5e3c2da";
const EXPECTED_RESULT = "cd143b969bd9ef2cca649ee9c76a21cbe834b9e7e55d71156ccd075f9f2208ed";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
type FileProof = { file: string; fileSha256: string };
type PriceProof = FileProof & { sourceSha256: string; priceDigest: string; from: string; through: string; instrument: string };
type RateProof = FileProof & { year: number; source: string; sourceSha256: string };
type FxProof = FileProof & { currency: "USD" | "CAD"; from: string; through: string; source: string; sourceSha256: string };
type Manifest = { schemaVersion: number; method: string; frozen: FileProof; source: FileProof; result: FileProof;
  inputs: FileProof; marker: FileProof; ecbCanonical: FileProof; launchIndex: FileProof;
  prices: PriceProof[]; treasury: RateProof[]; ecb: FxProof[] };
type Evaluation = { status: "evaluated"; datasetHash: string; model: LogisticModel;
  split: { train: number; validation: number; test: number; trainEnds: string; testStarts: string; testEnds: string };
  candidateBrier: number; baseRateBrier: number; coinBrier: number };
type Result = { method: string; before: string; preregistrationSha256: string; sourceSha256: string;
  baseline: Evaluation; candidate: Evaluation; summary: { clearsHistoricalResearchMargin: boolean; [key: string]: unknown } };

async function checkedBytes(root: string, proof: FileProof) {
  const path = resolve(root, proof.file);
  if (isAbsolute(proof.file) || !path.startsWith(root + sep) || proof.file.split(/[\\/]/).includes(".."))
    throw new Error("Replay paths must remain within the private bundle");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || !stat.size || stat.size > 4_000_000)
    throw new Error("Replay requires bounded owner-only immutable files");
  const bytes = await readFile(path);
  if (sha(bytes) !== proof.fileSha256) throw new Error(`Private replay file differs: ${proof.file}`);
  return bytes;
}
const same = (actual: unknown, expected: unknown, label: string) => {
  if (digest(actual) !== digest(expected)) throw new Error(`Replay differs: ${label}`);
};
const close = (actual: number, expected: number, label: string) => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-12) throw new Error(`Replay differs: ${label}`);
};

async function run() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--private-root"))
    throw new Error("Only --private-root is accepted; the experiment cannot be reconfigured");
  const root = resolve(args[1] ?? resolve(web, ".consensus/private-canada-equity-flows"));
  const manifest = JSON.parse((await checkedBytes(root, { file: "replay-manifest-v1.json", fileSha256: EXPECTED_MANIFEST })).toString()) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.method !== METHOD || manifest.frozen.fileSha256 !== EXPECTED_FROZEN ||
      manifest.result.fileSha256 !== EXPECTED_RESULT || manifest.prices.length !== 11 || manifest.treasury.length !== 11 || manifest.ecb.length !== 22)
    throw new Error("Expected the sealed historical experiment and matching control bundle");
  await checkedBytes(root, manifest.frozen);
  const sourceBytes = await checkedBytes(root, manifest.source);
  const source = JSON.parse(sourceBytes.toString()) as { rows: Flow[]; summary: { sourceGate: boolean } };
  const result = JSON.parse((await checkedBytes(root, manifest.result)).toString()) as Result;
  const inputs = JSON.parse((await checkedBytes(root, manifest.inputs)).toString()) as { pairs: { row: TrainingRow }[]; before: string; sourceSha256: string; launchIndexSha256: string };
  const marker = JSON.parse((await checkedBytes(root, manifest.marker)).toString()) as { datasetHash: string };
  const originalFX = JSON.parse((await checkedBytes(root, manifest.ecbCanonical)).toString()) as {
    canonical: { joinedSha256: string; usdSha256: string; cadSha256: string; rows: number; overlaps: { USD: number; CAD: number } };
  };
  const launchBytes = await checkedBytes(root, manifest.launchIndex);
  const launch = JSON.parse(launchBytes.toString()) as { issuedAt: string }[];
  if (result.method !== METHOD || result.preregistrationSha256 !== EXPECTED_FROZEN || !source.summary.sourceGate || source.rows.length !== 126 ||
      result.sourceSha256 !== sha(sourceBytes) || inputs.sourceSha256 !== sha(sourceBytes) || inputs.before !== result.before ||
      sha(launchBytes) !== inputs.launchIndexSha256 || launch[0]?.issuedAt !== result.before ||
      extendedResearchSession(LAST_TARGET)!.closeAt >= result.before)
    throw new Error("Frozen source, input or launch boundary differs");
  // The source collector's cached-only path verifies every original HTML/table byte and measured field.
  execFileSync("python3", ["-B", resolve(web, "scripts/collect-statcan-equity-flows.py"), "--cached-only", "--private-root", root],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 20_000 });

  const yields = new Map<string, number>();
  for (const proof of manifest.treasury) {
    const capture = JSON.parse((await checkedBytes(root, proof)).toString()) as { source: string; sha256: string; body?: string; xml?: string };
    const body = capture.body ?? capture.xml;
    if (!body || capture.source !== proof.source || capture.sha256 !== proof.sourceSha256 || sha(body) !== proof.sourceSha256)
      throw new Error("Treasury control source differs");
    for (const point of treasuryYieldPoints(body, proof.year, `${proof.year}-12-31`).DGS10) yields.set(point.date, point.value);
  }
  const legs: Record<"USD" | "CAD", EcbPoint[][]> = { USD: [], CAD: [] };
  for (const proof of manifest.ecb) {
    const capture = JSON.parse((await checkedBytes(root, proof)).toString()) as { source: string; sha256: string; body?: string; text?: string };
    const body = capture.body ?? capture.text;
    if (!body || capture.source !== proof.source || capture.sha256 !== proof.sourceSha256 || sha(body) !== proof.sourceSha256)
      throw new Error("ECB control source differs");
    const expected = `https://data-api.ecb.europa.eu/service/data/EXR/D.${proof.currency}.EUR.SP00.A?startPeriod=${proof.from}&endPeriod=${proof.through}&format=csvdata`;
    if (proof.source !== expected) throw new Error("ECB control series or date range differs");
    legs[proof.currency].push(parseEcbChunk(body, proof.currency, proof.from, proof.through));
  }
  const usd = mergeEcbChunks(legs.USD), cad = mergeEcbChunks(legs.CAD), fixes = joinEcbLegs(usd.points, cad.points);
  same(digest(usd.points), originalFX.canonical.usdSha256, "canonical USD points");
  same(digest(cad.points), originalFX.canonical.cadSha256, "canonical CAD points");
  same(digest(fixes), originalFX.canonical.joinedSha256, "canonical currency join");
  same({ USD: usd.overlapRows, CAD: cad.overlapRows }, originalFX.canonical.overlaps, "FX overlaps");
  if (fixes.length !== originalFX.canonical.rows) throw new Error("ECB row count differs");

  for (const proof of manifest.prices) await checkedBytes(root, proof);
  const receipts = await collectResearchPrices(resolve(root, "prices"), "SPY",
    extendedResearchSessions("2016-01-01", LAST_TARGET), { cachedOnly: true });
  receipts.forEach((receipt, i) => {
    const proof = manifest.prices[i];
    if (receipt.sha256 !== proof.sourceSha256 || receipt.priceDigest !== proof.priceDigest || receipt.from !== proof.from || receipt.through !== proof.through)
      throw new Error("Private price control differs");
  });
  const bars = new Map(receipts.flatMap(receipt => receipt.sessions.map(bar => [bar.session, bar] as const)));
  const targets = flowTargets(source.rows);
  if (targets.skips.length || targets.rows.length !== 126) throw new Error("Frozen calendar cohort differs");
  const rows: TrainingRow[] = targets.rows.map(signal => {
    const label = bars.get(signal.target), prior = bars.get(signal.preceding), fx = fxChange(fixes, signal.target);
    const latestYield = yields.get(signal.preceding), earlierYield = yields.get(signal.earlier);
    if (!label || !prior || !fx || latestYield === undefined || earlierYield === undefined || prior.closeAt >= signal.issuedAt ||
        signal.availableAt >= signal.issuedAt || signal.issuedAt >= label.openAt || label.closeAt >= result.before)
      throw new Error("Missing or mistimed private replay evidence");
    return { id: `SPY:${signal.target}`, engineVersion: METHOD, issuedAt: signal.issuedAt, labelKnownAt: label.closeAt,
      features: [Math.log(prior.close / prior.open), (latestYield - earlierYield) * 100, fx.value, signal.featureCadBillions],
      up: label.close > label.open ? 1 : 0 };
  });
  same(rows, inputs.pairs.map(pair => pair.row), "126 original training rows");
  same(digest(rows), marker.datasetHash, "sealed dataset");
  same(digest(rows), result.candidate.datasetHash, "candidate dataset");
  same(digest(rows.map(row => ({ ...row, features: row.features.slice(0, 3) }))), result.baseline.datasetHash, "controls dataset");
  const split = chronologicalSplit(rows), baselineTest = split.test.map(row => ({ ...row, features: row.features.slice(0, 3) }));
  const rate = split.train.reduce((sum, row) => sum + row.up, 0) / split.train.length;
  const candidateBrier = brierScore(split.test, row => predict(result.candidate.model, row.features));
  const baselineBrier = brierScore(baselineTest, row => predict(result.baseline.model, row.features));
  const baseRateBrier = brierScore(split.test, () => rate), coinBrier = brierScore(split.test, () => 0.5);
  close(candidateBrier, result.candidate.candidateBrier, "stored candidate predictions");
  close(baselineBrier, result.baseline.candidateBrier, "stored control predictions");
  close(baseRateBrier, result.candidate.baseRateBrier, "training base rate");
  close(coinBrier, result.candidate.coinBrier, "coin control");
  const gate = candidateBrier < Math.min(baselineBrier, baseRateBrier, coinBrier) - 0.01 && result.candidate.model.weights[3] > 0;
  same(gate, result.summary.clearsHistoricalResearchMargin, "fixed gate");
  console.log(JSON.stringify({ status: "verified_private_replay", vendorRequests: 0, modelsFitted: 0,
    datasetSha256: digest(rows), canonicalFXSha256: digest(fixes), sourceRows: rows.length,
    split: { train: split.train.length, validation: split.validation.length, test: split.test.length }, summary: result.summary }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
