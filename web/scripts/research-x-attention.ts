import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableJSON } from "../lib/publication-storage.ts";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { isFullKibotSession } from "../lib/consensus/kibot.ts";
import { evaluateCandidate, planCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const script = fileURLToPath(import.meta.url);
const web = resolve(dirname(script), "..");
const directory = resolve(web, ".consensus/private-x-attention/v1");
const prices = resolve(web, ".consensus/private-technical-momentum");
const policyHash = "c4184790f8af86729740c5ec64f493a7cac8899742ad6007cf78fc2a1cec1021";
const funds = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
type Fund = typeof funds[number];
type Counts = Partial<Record<Fund, [number, number]>>;
type Source = { days: Record<string, Counts>; revision: string; fundMentions: Record<Fund, number>;
  uniquePosts: number; queryCountTotal: number; stockQuoteCollectionBegan: string };
type TechnicalCohort = { instrument: Fund; raw: string[]; splitOnly: string[];
  candidate: { samples: number; split: { train: number; trainEnds: string; testStarts: string } } };
type Point = { target: string; inputDay: string; values: [number, number][] };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function daysBefore(day: string, offset: number) {
  return new Date(Date.parse(day + "T00:00:00Z") - offset * 86400000).toISOString().slice(0, 10);
}

function logShares(counts?: Counts): [number, number][] | null {
  if (!counts) return null;
  const pairs: [number, number][] = [];
  let mentions = 0, authors = 0;
  for (const ticker of funds) {
    const pair = counts[ticker];
    if (!pair || !pair.every(Number.isSafeInteger) || pair[1] < 10 || pair[0] < pair[1]) return null;
    pairs.push(pair);
    mentions += pair[0];
    authors += pair[1];
  }
  return pairs.map(([n, a]) => [Math.log(n / mentions), Math.log(a / authors)]);
}

export function attentionPoint(target: string, history: Record<string, Counts>, quoteStart: string): Point | string {
  const inputDay = daysBefore(target, 1);
  const prior = [7, 14, 21, 28].map(days => daysBefore(inputDay, days));
  if (prior[3] < "2024-01-01" || inputDay > "2024-10-28") return "outside_observation_period";
  if (prior[3] < quoteStart && inputDay >= quoteStart) return "collection_changed_in_lookback";
  const today = logShares(history[inputDay]);
  const previous = prior.map(day => logShares(history[day]));
  if (!today || previous.some(shares => shares === null)) return "missing_or_small_group";
  const complete = previous.filter(shares => shares !== null);
  const values = today.map(([n, a], i): [number, number] => [
    n - complete.reduce((sum, shares) => sum + shares[i][0], 0) / 4,
    a - complete.reduce((sum, shares) => sum + shares[i][1], 0) / 4,
  ]);
  return { target, inputDay, values };
}

function oldTrainingSessions(cohorts: TechnicalCohort[]) {
  const dates = extendedResearchSessions("2022-01-01", "2026-11-02");
  const full = dates.map(day => {
    const session = extendedResearchSession(day)!;
    return isFullKibotSession(session.openAt, session.closeAt);
  });
  const previouslyUsed = dates.filter((_, i) => i >= 21 && full.slice(i - 21, i + 1).every(Boolean));
  const training = previouslyUsed.slice(0, Math.floor(previouslyUsed.length * 0.6));
  assert.deepEqual(cohorts.map(c => c.instrument).sort(), [...funds].sort());
  for (const { candidate } of cohorts) {
    assert.equal(previouslyUsed.length, candidate.samples);
    assert.equal(training.length, candidate.split.train);
    assert.equal(extendedResearchSession(training.at(-1)!)!.closeAt, candidate.split.trainEnds);
    assert.equal(candidate.split.trainEnds, "2024-10-29T20:00:00.000Z");
  }
  return training.filter(day => day >= "2024-01-01");
}

async function freezeOrMatch(name: string, value: object) {
  const path = resolve(directory, name);
  const existing = await readResearchReceipt(path);
  if (existing !== null) {
    assert.deepEqual(existing, value, name + " differs from the first sealed result");
    return;
  }
  try { await durableJSON(path, value, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  assert.deepEqual(await readResearchReceipt(path), value, name + " differs from the first sealed result");
}

async function study(mode: string) {
  const policyBytes = await readFile(resolve(web, "scripts/x-attention-study-policy.json"));
  assert.equal(hash(policyBytes), policyHash);
  const policy = JSON.parse(policyBytes.toString());
  const oldReceipt = await readFile(resolve(prices, "prelaunch-technical-momentum-volatility-v1.json"));
  assert.equal(hash(oldReceipt), policy.existingTechnicalReceiptSha256);
  const cohorts: TechnicalCohort[] = JSON.parse(oldReceipt.toString()).cohorts;
  const source: Source = JSON.parse(execFileSync("python3", ["-B", resolve(web, "scripts/collect-x-attention.py"), "--study-input"],
    { encoding: "utf8", timeout: 90000, maxBuffer: 2_000_000 }));
  assert.equal(source.revision, policy.sourceRevision);
  const skipped: Record<string, number> = {}, points: Point[] = [];
  for (const date of oldTrainingSessions(cohorts)) {
    const result = attentionPoint(date, source.days, source.stockQuoteCollectionBegan);
    if (typeof result === "string") skipped[result] = (skipped[result] ?? 0) + 1;
    else points.push(result);
  }
  const selection = { policyHash, sourceRevision: source.revision, cutoff: "2024-10-29", skipped, points };
  await freezeOrMatch("selection.json", selection);
  const scope = "retrospective-source-reconstruction-prior-training-dates-only";
  const counts = { scope, policyHash, selectionHash: digest(selection), eligibleSessions: points.length, skipped,
    first: points[0]?.target, last: points.at(-1)?.target, observationsAsIssued: 0, promoted: 0 };
  if (mode === "--cohort" || points.length < 120) {
    console.log(JSON.stringify({ ...counts, status: points.length < 120 ? "insufficient_data" : "cohort_sealed" }));
    return;
  }
  const year = extendedResearchSessions("2024-01-01", "2024-12-31");
  const comparisons = [];
  for (const [index, symbol] of funds.entries()) {
    const old = cohorts.find(c => c.instrument === symbol)!;
    const [raw] = await collectResearchPrices(prices, symbol, year, { cachedOnly: true });
    const [split] = await collectResearchPrices(prices, symbol, year, { cachedOnly: true, splitAdjusted: true });
    assert.equal(raw.sha256, old.raw[2]); assert.equal(split.sha256, old.splitOnly[2]);
    const byDay = new Map(raw.sessions.map((bar, i) => [bar.session, i]));
    const rows: TrainingRow[] = points.map(p => {
      const i = byDay.get(p.target);
      assert(i !== undefined);
      const bar = raw.sessions[i], adjusted = split.sessions[i];
      assert.equal(adjusted.session, bar.session); assert(bar.closeAt <= old.candidate.split.trainEnds);
      const sign = Math.sign(bar.close - bar.open);
      assert.equal(sign, Math.sign(adjusted.close - adjusted.open), "Price bases disagree for " + symbol + " " + p.target);
      return { id: symbol + "/" + p.target, engineVersion: policy.method,
        issuedAt: newYorkTimestamp(p.target.replaceAll("-", "") + "T080000")!, labelKnownAt: bar.closeAt,
        features: p.values[index], up: sign > 0 ? 1 : 0 };
    });
    const options = { nonOverlappingTest: true, minimumSamples: 120, minimumTestSamples: 20 };
    const candidatePlan = planCandidate(rows, policy.registeredAt, options);
    const controlPlan = planCandidate(rows.map(r => ({ ...r, features: [r.features[0]] })), policy.registeredAt, options);
    assert(candidatePlan.status === "ready" && controlPlan.status === "ready", "Research split requirements failed");
    const control = evaluateCandidate(controlPlan);
    const candidate = evaluateCandidate(candidatePlan);
    assert.equal(candidate.baseRateBrier, control.baseRateBrier);
    assert.deepEqual(candidate.split, control.split);
    comparisons.push({ symbol, split: candidate.split, observations: rows.length, coefficient: candidate.model.weights[1],
      candidateBrier: candidate.candidateBrier, mentionBrier: control.candidateBrier, frequencyBrier: candidate.baseRateBrier,
      coinBrier: candidate.coinBrier, clearsDescriptiveMargin: candidate.model.weights[1] > 0 &&
        candidate.candidateBrier < Math.min(control.candidateBrier, candidate.baseRateBrier, candidate.coinBrier) - 0.01,
      sourceHashes: [raw.sha256, split.sha256], datasetHash: candidate.datasetHash });
  }
  const report = { ...counts, status: "descriptive_comparison_finished", comparisons };
  await freezeOrMatch("research-result.json", report);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [mode = "--evaluate", ...extra] = process.argv.slice(2);
  if (extra.length || !["--cohort", "--evaluate"].includes(mode)) throw new Error("Expected --cohort or --evaluate");
  await study(mode);
}
