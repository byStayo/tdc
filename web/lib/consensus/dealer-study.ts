import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEALER_STUDY_POLICY } from "./dealer-study-policy.ts";
import { DEALER_DIRECTORY, replayDealerStudySources } from "./dealer-study-sources.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKET_HISTORY_SOURCE } from "./market-history-settlement.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { PRIMARY_DEALER_POSITION_ID } from "./primary-dealer-positions.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import { newYorkDate } from "./time.ts";
import type { Snapshot } from "./types.ts";

async function witnessedPair(root: string, session: string, edition: string): Promise<StudyPoint[]> {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition)) throw Error("Invalid dealer study edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const witness = await verifyPreopenWithMorningConfirmation(root, session, edition, bytes, new Date().toISOString());
  if (newYorkDate(witness.observedAt) !== session) return [];
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  const signal = snapshot.signals.find(s => s.id === PRIMARY_DEALER_POSITION_ID);
  if (!signal || signal.status !== "available") return [];
  const pair = await replayDealerStudySources(join(root, DEALER_DIRECTORY), signal, session, snapshot.cutoff);
  return pair ? [{ instrument: "TLT", eventId: "nyfed:fr2004a:" + signal.source.observedAt, issuedAt: snapshot.issuedAt,
    observedThrough: pair.nativeAt, recordedAt: witness.observedAt, sourceSeal: pair.sourceSeal, candidate: pair.candidate, control: pair.control }] : [];
}

export const dealerStudy = createSecondaryStudy({
  directory: ".consensus/private-dealer-position-study/v1", earliest: "2026-11-24T17:07:50.000Z",
  policy: DEALER_STUDY_POLICY, policySha: "a571847dbd060967dfccb668e49231778467a94f578f7e8e4344f04507957c1b",
  requireNewRelease: true, disjointTests: true,
  readPoints: (root, session, edition, fund) => fund === undefined || fund === "TLT" ? witnessedPair(root, session, edition) : Promise.resolve([]),
  validFeature: e => {
    const date = /^nyfed:fr2004a:(\d{4}-\d\d-\d\d)$/.exec(e.id)?.[1];
    const age = date && (Date.parse(e.session) - Date.parse(date)) / 86_400_000;
    return e.fund === "TLT" && typeof age === "number" && age >= 8 && age <= 15;
  },
  granted: (fund, source) => fund === "TLT" && [MARKET_HISTORY_SOURCE, MARKETPARQUET_SOURCE, KIBOT_SUBSCRIBER_EOD_SOURCE].includes(source),
});
