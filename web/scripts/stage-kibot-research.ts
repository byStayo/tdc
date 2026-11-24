import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { readDatedStudyRows } from "../lib/consensus/dated-study-review.ts";
import { readG17ManufacturingStudy } from "./research-g17-manufacturing.ts";
import { readIemElectionStudy } from "./stage-iem-events.ts";
import { readOfrGeographicStudy } from "./stage-ofr-geographic.ts";
import { replayOfrVolatility } from "../lib/consensus/ofr-volatility-review.ts";
import { replayFt900Study } from "./research-ft900-exports.ts";
import { replaySpyCloseLocation } from "./research-spy-close-location.ts";
import { FOMC_EVE_POLICY_SHA, replayFomcEveStudy } from "./research-fomc-eve.ts";
import { replayIssuerGuidanceQqq } from "./research-issuer-guidance-qqq.ts";
import { replayBlsPayrollNewsStudy } from "./research-bls-payroll-news.ts";
import { readPrivateResearchSessions, verifyPreviousResearchSessions, type ResearchSessionReceipt } from "../lib/consensus/kibot-verified-session.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import {
  BLS_PAYROLL_RESEARCH, OFR_VOLATILITY_RESEARCH, FT900_RESEARCH, KIBOT_RESEARCH_FILE, KIBOT_RESEARCH_LICENSE, KIBOT_LEGACY_RESEARCH_STUDIES,
  KIBOT_RESEARCH_SYMBOLS, SPY_CLOSE_LOCATION_RESEARCH, FOMC_EVE_RESEARCH, QQQ_ISSUER_GUIDANCE_RESEARCH, validateKibotResearch,
  type DatedStudyRow, type Ft900StudyRow, type FomcEveStudyRow, type QqqIssuerGuidanceRow, type KibotResearch, type SpyCloseLocationStudyRow,
} from "../lib/consensus/kibot-research.ts";

/** Only expose rounded diagnostics from the checked, cached research replay. */
export async function readFt900Study(before: string): Promise<Ft900StudyRow> {
  const { result } = await replayFt900Study(true, false, before);
  if (!result || result.method !== FT900_RESEARCH.id || result.policySHA256 !== FT900_RESEARCH.policySha256 || result.before !== before ||
      result.combined.status !== "evaluated" || result.control.status !== "evaluated" ||
      result.combined.split.testEnds >= before || !Number.isFinite(result.summary.exportCoefficient))
    throw new Error("FT900 staging needs the matched, frozen holdout before the first public forecast");
  const { combined, control, summary } = result;
  const coefficient = combined.model.weights[1];
  const rounded = (score: number) => Number(score.toFixed(4));
  return {
    family: FT900_RESEARCH.family, instrument: "DIA", samples: combined.samples, testSamples: combined.split.test,
    modelBrier: rounded(combined.candidateBrier), baseRateBrier: rounded(combined.baseRateBrier),
    fxOnlyBrier: rounded(control.candidateBrier), coinBrier: combined.coinBrier,
    exportCoefficientSign: coefficient > 0 ? "positive" : coefficient < 0 ? "negative" : "zero",
    clearedMargin: summary.clearsResearchMargin,
  };
}

