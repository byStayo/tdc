import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableJSON } from "../lib/publication-storage.ts";
import { extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { G17_MANUFACTURING_RESEARCH, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt, type ResearchPriceReceipt } from "../lib/consensus/research-price-capture.ts";
import { technicalMomentumRows } from "./research-technical-momentum.ts";

const web = resolve(fileURLToPath(new URL("..", import.meta.url)));
const study = G17_MANUFACTURING_RESEARCH.id;
const registration = "f689c4113b3dd75c31656e05e84976191801eeea9be2e0892060927c7c8603eb";
const featureSeal = "120be9635947ed2f4d91ac09245d27f5faabcfbbdeecc8527885155101efaa15";
const before = "2026-11-03T06:28:30.460Z";
const checkedFt900 = "6a3d43e6a7dd4c06a512d94dfb31eb211c7a6c34d1d09b4d484e2cc68b87ff41";
const checkedTechnicals = "a84932843678688d749936b1952c41f215ca19c1cb8af751e194e54cdcfb4b65";
type Feature = { target: string; period: string; releaseAt: string; openAt: string; closeAt: string;
  decision: string; candidate: number; control: number };
type PriorResearch = { before: string; prices: { raw: string[]; splits: string[] }; pairs: { training: { id: string } }[] };
type EarlierTechnicals = { before: string; cohorts: { instrument: string; candidate: { samples: number }; raw: string[]; splitOnly: string[] }[] };
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

async function original<T>(file: string, expected: string): Promise<T> {
  const body = await readFile(file);
  if (sha(body) !== expected) throw Error("Private research seal differs: " + file);
  return JSON.parse(body.toString("utf8")) as T;
}

function interval(differences: number[]): [number, number] {
  let state = parseInt(registration.slice(0, 8), 16);
  const means: number[] = [];
  for (let sample = 0; sample < 10000; sample++) {
    let sum = 0;
    let count = 0;
    while (count < differences.length) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const index = Math.floor(state / 4294967296 * (differences.length - 2));
      for (let offset = 0; offset < 3 && count < differences.length; offset++, count++) sum += differences[index + offset];
    }
    means.push(sum / differences.length);
  }
  means.sort((a, b) => a - b);
  return [means[249], means[9749]];
}

