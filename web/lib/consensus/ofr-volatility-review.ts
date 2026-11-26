import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { extendedResearchSession, extendedResearchSessions } from "./extended-research-calendar.ts";
import { verifyPublicationTree } from "./history.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "./learning.ts";
import { collectResearchPrices } from "./research-price-capture.ts";
import { newYorkTimestamp } from "./time.ts";

const run = promisify(execFile);
const cohortSha256 = "7c2608afbed7bd9fa23a0f5a5ca4455a07366fcb4d821ac6b6441ef8b390839b";
const receiptSha256 = "ced65dadf515af48bb47beed604005dab4702ecdeb99879c3095bdddf0d9c77e";
const nativePolicySha256 = "88f96b5baca5e16dc6d5c49df4e8d78496bfb66372e563a9a1843eb182d10d7e";
const precisionPolicySha256 = "e6248d835cdfb6add08ddf1681433b30e16a2c2c7da2eebd039b4b0c90b42fbf";
const priceFilesSha256 = "fa9d71e1069a6e7ec45e0245700e2da271bb9e12da3f7f87d636e8f8f0006676";
const engineVersion = "ofr-volatility-contribution-prelaunch-v1-time-attested-four-decimal";
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

interface SourceReview {
  nativeTreasury: { eligibleTargets: number };
  fourDecimalSensitivity: { eligibleTargets: number; targetsBySource: Record<string, number> };
  verifiedOutcomeInputSha256: string;
  matchedMirrorEconomicDates: number;
  conflictingMirrorEconomicDates: number;
  libraryCongress: { requested: number; matched: number; mismatched: number };
}

interface ScoredReceipt {
  scope: string;
  receipt: string;
  selected: { session: string; progress: string; features: [number, number] }[];
  priceSources: string[];
  main: ReturnType<typeof trainCandidate>;
  compare: ReturnType<typeof trainCandidate>;
  outcome: { pass: boolean; test: number };
}

/** Descriptive paired 95% percentile interval, separate from the sealed selection rule. */
export function ofrControlInterval(differences: number[]) {
  if (differences.length < 20 || differences.some(d => !Number.isFinite(d) || Math.abs(d) > 1))
    throw Error("OFR uncertainty needs at least 20 chronological paired Brier differences");
  const count = differences.length, blockLength = Math.ceil(Math.cbrt(count)), resamples = 10000;
  const improvement = differences.reduce((sum, d) => sum + d, 0) / count;
  let random = parseInt(precisionPolicySha256.slice(0, 8), 16);
  const replicates: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0, used = 0;
    while (used < count) {
      random = (Math.imul(1664525, random) + 1013904223) >>> 0;
      const start = Math.floor((random / 4294967296) * (count - blockLength + 1));
      for (let offset = 0; offset < blockLength && used < count; offset++, used++) sum += differences[start + offset];
    }
    replicates.push(sum / count);
  }
  replicates.sort((a, b) => a - b);
  return { improvement, lowerBound: replicates[249], upperBound: replicates[9749], blockLength, resamples };
}

