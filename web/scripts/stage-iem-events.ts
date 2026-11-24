import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IEM_ELECTION_RESEARCH, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { replayIemEvents } from "./research-iem-events.ts";

/** Anonymous aggregate of the registered historic comparison. Per-day evidence stays in private storage. */
export async function readIemElectionStudy(root: string, before: string, directory?: string, privateRoot?: string): Promise<DatedStudyRow> {
  const result = await replayIemEvents(root, before, directory, privateRoot);
  const round = (value: number) => Number(value.toFixed(4));
  const { counts, certaintyCoefficient, comparativeUncertainty: { voteShare } } = result;
  return {
    studyId: IEM_ELECTION_RESEARCH.id, family: IEM_ELECTION_RESEARCH.family, instrument: IEM_ELECTION_RESEARCH.instrument,
    timingBasis: IEM_ELECTION_RESEARCH.timingBasis, samples: counts.total, trainSamples: counts.train,
    validationSamples: counts.validation, testSamples: counts.test, test2020Samples: counts.heldOutCycles[2020],
    test2024Samples: counts.heldOutCycles[2024], controlImprovement95: [round(voteShare.interval95[0]), round(voteShare.interval95[1])],
    campaignControlP: voteShare.oneSidedCycleSignFlipP, comparisonCount: 384, adjustedControlP: voteShare.correctedP,
    coefficientSign: certaintyCoefficient > 0 ? "positive" : certaintyCoefficient < 0 ? "negative" : "zero",
    modelBrier: round(result.combinedBrier), controlBrier: round(result.controlBrier),
    baseRateBrier: round(result.trainingBaseBrier), coinBrier: result.coinBrier, clearedMargin: result.passesEconomicGate,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [directory, privateRoot] = process.argv.slice(2);
  if (process.argv.length > 4) throw new Error("Expected optional owner study directory and private research parent");
  console.log(JSON.stringify(await readIemElectionStudy(root, "2026-11-03T06:28:30.460Z", directory, privateRoot), null, 2));
}
