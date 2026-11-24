import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession } from "../lib/consensus/kibot.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const here = fileURLToPath(new URL("../", import.meta.url));
const method = "prelaunch-ofr-international-stress-dia-v1-witnessed-maturity";
const before = "2026-11-03T06:28:30.460Z";
const sourceSHA = "a842d6890ccba86bcbf33b5a0125c458c8ed067192cbd4ca45c80e47afb74335";
const priorSHA = "39c14be4941b6cac590a4a106a430ce1d1706a7eb74837bd1805db036a68b1b0";
const policySHA = "5c69e67e38cd74afb1b6b1af9388d88e0f4c11a76a757fe3df6772e74825e584";
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

interface Qualified {
  session: string;
  economic: string;
  publishedBy: string;
  issue: string;
  source: string;
  sha256: string;
  maturityDate?: string;
  features: [number, number];
}
interface Inventory {
  rows: Qualified[];
  policySHA256: string;
  priorSelectionSHA256?: string;
  summary: { distinctTargets: number; sourceFloorMet: boolean; matchedEconomicDates: number; conflictingDates: string[] };
}
export async function readRegionalCohort(source: string) {
  const readPinned = async (name: string, sha: string) => {
    const path = resolve(source, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.mode & 0o077 || !stat.size || stat.size > 350_000)
      throw new Error("Expected a bounded owner-only regional source receipt");
    const encoded = await readFile(path);
    if (hash(encoded) !== sha) throw new Error("Regional source selection differs from its pre-outcome hash");
    return JSON.parse(encoded.toString("utf8")) as Inventory;
  };
  const [base, selected] = await Promise.all([
    readPinned("supplement-final-selection.json", priorSHA), readPinned("maturity-source.json", sourceSHA),
  ]);
  if (base.rows.length !== 109 || selected.policySHA256 !== policySHA || selected.priorSelectionSHA256 !== priorSHA ||
      !selected.summary.sourceFloorMet || selected.summary.distinctTargets !== 147 || selected.rows.length !== 147 ||
      selected.summary.matchedEconomicDates !== 40 || selected.summary.conflictingDates.length)
    throw new Error("Original geographic source, agreement or sample floor differs");
  const byDay = new Map(selected.rows.map(row => [row.session, row]));
  if (byDay.size !== selected.rows.length || new Set(selected.rows.map(row => row.economic)).size !== selected.rows.length ||
      base.rows.some(row => !isDeepStrictEqual(byDay.get(row.session), row)))
    throw new Error("A sealed older target or economic observation has been repurposed");
  const added = selected.rows.filter(row => row.maturityDate);
  if (added.length !== 38 || added.some(row => !row.source.startsWith("native-")))
    throw new Error("Supplemental targets must be genuinely new, physically witnessed Treasury measurements");
  for (const [i, row] of selected.rows.entries()) {
    const clock = extendedResearchSession(row.session);
    const cutoff = newYorkTimestamp(row.session.replaceAll("-", "") + "T074800");
    if (!clock || !cutoff || cutoff !== row.issue || Date.parse(row.publishedBy) >= Date.parse(cutoff) ||
        cutoff >= clock.openAt || clock.closeAt >= before || !isFullKibotSession(clock.openAt, clock.closeAt) ||
        !row.features.every(Number.isFinite) || row.features.length !== 2 || (i > 0 && selected.rows[i - 1].session >= row.session))
      throw new Error("Geographic source, availability or ordinary exchange-session cutoff differs");
  }
  return selected;
}

/** Frozen descriptive moving-block interval and study-family adjustment. */
export function regionalUncertainty(differences: number[]) {
  if (differences.length !== 30 || differences.some(d => !Number.isFinite(d) || Math.abs(d) > 1))
    throw new Error("Expected the registered thirty paired test losses");
  const blockLength = 3, n = differences.length, resamples = 10000;
  const observed = differences.reduce((total, d) => total + d, 0);
  const bootstrap: number[] = [];
  let seed = parseInt("e6248d83", 16);
  for (let i = 0; i < resamples; i++) {
    let total = 0;
    for (let used = 0; used < n; used += blockLength) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const start = Math.floor(seed / 4294967296 * (n - blockLength + 1));
      for (let offset = 0; offset < blockLength; offset++) total += differences[start + offset];
    }
    bootstrap.push(total / n);
  }
  bootstrap.sort((a, b) => a - b);
  // Paired, disjoint blocks of 3 research targets. Conditional on equiprobable
  // block signs, enumerate all signs. Serial dependence beyond 3 may remain.
  const blockSums: number[] = [];
  for (let i = 0; i < n; i += blockLength)
    blockSums.push(differences.slice(i, i + blockLength).reduce((sum, x) => sum + x, 0));
  const permutations = 2 ** blockSums.length;
  let atLeastObserved = 0;
  for (let mask = 0; mask < permutations; mask++) {
    const score = blockSums.reduce((sum, v, i) => sum + ((mask & (1 << i)) ? -v : v), 0);
    if (score >= observed - 1e-12) atLeastObserved++;
  }
  const oneSidedP = atLeastObserved / permutations;
  return { improvement: observed / n, lower: bootstrap[249], upper: bootstrap[9749], blockLength, resamples,
    permutations, oneSidedP, bonferroni96P: Math.min(1, 96 * oneSidedP) };
}

