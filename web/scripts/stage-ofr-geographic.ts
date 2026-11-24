import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { OFR_GEOGRAPHIC_RESEARCH, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { type evaluateRegionalResearch, readRegionalCohort } from "./research-ofr-geographic.ts";

const run = promisify(execFile);
const reviewedResult = "8ec9a92a40c6805f87351a0dc60ff76355b8a6d517e6df1e340e2ef07876c82e";
const reviewedSource = "a842d6890ccba86bcbf33b5a0125c458c8ed067192cbd4ca45c80e47afb74335";
const firstIssue = "2026-11-03T06:28:30.460Z";

/** Reproduce the exact embargoed sources and model, then select only anonymous rounded aggregates. */
export async function readOfrGeographicStudy(root: string, before: string, ownerDirectory?: string, privateRoot?: string): Promise<DatedStudyRow> {
  if (before !== firstIssue) throw Error("Regional study cutoff differs from the first prospective issue");
  const parent = privateRoot ?? resolve(root, ".consensus");
  const directory = ownerDirectory ?? resolve(parent, "private-ofr-geography");
  await readRegionalCohort(directory);
  const path = resolve(directory, "result.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 80000 || !stat.size) throw Error("Private regional research summary is unverified");
  const body = await readFile(path);
  if (createHash("sha256").update(body).digest("hex") !== reviewedResult) throw Error("Private regional study differs from the sealed result");
  const scripts = resolve(root, "scripts");
  const { stdout } = await run("python3", ["-B", resolve(scripts, "qualify-ofr-geographic.py"), "--source-root",
    resolve(parent, "private-ofr-volatility"), "--native-precision-archives", directory, "--after-maturity",
    "--output", resolve(directory, "maturity-source.json")], { timeout: 90_000, maxBuffer: 16_384 });
  const proof = JSON.parse(stdout);
  if (proof.selectionSHA256 !== reviewedSource || proof.distinctTargets !== 147 || proof.addedAfterMaturity !== 38 ||
      proof.matchedEconomicDates !== 40 || proof.conflictingDates.length || !proof.sourceFloorMet) throw Error("Regional source evidence did not reproduce");
  // --replay compares the entire recomputed result, including private source
  // hashes, with the byte-pinned result above. Its registered reader predates
  // the operational publisher's distinction between absent and invalid prices.
  await run("python3", ["-B", resolve(scripts, "replay-ofr-geographic-v1.py"), directory, parent, "--node", process.execPath],
    { timeout:90_000, maxBuffer:64_000 });
  const result = JSON.parse(body.toString("utf8")) as Awaited<ReturnType<typeof evaluateRegionalResearch>>;
  if (result.before !== before ||
      result.method !== OFR_GEOGRAPHIC_RESEARCH.id || result.split.testEnds >= before || result.coinBrier !== 0.25 ||
      result.passesEconomicGate !== (result.coefficient > 0 &&
        result.combinedBrier < Math.min(result.controlBrier, result.trainingBaseBrier, result.coinBrier) - 0.01))
    throw Error("Regional prelaunch results did not reproduce");
  const round = (v: number) => Number(v.toFixed(4));
  const paired = result.intervals.usStressOnly;
  return {
    studyId: OFR_GEOGRAPHIC_RESEARCH.id, family: OFR_GEOGRAPHIC_RESEARCH.family, instrument: OFR_GEOGRAPHIC_RESEARCH.instrument,
    timingBasis: OFR_GEOGRAPHIC_RESEARCH.timingBasis, samples: result.samples, testSamples: result.split.test,
    nativeSamples: result.sourceCounts.treasuryNative, mirrorSamples: result.sourceCounts.timestampedMirror,
    deferredNativeSamples: result.sourceCounts.originallyWitnessedNew, comparisonCount: 96, adjustedControlP: round(paired.bonferroni96P),
    modelBrier: round(result.combinedBrier), controlBrier: round(result.controlBrier), baseRateBrier: round(result.trainingBaseBrier),
    coinBrier: result.coinBrier, controlImprovement95: [round(paired.lower), round(paired.upper)],
    coefficientSign: result.coefficient > 0 ? "positive" : result.coefficient < 0 ? "negative" : "zero",
    clearedMargin: result.passesEconomicGate,
  };
}