export async function replayG17(directory: string, researchWeb: string, seal = false) {
  // Re-read every Board original. Only after reproducing the feature-only manifest may price code run.
  execFileSync("python3", ["-B", resolve(web, "scripts/research-g17-originals.py"), directory]);
  const source = await original<{ monthlyReleases: number; eligible: Feature[]; excluded: { reason: string }[] }>(resolve(directory, "features-sealed.json"), featureSeal);
  if (source.eligible.length < 120) throw Error("Original monthly releases have not cleared the sample gate");
  const { history } = await verifyPublicationTree(web);
  if (history[0]?.issuedAt !== before) throw Error("First public issue differs from the registered cutoff");
  const ftDirectory = resolve(researchWeb, ".consensus/private-ft900");
  const technicalDirectory = resolve(researchWeb, ".consensus/private-technical-momentum");
  const earlier = await original<PriorResearch>(resolve(ftDirectory, "prelaunch-ft900-exports-dia-v1.json"), checkedFt900);
  const earlierTechnicals = await original<EarlierTechnicals>(
    resolve(technicalDirectory, "prelaunch-technical-momentum-volatility-v1.json"), checkedTechnicals);
  if (earlier.before !== before || earlierTechnicals.before !== before) throw Error("Original historical research cutoff differs");
  const technicalCohort = earlierTechnicals.cohorts.find(cohort => cohort.instrument === "DIA");
  if (!technicalCohort) throw Error("DIA technical research proof is missing");
  const receipts: { raw: ResearchPriceReceipt[]; splits: ResearchPriceReceipt[] } = { raw: [], splits: [] };
  const dates = extendedResearchSessions("2016-01-01", "2026-11-02");
  for (let year = 2016; year <= 2026; year++) {
    for (const basis of ["raw", "splits"] as const) {
      const [receipt] = await collectResearchPrices(year >= 2022 ? technicalDirectory : ftDirectory, "DIA",
        dates.filter(day => day.startsWith(String(year))), { cachedOnly: true, splitAdjusted: basis === "splits" });
      if (!receipt || receipt.sha256 !== earlier.prices[basis][year - 2016] ||
          year >= 2022 && receipt.sha256 !== technicalCohort[basis === "raw" ? "raw" : "splitOnly"][year - 2022])
        throw Error("Cached source differs from previously sealed DIA price receipt");
      receipts[basis].push(receipt);
    }
  }
  const index = (items: ResearchPriceReceipt[]) => new Map(items.flatMap(r => r.sessions.map(b => [b.session, b] as const)));
  const raw = index(receipts.raw), splits = index(receipts.splits);
  // Prior technical eligibility depends on the regular exchange clocks and complete lookback only.
  const priorTechnicalIds = new Set(technicalMomentumRows("DIA", receipts.raw.filter(r => r.from >= "2022").flatMap(r => r.sessions), before).map(r => r.id));
  if (priorTechnicalIds.size !== technicalCohort.candidate.samples) throw Error("Historical technical overlap could not be reproduced");
  const priorTradeIds = new Set(earlier.pairs.map(p => p.training.id));
  const rows: TrainingRow[] = [];
  const excluded: { target: string; reason: string }[] = [];
  for (const feature of source.eligible) {
    const bar = raw.get(feature.target), control = splits.get(feature.target);
    if (!bar || !control) { excluded.push({ target: feature.target, reason: "missing previously captured outcome" }); continue; }
    if (bar.openAt !== feature.openAt || bar.closeAt !== feature.closeAt || control.openAt !== bar.openAt ||
        control.closeAt !== bar.closeAt || !(feature.releaseAt < feature.decision && feature.decision < bar.openAt && bar.closeAt < before))
      throw Error("Registered DIA source and outcome clocks disagree");
    if (Math.sign(bar.close - bar.open) !== Math.sign(control.close - control.open)) {
      excluded.push({ target: feature.target, reason: "raw and split-only outcome directions differ" }); continue;
    }
    rows.push({ id: "DIA:" + feature.target, engineVersion: study, issuedAt: feature.decision, labelKnownAt: bar.closeAt,
      features: [feature.control, feature.candidate], up: bar.close > bar.open ? 1 : 0 });
  }

  const split = chronologicalSplit(rows);
  for (const fold of [split.train, split.test]) {
    for (const column of [0, 1]) if (new Set(fold.map(row => row.features[column])).size < 2) throw Error("Registered feature lacks variation");
    if (new Set(fold.map(row => row.up)).size < 2) throw Error("Registered fold lacks outcome variation");
  }
  const candidate = trainCandidate(rows, before);
  const control = trainCandidate(rows.map(row => ({ ...row, features: [row.features[0]] })), before);
  if (candidate.status !== "evaluated" || control.status !== "evaluated" ||
      JSON.stringify(candidate.split) !== JSON.stringify(control.split) || candidate.split.test < 20)
    throw Error("Historical study failed its paired minimum or fixed common split");
  const errors = split.test.map(row => (predict(control.model, [row.features[0]]) - row.up) ** 2 -
    (predict(candidate.model, row.features) - row.up) ** 2);
  const overlap = (data: TrainingRow[]) => ({
    ft900: data.filter(r => priorTradeIds.has(r.id)).length,
    technical: data.filter(r => priorTechnicalIds.has(r.id)).length,
    either: data.filter(r => priorTradeIds.has(r.id) || priorTechnicalIds.has(r.id)).length,
  });
  const summary = {
    archived: source.monthlyReleases, eligible: source.eligible.length, paired: rows.length, split: candidate.split,
    candidate: candidate.candidateBrier, control: control.candidateBrier,
    trainingRate: candidate.baseRateBrier, coin: candidate.coinBrier,
    manufacturingCoefficient: candidate.model.weights[1], difference95: interval(errors),
    clearsRegisteredScreen: candidate.promoted && candidate.model.weights[1] > 0 && candidate.candidateBrier < control.candidateBrier - .01,
    otherStudiesOverlap: { full: overlap(rows), test: overlap(split.test) },
  };
  const result = { study, before, registration, featureSeal, summary, candidateModel: candidate.model,
    controlModel: control.model, candidateDataset: candidate.datasetHash, controlDataset: control.datasetHash, excluded, rows,
    confirmedPriceResponses: { raw: receipts.raw.map(r => [r.sha256, r.priceDigest]), splits: receipts.splits.map(r => [r.sha256, r.priceDigest]) } };
  const path = resolve(directory, "g17-dia-result.json");
  const saved = await readResearchReceipt<typeof result>(path);
  if (saved) {
    if (digest(saved) !== digest(result)) throw Error("Offline G.17 replay differs from sealed research result");
  } else if (seal) await durableJSON(path, result, true);
  else throw Error("Original G.17 result has not been sealed");
  return { summary, digest: digest(result), sourceExclusions: source.excluded.map(r => r.reason) };
}