/** Pin the reviewed private report, including the exact source, feature, label and model hashes. */
const reviewedSpyCloseReplay = "30d18886783e573258ec87c9160c7fbdcc0992e0288f5e1aa11d40489e113c21";
export async function readSpyCloseLocationStudy(before: string): Promise<SpyCloseLocationStudyRow> {
  const { result } = await replaySpyCloseLocation(true, false, before);
  if (!result || digest(result) !== reviewedSpyCloseReplay || result.method !== SPY_CLOSE_LOCATION_RESEARCH.id ||
      result.before !== before || result.sources.priceSource !== KIBOT_PRICE_CITATION ||
      result.combined.status !== "evaluated" || result.control.status !== "evaluated" || result.combined.split.testEnds >= before)
    throw new Error("SPY close-location staging needs its exact sealed private sources and prelaunch holdout");
  const { combined, control, summary } = result;
  const coefficient = combined.model.weights[1];
  const margin = Math.min(control.candidateBrier, combined.baseRateBrier, combined.coinBrier) - combined.candidateBrier;
  if (!Number.isFinite(coefficient) || coefficient !== summary.locationCoefficient ||
      combined.samples !== control.samples || digest(combined.split) !== digest(control.split) || combined.coinBrier !== 0.25 ||
      (coefficient > 0 && margin > 0.01) !== summary.clearsResearchMargin)
    throw new Error("SPY close-location held-out comparisons or research decision changed");
  return {
    studyId: SPY_CLOSE_LOCATION_RESEARCH.id, family: SPY_CLOSE_LOCATION_RESEARCH.family, instrument: "SPY",
    samples: combined.samples, testSamples: combined.split.test,
    modelBrier: Number(combined.candidateBrier.toFixed(4)), returnOnlyBrier: Number(control.candidateBrier.toFixed(4)),
    baseRateBrier: Number(combined.baseRateBrier.toFixed(4)), coinBrier: combined.coinBrier, clearedMargin: summary.clearsResearchMargin,
  };
}

export function assertRetainedStudyRows(previous: KibotResearch, next: KibotResearch) {
  if (digest(next.studies.slice(0, previous.studies.length)) !== digest(previous.studies))
    throw new Error("A previously published research study changed or is missing");
}

async function readFomcEveStudy(before: string): Promise<FomcEveStudyRow> {
  const { result } = await replayFomcEveStudy(true, false, before);
  if (!result || digest(result) !== "3c1191618d72c62233ae566eaf53231ca2b8d63d4b6c289a8fd52160a75ca3d9" ||
      result.method !== FOMC_EVE_RESEARCH.id || result.policySha256 !== FOMC_EVE_POLICY_SHA ||
      result.priceSource !== KIBOT_PRICE_CITATION || result.before !== before || result.combined.split.testEnds >= before)
    throw new Error("The Fed meeting study differs from the reviewed prelaunch comparison");
  const { summary } = result;
  const round = (n: number) => Number(n.toFixed(4));
  return { studyId: FOMC_EVE_RESEARCH.id, family: FOMC_EVE_RESEARCH.family, instrument: "SPY",
    samples: summary.samples, testSamples: summary.heldOut, testEves: summary.heldOutEves,
    modelBrier: round(summary.modelBrier), returnOnlyBrier: round(summary.controlBrier),
    baseRateBrier: round(summary.baseRateBrier), coinBrier: summary.coinBrier, clearedMargin: summary.clearsMargin,
    eveCoefficientSign: summary.coefficient > 0 ? "positive" : summary.coefficient < 0 ? "negative" : "zero" };
}