interface FreezeManifest {
  method: string;
  selectedSHA256: string;
  approvedThrough: string;
  sourceCodeSHA256: Record<string, string>;
  sample: { train: number; validation: number; test: number; testStarts: string; testEnds: string };
  correction: { studySlots: number; comparisons: number; familySize: number };
}

/** The stored code hashes bind both data acquisition dates and every statistical choice before labels. */
async function verifyScoringFreeze() {
  const manifest: FreezeManifest = JSON.parse(await readFile(resolve(here, "scripts/ofr-geographic-scoring-lock.json"), "utf8"));
  if (manifest.method !== method || manifest.selectedSHA256 !== sourceSHA || manifest.approvedThrough !== before ||
      manifest.correction.studySlots !== 32 || manifest.correction.comparisons !== 3 || manifest.correction.familySize !== 96 ||
      manifest.sample.train !== 88 || manifest.sample.validation !== 29 || manifest.sample.test !== 30 ||
      manifest.sample.testStarts !== "2026-09-21" || manifest.sample.testEnds !== "2026-11-02")
    throw new Error("Historical comparison, adjustment or anonymous outcome window differs from preregistration");
  for (const name of ["scripts/research-ofr-geographic.ts", "scripts/qualify-ofr-geographic.py",
    "scripts/collect-ofr-geographic-archives.py", "scripts/verify-ofr-volatility-vintages.py", "lib/consensus/learning.ts",
    "lib/consensus/model.ts", "lib/consensus/extended-research-calendar.ts", "lib/consensus/research-price-capture.ts"]) {
    if (hash(await readFile(resolve(here, name))) !== manifest.sourceCodeSHA256[name])
      throw new Error("Preregistered implementation differs in " + name);
  }
}

