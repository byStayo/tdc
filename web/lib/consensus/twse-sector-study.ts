import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exchangeSession, hasReviewedCalendar, hasReviewedCalendarRange } from "./exchange-calendar.ts";
import { latestFirstRateSession } from "./firstrate.ts";
import { FIRST_RATE_SOURCE } from "./firstrate-technicals.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import { newYorkDate } from "./time.ts";
import { taiwanOpenAt, TWSE_SECTOR_ID } from "./twse-sector.ts";
import { replayTwseSector } from "./twse-sector-source.ts";
import { TWSE_SECTOR_STUDY_POLICY } from "./twse-sector-study-policy.ts";
import type { Snapshot } from "./types.ts";

export function sectorTargetDate(session: string) {
  if (!hasReviewedCalendar(session)) return null;
  const us = exchangeSession(session);
  if (!us || Date.parse(us.closeAt) - Date.parse(us.openAt) !== 390 * 60_000) return null;
  // When an intervening listing-market calendar date is unresolved, its predecessor is unknown.
  let date = session;
  for (let i = 0; i < 12; i++) {
    date = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
    if (!hasReviewedCalendarRange(date, session)) return null;
    if (exchangeSession(date)) return date;
  }
  return null;
}

async function witnessedPair(
  root: string,
  session: string,
  edition: string,
  registeredAt: string,
): Promise<StudyPoint[]> {
  const date = sectorTargetDate(session);
  if (!date || taiwanOpenAt(date) <= registeredAt) return [];
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition)) throw Error("Invalid TWSE study edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const witness = await verifyPreopenWithMorningConfirmation(root, session, edition, bytes, new Date().toISOString());
  if (newYorkDate(witness.observedAt) !== session) return [];
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  const signal = snapshot.signals.find((s) => s.id === TWSE_SECTOR_ID);
  if (
    !signal ||
    signal.status !== "available" ||
    signal.source.observedAt !== date ||
    latestFirstRateSession(snapshot.cutoff) !== date
  )
    return [];
  const proof = await replayTwseSector(root, signal, snapshot.cutoff);
  if (!proof) return [];
  return [
    {
      instrument: "QQQ",
      eventId: "twse:semiconductor:" + date,
      issuedAt: snapshot.issuedAt,
      recordedAt: witness.observedAt,
      ...proof,
    },
  ];
}

export const twseSectorStudy = createSecondaryStudy({
  directory: ".consensus/private-twse-sector-study/v1",
  earliest: "2026-11-24T17:23:42.000Z",
  policy: TWSE_SECTOR_STUDY_POLICY,
  policySha: "6b5930149c2b14d07eacc0ad8ee9772adb4dc59a7d146e8b57ad01e624e1d888",
  requireNewRelease: true,
  disjointTests: true,
  readPoints: (root, session, edition, fund, registeredAt) =>
    fund === undefined || fund === "QQQ" ? witnessedPair(root, session, edition, registeredAt) : Promise.resolve([]),
  validFeature: (e) => {
    const date = sectorTargetDate(e.session);
    return e.fund === "QQQ" && !!date && e.id === "twse:semiconductor:" + date;
  },
  granted: (fund, source) =>
    fund === "QQQ" && [FIRST_RATE_SOURCE, MARKETPARQUET_SOURCE, KIBOT_SUBSCRIBER_EOD_SOURCE].includes(source),
});