async function readQqqIssuerGuidanceStudy(before: string): Promise<QqqIssuerGuidanceRow> {
  const { result, sourceSummary } = await replayIssuerGuidanceQqq(true, false, before);
  if (!result || result.sealedSHA256 !== "81061a52a2cb7987f658ee56d06e2ac43723dce3307f113e93781be4d4cd591a" ||
      sourceSummary.inputSHA256 !== "45e4ebec6487e50583a5bd9c9889cc4ebf0e984c784cba22870fe80b45d95f62" ||
      result.method !== QQQ_ISSUER_GUIDANCE_RESEARCH.id || result.before !== before ||
      result.policySHA256 !== "bae158de7cfd520381a0985be6944ac95cfb982826ed9531d0e9adb4a3650c57" ||
      result.summary.split.testEnds >= before)
    throw new Error("QQQ earnings staging requires the reviewed, reproducible prelaunch holdout");
  const s = result.summary;
  const round = (value: number) => Number(value.toFixed(4));
  const margin = Math.min(s.trainingRateBrier, s.controlBrier, s.coinBrier) - s.combinedBrier;
  if (s.paired !== s.eligible - s.excluded || s.split.train + s.split.validation + s.split.test !== s.paired ||
      (s.earningsCoefficient > 0 && margin > 0.01) !== s.clearsResearchGate)
    throw new Error("QQQ earnings counts or directional decision disagree with the registered analysis");
  return {
    studyId: QQQ_ISSUER_GUIDANCE_RESEARCH.id, family: "earnings", instrument: "QQQ",
    samples: s.paired, testSamples: s.split.test, modelBrier: round(s.combinedBrier), ageOnlyBrier: round(s.controlBrier),
    baseRateBrier: round(s.trainingRateBrier), coinBrier: s.coinBrier, clearedMargin: s.clearsResearchGate,
    earningsCoefficientSign: s.earningsCoefficient > 0 ? "positive" : s.earningsCoefficient < 0 ? "negative" : "zero",
    controlImprovement95: [round(s.interval95[0]), round(s.interval95[1])],
  };
}

export async function readBlsPayrollNewsStudy(before: string): Promise<DatedStudyRow> {
  const result = await replayBlsPayrollNewsStudy(true, before);
  if (result.method !== BLS_PAYROLL_RESEARCH.id || result.before !== before ||
      result.policySHA256 !== "69db484547a03f3800f10e35ad5d9e8808cbe8648ced266e728843c6d61d4b05" ||
      result.sourceSHA256 !== "c515848fb40c480dfa978a43bff6da4b065edd41310a9cc9bd46888ce77dd9e6" ||
      result.sealedSHA256 !== "bf27c369a61f213963d33cb719d3f87fb1ca618ecaff7c21e0993062408ab066")
    throw new Error("BLS payroll staging requires the reviewed original releases, TLT prices and prelaunch results");
  const s = result.summary;
  const [lower, upper] = s.uncertainty95;
  const margin = Math.min(s.controlBrier, s.baseBrier, s.coinBrier) - s.candidateBrier;
  if (s.status !== "evaluated" || s.eligible !== BLS_PAYROLL_RESEARCH.samples || s.paired !== s.eligible - s.excluded ||
      s.paired !== s.split.train + s.split.validation + s.split.test || s.split.testEnds >= before ||
      ![s.coefficient, margin, lower, upper].every(Number.isFinite) || lower > upper || s.coinBrier !== 0.25 ||
      s.clearsGate !== (s.coefficient < 0 && margin > 0.01 && lower > 0))
    throw new Error("BLS payroll staging disagrees with the registered chronological comparison and uncertainty gate");
  const round = (value: number) => Number(value.toFixed(4));
  return {
    studyId: BLS_PAYROLL_RESEARCH.id, family: BLS_PAYROLL_RESEARCH.family, instrument: BLS_PAYROLL_RESEARCH.instrument,
    timingBasis: "dated-release", samples: s.paired, testSamples: s.split.test,
    modelBrier: round(s.candidateBrier), controlBrier: round(s.controlBrier), baseRateBrier: round(s.baseBrier), coinBrier: s.coinBrier,
    coefficientSign: s.coefficient < 0 ? "negative" : s.coefficient > 0 ? "positive" : "zero",
    controlImprovement95: [round(lower), round(upper)], clearedMargin: s.clearsGate,
  };
}

