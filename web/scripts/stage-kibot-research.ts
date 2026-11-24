import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { replayFt900Study } from "./research-ft900-exports.ts";
import { replaySpyCloseLocation } from "./research-spy-close-location.ts";
import { readPrivateResearchSessions, verifyPreviousResearchSessions, type ResearchSessionReceipt } from "../lib/consensus/kibot-verified-session.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import {
  FT900_RESEARCH, KIBOT_RESEARCH_FILE, KIBOT_RESEARCH_LICENSE, KIBOT_LEGACY_RESEARCH_STUDIES,
  KIBOT_RESEARCH_SYMBOLS, SPY_CLOSE_LOCATION_RESEARCH, validateKibotResearch, type Ft900StudyRow, type KibotResearch, type SpyCloseLocationStudyRow,
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
    const [exportsStudy, closingStudy] = await Promise.all([
      readFt900Study(snapshots[0].issuedAt), readSpyCloseLocationStudy(snapshots[0].issuedAt),
    ]);
    studies.push(exportsStudy, closingStudy);
    const aggregate: KibotResearch = {
      schemaVersion: 4, source: KIBOT_RESEARCH_LICENSE, firstEdition: history[0].id, through, daily, studies,
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
