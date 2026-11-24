import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIRST_RATE_SOURCE } from "./firstrate.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKET_HISTORY_SOURCE } from "./market-history-settlement.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { PREMARKET_STUDY_POLICY as policy, PREMARKET_STUDY_SHA } from "./premarket-study-policy.ts";
import { readPreviousPremarketFeature } from "./previous-premarket-features.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import type { StudyFund } from "./secondary-study-model.ts";
import { newYorkDate } from "./time.ts";
import type { Snapshot } from "./types.ts";

async function asIssuedPoints(root: string, session: string, edition: string, only?: StudyFund): Promise<StudyPoint[]> {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition)) throw Error("Invalid edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const proof = await verifyPreopenWithMorningConfirmation(root, session, edition, bytes, new Date().toISOString());
  if (newYorkDate(proof.observedAt) !== session) return [];
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  const points: StudyPoint[] = [];
  for (const instrument of only ? [only] : policy.instruments) {
    const feature = await readPreviousPremarketFeature(root, snapshot, instrument, session);
    if (feature.status !== "available") continue;
    points.push({
      instrument, eventId: "prior-premarket:" + instrument + ":" + session, issuedAt: snapshot.issuedAt,
      observedThrough: feature.availableAt, recordedAt: proof.observedAt, sourceSeal: feature.evidenceSha256,
      control: feature.control, candidate: feature.candidate,
    });
  }
  return points;
}

export const premarketStudy = createSecondaryStudy({
  directory: ".consensus/private-prior-premarket-study/v1",
  policy, policySha: PREMARKET_STUDY_SHA, earliest: "2026-11-24T10:44:00.000Z",
  requireNewRelease: false, disjointTests: true,
  readPoints: asIssuedPoints,
  validFeature: e => e.id === "prior-premarket:" + e.fund + ":" + e.session &&
    Number.isInteger(e.control) && e.control >= -2 && e.control <= 2 &&
    e.candidate >= -100 && Number(e.candidate.toFixed(1)) === e.candidate,
  granted: (fund, source) => source === MARKETPARQUET_SOURCE || source === KIBOT_SUBSCRIBER_EOD_SOURCE ||
    (fund === "TLT" ? source === MARKET_HISTORY_SOURCE : source === FIRST_RATE_SOURCE),
});
