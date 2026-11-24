import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { isFullKibotSession, kibotHistorySource, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { evaluateCandidate, planCandidate, predict, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const method = "prelaunch-iem-popular-vote-certainty-spy-v1";
const firstIssue = "2026-11-03T06:28:30.460Z";
const registrationHash = "c71750e1f519d662c26cacb619e553a13aa78e8aa5bc5d72344ef465649027a7";
const sourceHash = "cf718b3022d7026797be015ae8cb83ee9506c08725b10f32f568c596aab8f427";
const sealedResult = "a7b6a0d56a17d036bb8973a76d718fbc7b7c649cf5630c08061b3bf2f40fcb5c";
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

type VenueDay = { cycle: number; target: string; nativeDay: string; features: [number, number] };
type PairedResults = { pairedImprovement: number; interval95: [number, number]; oneSidedCycleSignFlipP: number; correctedP: number };
interface SealedStudy {
  method: string; before: string; registration: string; source: string; privatePriceHashes: Record<string, string>;
  counts: { train: number; validation: number; test: number; total: number; heldOutCycles: Record<string, number> };
  combinedDatasetSHA256: string; controlDatasetSHA256: string; combinedBrier: number; controlBrier: number;
  trainingBaseBrier: number; coinBrier: number; certaintyCoefficient: number; passesEconomicGate: boolean;
  comparativeUncertainty: { voteShare: PairedResults; trainingBase: PairedResults; coin: PairedResults };
}

async function original<T>(file: string, sha: string): Promise<T> {
  const value = await readResearchReceipt<T>(file);
  if (!value || hash(await readFile(file)) !== sha) throw new Error("Private Iowa study original differs from its reviewed hash");
  return value;
}

const oldHolidays: Record<string, string[]> = {
  "2008": "0101 0121 0218 0321 0526 0704 0901 1127 1225".split(" "),
  "2012": "0102 0116 0220 0406 0528 0704 0903 1029 1030 1122 1225".split(" "),
};
const oldShortDays: Record<string, string[]> = { "2008": ["0703", "1128", "1224"], "2012": ["0703", "1123", "1224"] };

function sessionClock(day: string) {
  const year = day.slice(0, 4);
  if (!oldHolidays[year]) return extendedResearchSession(day);
  const compact = day.replaceAll("-", ""), md = compact.slice(4);
  const weekDay = new Date(day + "T12:00:00Z").getUTCDay();
  if (weekDay === 0 || weekDay === 6 || oldHolidays[year].includes(md)) return null;
  return { session: day, openAt: newYorkTimestamp(compact + "T093000")!,
    closeAt: newYorkTimestamp(compact + (oldShortDays[year].includes(md) ? "T130000" : "T160000"))! };
}

const ranges = [
  ["2008-01-08", "2008-11-03", "original"], ["2012-01-05", "2012-11-05", "original"],
  ["2016-01-15", "2016-12-13", "private-spy-fomc-eve"], ["2019-01-18", "2019-12-10", "private-spy-fomc-eve"],
  ["2020-01-02", "2020-01-03", "original"], ["2020-01-17", "2020-12-15", "private-spy-fomc-eve"],
  ["2024-01-02", "2024-12-31", "private-technical-momentum"],
] as const;

async function historicalLabels(directory: string, controls: string, studied: Map<string, VenueDay>, manifest: Record<string, string>, frozenAt: string) {
  const labels = new Map<string, number>();
  const consumed = new Set<string>();
  for (const [from, through, lane] of ranges) {
    const days: string[] = [];
    for (let epoch = Date.parse(from); epoch <= Date.parse(through); epoch += 86_400_000) {
      const day = new Date(epoch).toISOString().slice(0, 10);
      if (sessionClock(day)) days.push(day);
    }
    for (const basis of ["raw", "splits"] as const) {
      let bars;
      if (lane === "original") {
        const name = `study-SPY-${from}-${through}-${basis}.json`;
        const receipt = await original<{ source: string; sha256: string; basis: string; csv: string; receivedAt: string }>(
          resolve(directory, name), manifest[name]);
        if (receipt.source !== kibotHistorySource("SPY", from, through, basis) || receipt.basis !== basis ||
            receipt.receivedAt < frozenAt || hash(receipt.csv) !== receipt.sha256) throw new Error("Invalid original Kibot research response");
        bars = parseKibotDaily(receipt.csv, days, sessionClock);
        consumed.add(name);
      } else {
        const name = `${lane}/SPY-${from.slice(0, 4)}-${from}-${through}-${basis}.json`;
        await original(resolve(controls, name), manifest[name]);
        const [receipt] = await collectResearchPrices(resolve(controls, lane), "SPY", [from, through], { cachedOnly: true, splitAdjusted: basis === "splits" });
        bars = receipt.sessions;
        consumed.add(name);
      }
      for (const bar of bars) {
        if (!studied.has(bar.session)) continue;
        const clock = sessionClock(bar.session), sign = Math.sign(bar.close - bar.open);
        if (!clock || bar.openAt !== clock.openAt || bar.closeAt !== clock.closeAt || !isFullKibotSession(bar.openAt, bar.closeAt))
          throw new Error("Study requires a completed ordinary SPY session");
        if (basis === "raw") {
          if (labels.has(bar.session)) throw new Error("Duplicate economic outcome");
          labels.set(bar.session, sign);
        } else if (labels.get(bar.session) !== sign) throw new Error("Independent Kibot price bases disagree");
      }
    }
  }
  assert.equal(consumed.size, Object.keys(manifest).length);
  assert.equal(labels.size, studied.size);
  return labels;
}

/** Four-trading-observation blocks within each held-out campaign, with a separate exact two-campaign sign test. */
export function iemUncertainty(cycle2020: number[], cycle2024: number[]): PairedResults {
  const groups = [cycle2020, cycle2024];
  if (cycle2020.length !== 24 || cycle2024.length !== 8 || groups.flat().some(x => !Number.isFinite(x) || Math.abs(x) > 1))
    throw new Error("Expected the two registered election cohorts and bounded loss differences");
  const [a, b] = groups.map(group => group.reduce((sum, x) => sum + x, 0));
  const observed = a + b;
  const p = [-a - b, -a + b, a - b, a + b].filter(x => x >= observed - 1e-12).length / 4;
  const resamples: number[] = [];
  let state = 0x69e15a04;
  for (let trial = 0; trial < 10_000; trial++) {
    let sum = 0;
    for (const group of groups) {
      for (let used = 0; used < group.length; used += 4) {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        const start = Math.floor(state / 4294967296 * (group.length - 3));
        for (let offset = 0; offset < 4; offset++) sum += group[start + offset];
      }
    }
    resamples.push(sum / 32);
  }
  resamples.sort((x, y) => x - y);
  return { pairedImprovement: observed / 32, interval95: [resamples[249], resamples[9749]], oneSidedCycleSignFlipP: p, correctedP: Math.min(1, 384 * p) };
}

function electionSplit(rows: TrainingRow[], studied: Map<string, VenueDay>) {
  const ordinary = planCandidate(rows, firstIssue);
  if (ordinary.status !== "ready") throw new Error("Historical minimum or chronology failed");
  const split: typeof ordinary.split = { train: [], validation: [], test: [] };
  for (const row of rows) {
    const cycle = studied.get(row.id.slice(4))!.cycle;
    if (cycle <= 2012) split.train.push(row);
    else if (cycle === 2016) split.validation.push(row);
    else split.test.push(row);
  }
  assert.deepEqual([split.train.length, split.validation.length, split.test.length], [131, 51, 32]);
  assert.equal(new Set(split.train.map(row => row.up)).size, 2);
  assert(split.train.at(-1)!.labelKnownAt < split.validation[0].issuedAt && split.validation.at(-1)!.labelKnownAt < split.test[0].issuedAt);
  return { fit: evaluateCandidate({ ...ordinary, split }), split };
}

export async function replayIemEvents(root: string, before: string, directory = resolve(root, ".consensus/private-iem-screen"), controls = resolve(root, ".consensus")) {
  if (before !== firstIssue) throw new Error("Iowa study cutoff differs from the first prospective issue");
  const registration = await original<{ method: string; before: string; frozenAt: string; selectionSHA256: string }>(resolve(directory, "registration.json"), registrationHash);
  assert.deepEqual([registration.method, registration.before, registration.selectionSHA256], [method, before, sourceHash]);
  const evidence = await original<SealedStudy>(resolve(directory, "result.json"), sealedResult);
  const source = await original<{ rows: VenueDay[] }>(resolve(directory, "extended-source.json"), sourceHash);
  const { stdout } = await run("python3", ["-B", resolve(web, "scripts/qualify-iem-events.py"), directory], { timeout: 30_000, maxBuffer: 4_096 });
  assert.deepEqual(JSON.parse(stdout), { selection: sourceHash, total: 214, cycles: { 2008: 85, 2012: 46, 2016: 51, 2020: 24, 2024: 8 } });
  const studied = new Map(source.rows.map(row => [row.target, row]));
  const directions = await historicalLabels(directory, controls, studied, evidence.privatePriceHashes, registration.frozenAt);
  const rows = source.rows.map(({ target, features }): TrainingRow => ({
    id: "SPY:" + target, engineVersion: method, issuedAt: newYorkTimestamp(target.replaceAll("-", "") + "T074800")!,
    labelKnownAt: sessionClock(target)!.closeAt, features, up: directions.get(target)! > 0 ? 1 : 0,
  }));
  const model = electionSplit(rows, studied), control = electionSplit(rows.map(row => ({ ...row, features: [row.features[0]] })), studied);
  const rate = model.split.train.reduce((sum, r) => sum + r.up, 0) / model.split.train.length;
  function uncertainty(baseline: (r: TrainingRow) => number) {
    const difference = (r: TrainingRow) => (baseline(r) - r.up) ** 2 - (predict(model.fit.model, r.features) - r.up) ** 2;
    const cluster = (cycle: number) => model.split.test.filter(r => studied.get(r.id.slice(4))!.cycle === cycle).map(difference);
    return iemUncertainty(cluster(2020), cluster(2024));
  }
  assert.deepEqual(evidence, {
    method, before, source: sourceHash, registration: registrationHash, privatePriceHashes: evidence.privatePriceHashes,
    counts: { train: 131, validation: 51, test: 32, total: 214, heldOutCycles: { 2020: 24, 2024: 8 } },
    combinedDatasetSHA256: model.fit.datasetHash, controlDatasetSHA256: control.fit.datasetHash,
    combinedBrier: model.fit.candidateBrier, controlBrier: control.fit.candidateBrier, trainingBaseBrier: model.fit.baseRateBrier,
    coinBrier: model.fit.coinBrier, certaintyCoefficient: model.fit.model.weights[1],
    comparativeUncertainty: { voteShare: uncertainty(r => predict(control.fit.model, [r.features[0]])), trainingBase: uncertainty(() => rate), coin: uncertainty(() => 0.5) },
    passesEconomicGate: model.fit.promoted && model.fit.model.weights[1] > 0 && model.fit.candidateBrier < control.fit.candidateBrier - 0.01,
  });
  return evidence;
}