export async function readG17ManufacturingStudy(root: string, firstIssue: string): Promise<DatedStudyRow> {
  if (firstIssue !== before) throw Error("G.17 first issue differs from the preregistered research boundary");
  const r = await replayG17(resolve(root, ".consensus/private-g17-manufacturing-dia"), root);
  const s = r.summary;
  const multiplePreliminaryMonths = r.sourceExclusions.filter(x => x === "several or ambiguous preliminary months").length;
  const unconfirmedClocks = r.sourceExclusions.filter(x => x === "release timezone missing or contradictory in native original").length;
  if (r.digest !== "db2d2a0576f52af1c74f760b12a279a733936c0d13ea80e0729b4337e6fb4b19" ||
      s.split.testEnds >= before || s.eligible !== s.paired || s.archived !== s.paired + multiplePreliminaryMonths + unconfirmedClocks ||
      s.clearsRegisteredScreen !== (s.manufacturingCoefficient > 0 && Math.min(s.control, s.trainingRate, s.coin) - s.candidate > .01))
    throw Error("G.17 private result, exclusions or reviewed decision differ");
  const round = (value: number) => Number(value.toFixed(4));
  return { studyId: study, family: G17_MANUFACTURING_RESEARCH.family, instrument: G17_MANUFACTURING_RESEARCH.instrument,
    timingBasis: G17_MANUFACTURING_RESEARCH.timingBasis, samples: s.paired, testSamples: s.split.test, monthlyReleases: s.archived,
    multiplePreliminaryMonths, unconfirmedClocks, priorTechnicalSamples: s.otherStudiesOverlap.full.technical,
    priorTechnicalTestSamples: s.otherStudiesOverlap.test.technical, modelBrier: round(s.candidate), controlBrier: round(s.control),
    baseRateBrier: round(s.trainingRate), coinBrier: s.coin, coefficientSign: s.manufacturingCoefficient > 0 ? "positive" :
      s.manufacturingCoefficient < 0 ? "negative" : "zero", controlImprovement95: [round(s.difference95[0]), round(s.difference95[1])],
    clearedMargin: s.clearsRegisteredScreen };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, existingPriceRoot, mode, ...other] = process.argv.slice(2);
  if (!directory || !existingPriceRoot || mode && mode !== "--seal" || other.length)
    throw Error("Usage: research-g17-manufacturing.ts PRIVATE_ORIGINALS EXISTING_WEB_ROOT [--seal]");
  console.log(JSON.stringify(await replayG17(resolve(directory), resolve(existingPriceRoot), mode === "--seal")));
}