export async function evaluateRegionalResearch(ownerRoot: string, controlsRoot: string) {
  await verifyScoringFreeze();
  const source = await readRegionalCohort(ownerRoot);
  const boundaries = [source.rows[0].session, source.rows[87].session, source.rows[88].session, source.rows[116].session,
    source.rows[117].session, source.rows[146].session];
  if (boundaries.join(",") !== "2019-01-11,2026-08-07,2026-08-10,2026-09-18,2026-09-21,2026-11-02")
    throw new Error("Research windows differ before reading any prices");
  const edition = (await verifyPublicationTree(here)).history[0].issuedAt;
  if (edition !== before) throw new Error("First prospective issue differs from the preregistered bound");
  const rawOutcomes = new Map<string, number>();
  const sourceHashes: { file: string; sha256: string; native: string }[] = [];
  for (const year of new Set(source.rows.map(row => row.session.slice(0, 4)))) {
    const through = year === "2026" ? "2026-11-02" : year + "-12-31";
    const days = extendedResearchSessions(year + "-01-01", through);
    const where = resolve(controlsRoot, Number(year) < 2022 ? "private-ft900" : "private-technical-momentum");
    const files = await Promise.all([false, true].map(splitAdjusted =>
      collectResearchPrices(where, "DIA", days, { cachedOnly: true, splitAdjusted })));
    for (const [index, [file]] of files.entries()) {
      const basename = `DIA-${year}-${file.from}-${file.through}-${index ? "splits" : "raw"}.json`;
      sourceHashes.push({ file: basename, sha256: hash(await readFile(resolve(where, basename))), native: file.sha256 });
    }
    const targetDays = new Set(source.rows.filter(row => row.session.startsWith(year)).map(row => row.session));
    for (const [i, raw] of files[0][0].sessions.entries()) {
      if (!targetDays.has(raw.session)) continue;
      const adjusted = files[1][0].sessions[i], clock = extendedResearchSession(raw.session);
      if (!clock || !adjusted || adjusted.session !== raw.session || adjusted.openAt !== raw.openAt ||
          adjusted.closeAt !== raw.closeAt || raw.openAt !== clock.openAt || raw.closeAt !== clock.closeAt ||
          raw.closeAt >= before || Math.sign(raw.close - raw.open) !== Math.sign(adjusted.close - adjusted.open))
        throw new Error("A registered DIA target lacks an agreeing ordinary-session economic direction");
      rawOutcomes.set(raw.session, raw.close > raw.open ? 1 : 0);
    }
  }
  const rows: TrainingRow[] = source.rows.map(row => {
    const up = rawOutcomes.get(row.session);
    if (up !== 0 && up !== 1) throw new Error("Registered sample contains a missing DIA label");
    return { id: "DIA:" + row.session, engineVersion: method, issuedAt: row.issue,
      labelKnownAt: extendedResearchSession(row.session)!.closeAt, features: row.features, up };
  });
  const single = rows.map(row => ({ ...row, features: [row.features[0]] }));
  const splits = chronologicalSplit(rows);
  if (splits.train.length !== 88 || splits.validation.length !== 29 || splits.test.length !== 30 ||
      splits.test[0].id !== "DIA:2026-09-21" || splits.test.at(-1)!.id !== "DIA:2026-11-02")
    throw new Error("Source selection or purge differs from the pre-outcome chronological cohorts");
  const model = trainCandidate(rows, before), control = trainCandidate(single, before);
  if (model.status !== "evaluated" || control.status !== "evaluated") throw new Error("Historical row gates did not clear");
  const trainingBase = splits.train.reduce((sum, row) => sum + row.up, 0) / splits.train.length;
  const gains = (baseline: (r: TrainingRow) => number) => splits.test.map(r => {
    const candidateError = (predict(model.model, r.features) - r.up) ** 2;
    return (baseline(r) - r.up) ** 2 - candidateError;
  });
  const intervals = { usStressOnly: regionalUncertainty(gains(r => predict(control.model, [r.features[0]]))),
    trainingBase: regionalUncertainty(gains(() => trainingBase)), coin: regionalUncertainty(gains(() => 0.5)) };
  if (Math.abs(intervals.usStressOnly.improvement - (control.candidateBrier - model.candidateBrier)) > 1e-12)
    throw new Error("Paired improvements disagree with the fitted scores");
  const passesEconomicGate = model.promoted && model.model.weights[1] > 0 &&
    model.candidateBrier < control.candidateBrier - 0.01;
  return { method, before, sourceSHA, priorSHA, policySHA, sourceHashes, samples: rows.length, split: model.split,
    sourceCounts: { originalTargetsRetained: 109, originallyWitnessedNew: 38, treasuryNative: 110, timestampedMirror: 37 },
    combinedHash: model.datasetHash, controlHash: control.datasetHash, combinedBrier: model.candidateBrier,
    controlBrier: control.candidateBrier, trainingBaseBrier: model.baseRateBrier, coinBrier: model.coinBrier,
    coefficient: model.model.weights[1], passesEconomicGate, intervals,
    allAdjustedComparisonsClear: Object.values(intervals).every(r => r.bonferroni96P < 0.05) };
}

async function main() {
  const [ownerRoot, controlsRoot, option] = process.argv.slice(2);
  if (!ownerRoot || !controlsRoot || !["--score-once", "--replay"].includes(option) || process.argv.length !== 5)
    throw Error("Usage: research-ofr-geographic.ts PRIVATE_STUDY_DIR PRIVATE_RESEARCH_PARENT --score-once|--replay");
  const filename = resolve(ownerRoot, "result.json");
  const saved = await readResearchReceipt<Awaited<ReturnType<typeof evaluateRegionalResearch>>>(filename);
  if (option === "--replay" ? !saved : saved) throw Error("Use the existing sealed result for replay, or score exactly once");
  const result = await evaluateRegionalResearch(ownerRoot, controlsRoot);
  if (saved) {
    if (!isDeepStrictEqual(result, saved)) throw new Error("Offline scoring receipt differs from the sealed first result");
  } else {
    await writeFile(filename, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  const { sourceHashes, ...summary } = result;
  console.log(JSON.stringify({ ...summary, privateReferenceFiles: sourceHashes.length }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