export async function readOfrVolatilityStudy(root: string, before: string): Promise<DatedStudyRow> {
  const r = await replayOfrVolatility(root);
  if (r.engineVersion !== OFR_VOLATILITY_RESEARCH.id || r.before !== before || r.testEnds >= before ||
      r.nativePolicySha256 !== "88f96b5baca5e16dc6d5c49df4e8d78496bfb66372e563a9a1843eb182d10d7e" ||
      r.precisionPolicySha256 !== "e6248d835cdfb6add08ddf1681433b30e16a2c2c7da2eebd039b4b0c90b42fbf" ||
      r.cohortSha256 !== "7c2608afbed7bd9fa23a0f5a5ca4455a07366fcb4d821ac6b6441ef8b390839b" ||
      r.receiptSha256 !== "ced65dadf515af48bb47beed604005dab4702ecdeb99879c3095bdddf0d9c77e")
    throw new Error("OFR staging requires the two registered source rules, sealed mixed cohort and checked prelaunch outcomes");
  const { improvement, lowerBound, upperBound } = r.pairedControl;
  const margin = Math.min(r.controlBrier, r.baseRateBrier, r.coinBrier) - r.candidateBrier;
  if (r.eligibleTargets !== OFR_VOLATILITY_RESEARCH.samples || r.eligibleTargets !== r.nativeTargetsInMixed + r.mirrorTargetsInMixed ||
      r.eligibleTargets !== r.train + r.validation + r.test || r.nativeOnlyTargets >= 120 || r.coinBrier !== 0.25 ||
      ![r.featureWeight, margin, improvement, lowerBound, upperBound].every(Number.isFinite) || lowerBound > upperBound ||
      Math.abs(improvement - (r.controlBrier - r.candidateBrier)) > 1e-12 || r.passed !== (r.featureWeight > 0 && margin > 0.01))
    throw new Error("OFR aggregate disagrees with the source counts, chronological comparison or registered decision");
  const round = (value: number) => Number(value.toFixed(4));
  return {
    studyId: OFR_VOLATILITY_RESEARCH.id, family: OFR_VOLATILITY_RESEARCH.family, instrument: OFR_VOLATILITY_RESEARCH.instrument,
    timingBasis: OFR_VOLATILITY_RESEARCH.timingBasis, sourceBasis: "originals-and-four-decimal-mirror",
    samples: r.eligibleTargets, testSamples: r.test, nativeOnlySamples: r.nativeOnlyTargets,
    nativeSamples: r.nativeTargetsInMixed, mirrorSamples: r.mirrorTargetsInMixed,
    modelBrier: round(r.candidateBrier), controlBrier: round(r.controlBrier), baseRateBrier: round(r.baseRateBrier), coinBrier: r.coinBrier,
    coefficientSign: r.featureWeight > 0 ? "positive" : r.featureWeight < 0 ? "negative" : "zero",
    controlImprovement95: [round(lowerBound), round(upperBound)], clearedMargin: r.passed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--publish"))
    throw new Error("Usage: stage-kibot-research.ts [--publish]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const path = resolve(root, "public/consensus", KIBOT_RESEARCH_FILE);
  const lock = await acquirePublicationLock(root, "kibot-aggregate-research");
  let failure: { error: unknown } | undefined;
  try {
    const { current, history, snapshots } = await verifyPublicationTree(root);
    const { sessions, checked } = await readPrivateResearchSessions(root, snapshots, current.engineVersion);
    const { through, daily } = checked;

    const studyIds = new Set(KIBOT_LEGACY_RESEARCH_STUDIES.map(study => study.id));
    const reports = new Map(await Promise.all([...studyIds].map(async id => {
      const report = JSON.parse(await readFile(resolve(root, ".consensus/private-family-research", id + ".json"), "utf8"));
      if (report.method !== id || report.beforeFirstPublicForecast !== snapshots[0].issuedAt ||
          report.priceSource !== KIBOT_PRICE_CITATION) throw new Error("Saved research differs from the verified publication history");
      return [id, report] as const;
    })));
    const studies: KibotResearch["studies"] = KIBOT_LEGACY_RESEARCH_STUDIES.flatMap(study => {
      const report = reports.get(study.id);
      const rows = study.family === "rates"
        ? [{ instrument: "TLT", result: report.results }]
        : (report.experiments as { instrument: string; family?: string; result: typeof report.results }[])
          .filter(row => row.family === study.family || (study.family === "news" && row.family === undefined));
      return rows.map(({ instrument, result }) => {
        if (result.status !== "evaluated" || !(result.split?.testEnds < snapshots[0].issuedAt) ||
            typeof result.candidateBrier !== "number" || typeof result.baseRateBrier !== "number" ||
            result.coinBrier !== 0.25 || typeof result.promoted !== "boolean")
          throw new Error("Saved research requires completed prelaunch test results");
        return {
          family: study.family, instrument: instrument as typeof KIBOT_RESEARCH_SYMBOLS[number],
          samples: result.samples, testSamples: result.split.test,
          modelBrier: Number(result.candidateBrier.toFixed(4)),
          baseRateBrier: Number(result.baseRateBrier.toFixed(4)),
          clearedMargin: result.promoted,
        };
      });
    });
    const [exportsStudy, closingStudy, meetingStudy, earningsStudy, datedStudies, payrollStudy, ofrStudy, geographicStudy, electionStudy, manufacturingStudy] = await Promise.all([
      readFt900Study(snapshots[0].issuedAt), readSpyCloseLocationStudy(snapshots[0].issuedAt), readFomcEveStudy(snapshots[0].issuedAt),
      readQqqIssuerGuidanceStudy(snapshots[0].issuedAt), readDatedStudyRows(root, snapshots[0].issuedAt),
      readBlsPayrollNewsStudy(snapshots[0].issuedAt), readOfrVolatilityStudy(root, snapshots[0].issuedAt),
      readOfrGeographicStudy(root, snapshots[0].issuedAt), readIemElectionStudy(root, snapshots[0].issuedAt),
      readG17ManufacturingStudy(root, snapshots[0].issuedAt),
    ]);
    studies.push(exportsStudy, closingStudy, meetingStudy, earningsStudy, ...datedStudies, payrollStudy, ofrStudy, geographicStudy, electionStudy, manufacturingStudy);
    const aggregate: KibotResearch = {
      schemaVersion: 11, source: KIBOT_RESEARCH_LICENSE, firstEdition: history[0].id, through, daily, studies,
    };
    validateKibotResearch(aggregate, history[0]);
    const next = JSON.stringify(aggregate, null, 2) + "\n";
    const prior = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const attribution = resolve(root, ".consensus/private-kibot/aggregate-history");
    if (prior) {
      const previous = JSON.parse(prior);
      validateKibotResearch(previous, history[0]);
      assertRetainedStudyRows(previous, aggregate);
      const receipt = await readResearchReceipt<ResearchSessionReceipt>(resolve(attribution, digest(previous) + ".json"));
      if (!receipt) throw new Error("Missing private session identities for the previously published research aggregate");
      verifyPreviousResearchSessions(previous, receipt, sessions, checked);
    }
    const changed = prior !== next;
    if (args[0] === "--publish") {
      await durableDirectory(attribution, 0o700);
      const aggregateSha256 = digest(aggregate);
      const filename = resolve(attribution, aggregateSha256 + ".json");
      const receipt = { aggregateSha256, identitiesSha256: digest(checked.identities), identities: checked.identities };
      const saved = await readResearchReceipt<ResearchSessionReceipt>(filename);
      if (saved && digest(saved) !== digest(receipt)) throw new Error("Private identities for this aggregate have changed");
      if (!saved) await durableJSON(filename, receipt, true);
      if (changed) await durableJSON(path, aggregate);
    }
    console.log(JSON.stringify({
      through, selected: checked.selected, inputEligible: daily.reduce((sum, row) => sum + row.eligibleSessions, 0),
      calls: daily.reduce((sum, row) => sum + row.calls, 0),
      studies: studies.length, cleared: studies.filter(row => row.clearedMargin).length,
      status: !changed ? "unchanged" : args[0] === "--publish" ? "staged" : "reviewed",
    }));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(lock, failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