/** Read-only replay of the two sealed protocols, historical vintages and private ETF labels. */
export async function replayOfrVolatility(root: string) {
  const { stdout } = await run("python3", ["-B", resolve(root, "scripts/verify-ofr-volatility-vintages.py"),
    cohortSha256, "--verify-outcome-inputs", receiptSha256], { cwd: root, timeout: 90000, maxBuffer: 16384 });
  const sources = JSON.parse(stdout) as SourceReview;
  const mirrorTargetsInMixed = sources.fourDecimalSensitivity.targetsBySource["timestamped-mirror-four-decimals"];
  if (sources.verifiedOutcomeInputSha256 !== receiptSha256 || sources.fourDecimalSensitivity.eligibleTargets < 120 ||
      sources.nativeTreasury.eligibleTargets >= 120 || sources.conflictingMirrorEconomicDates !== 0 || !mirrorTargetsInMixed)
    throw Error("OFR scored receipt or contemporaneous source checks differ");

  const before = (await verifyPublicationTree(root)).history[0].issuedAt;
  if (before !== "2026-11-03T06:28:30.460Z") throw Error("OFR first prospective edition differs");
  const path = resolve(root, ".consensus/private-ofr-volatility",
    `outcome-time-attested-four-decimal-${cohortSha256}.json`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 2000000)
    throw Error("OFR scoring receipt needs a bounded owner-only file");
  const scoredBytes = await readFile(path);
  if (digest(scoredBytes) !== receiptSha256) throw Error("OFR original scoring receipt differs");
  const saved = JSON.parse(scoredBytes.toString("utf8")) as ScoredReceipt;
  if (saved.receipt !== cohortSha256 || saved.scope !== "time-attested-four-decimal" ||
      saved.selected.length !== sources.fourDecimalSensitivity.eligibleTargets)
    throw Error("OFR original scoring cohort differs");

  const days = extendedResearchSessions("2022-01-03", "2026-11-02");
  const privatePrices = resolve(root, ".consensus/private-technical-momentum");
  const [raw, splits] = await Promise.all([false, true].map(splitAdjusted =>
    collectResearchPrices(privatePrices, "SPY", days, { cachedOnly: true, splitAdjusted })));
  const fileSeals: [string, string][] = [];
  for (const [basis, records] of [["raw", raw], ["splits", splits]] as const) {
    for (const record of records) {
      const filename = `SPY-${record.from.slice(0, 4)}-${record.from}-${record.through}-${basis}.json`;
      fileSeals.push([filename, digest(await readFile(resolve(privatePrices, filename)))]);
    }
  }
  fileSeals.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (digest(JSON.stringify(fileSeals)) !== priceFilesSha256 ||
      !isDeepStrictEqual([...raw, ...splits].map(r => r.sha256), saved.priceSources))
    throw Error("OFR historical raw or split-only price evidence differs");
  const rawByDay = new Map(raw.flatMap(r => r.sessions).map(b => [b.session, b]));
  const splitByDay = new Map(splits.flatMap(r => r.sessions).map(b => [b.session, b]));
  const rows: TrainingRow[] = saved.selected.map(({ session, progress, features }) => {
    const clock = extendedResearchSession(session), bar = rawByDay.get(session), split = splitByDay.get(session);
    const issuedAt = newYorkTimestamp(session.replaceAll("-", "") + "T074800");
    if (!issuedAt || !clock || !bar || !split || bar.openAt !== clock.openAt || bar.closeAt !== clock.closeAt ||
        Date.parse(progress) >= Date.parse(issuedAt) || issuedAt >= bar.openAt || bar.closeAt >= before ||
        bar.open !== split.open || bar.close !== split.close) throw Error("OFR historical session or outcome differs");
    return { id: "SPY:" + session, engineVersion, issuedAt, labelKnownAt: bar.closeAt,
      features, up: bar.close > bar.open ? 1 : 0 };
  });
  const main = trainCandidate(rows, before);
  const control = trainCandidate(rows.map(r => ({ ...r, features: r.features.slice(0, 1) })), before);
  if (main.status !== "evaluated" || control.status !== "evaluated" ||
      !isDeepStrictEqual(main, saved.main) || !isDeepStrictEqual(control, saved.compare))
    throw Error("OFR refit differs from the original frozen historical evaluation");
  const passed = main.promoted && main.model.weights[1] > 0 && main.candidateBrier < control.candidateBrier - 0.01;
  if (saved.outcome.pass !== passed || saved.outcome.test !== main.split.test) throw Error("OFR held-out decision differs");
  const pairedControl = ofrControlInterval(chronologicalSplit(rows).test.map(row => {
    const controlError = predict(control.model, row.features.slice(0, 1)) - row.up;
    const candidateError = predict(main.model, row.features) - row.up;
    return controlError ** 2 - candidateError ** 2;
  }));
  if (Math.abs(pairedControl.improvement - (control.candidateBrier - main.candidateBrier)) > 1e-12)
    throw Error("OFR paired outcomes disagree with held-out scores");
  return { receiptSha256, cohortSha256, nativePolicySha256, precisionPolicySha256, engineVersion, before,
    testEnds: main.split.testEnds, eligibleTargets: rows.length, nativeOnlyTargets: sources.nativeTreasury.eligibleTargets,
    nativeTargetsInMixed: rows.length - mirrorTargetsInMixed, mirrorTargetsInMixed,
    train: main.split.train, validation: main.split.validation, test: main.split.test,
    candidateBrier: main.candidateBrier, controlBrier: control.candidateBrier,
    baseRateBrier: main.baseRateBrier, coinBrier: main.coinBrier, featureWeight: main.model.weights[1], passed,
    pairedControl, matchedMirrorEconomicDates: sources.matchedMirrorEconomicDates,
    conflictingMirrorEconomicDates: sources.conflictingMirrorEconomicDates,
    libraryCongress: { ...sources.libraryCongress, eligible: sources.fourDecimalSensitivity.targetsBySource["native-library-congress"] } };
}
