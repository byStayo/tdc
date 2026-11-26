import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANALYST_ID, replayAnalystVintage } from "./analyst-ratings.ts";
import { ANALYST_STUDY_POLICY } from "./analyst-study-policy.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { FIRST_RATE_SOURCE } from "./firstrate.ts";
import { digest } from "./history.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { previousIssueInWitnessedIndex, verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import { newYorkDate } from "./time.ts";
import type { HistoryEntry, Snapshot } from "./types.ts";

const duration = 390 * 60_000;
const editionPattern = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
type Counts = { upgrades: number; downgrades: number; initiations: number; reiterations: number; total: number };

export function priorRatingSession(session: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(session) || !hasReviewedCalendar(session)) return null;
  const previous = new Date(Date.parse(session + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  if (previous.slice(0, 7) !== session.slice(0, 7) || !hasReviewedCalendar(previous)) return null;
  const targetClock = exchangeSession(session), priorClock = exchangeSession(previous);
  if (!targetClock || !priorClock || [targetClock, priorClock].some(clock => Date.parse(clock.closeAt) - Date.parse(clock.openAt) !== duration)) return null;
  return priorClock;
}

export function ratingBreadth(previous: Counts, current: Counts) {
  for (const key of ["upgrades", "downgrades", "initiations", "reiterations", "total"] as const) {
    if (![previous[key], current[key]].every(n => Number.isSafeInteger(n) && n >= 0) || current[key] < previous[key]) return null;
  }
  if ([previous, current].some(c => c.total !== c.upgrades + c.downgrades + c.initiations + c.reiterations)) return null;
  const before = previous.upgrades + previous.downgrades;
  const addedUp = current.upgrades - previous.upgrades, addedDown = current.downgrades - previous.downgrades;
  if (!before || !(addedUp + addedDown)) return null;
  return { control: (previous.upgrades - previous.downgrades) / before, candidate: (addedUp - addedDown) / (addedUp + addedDown) };
}

async function witnessedVintage(root: string, session: string, edition: string, asOf: string, expected?: HistoryEntry) {
  if (!editionPattern.test(edition)) throw Error("Invalid Quantisnow study edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  if (expected && (expected.sha256 !== digest(snapshot) || expected.issuedAt !== snapshot.issuedAt || expected.engineVersion !== snapshot.engineVersion))
    throw Error("Prior analyst edition differs from the witnessed public index");
  const signal = snapshot.signals.find(s => s.id === ANALYST_ID);
  if (!signal || signal.status !== "available" || signal.source.observedAt?.slice(0, 10) !== session ||
      newYorkDate(signal.source.observedAt) !== session) return null;
  const witness = await verifyPreopenWithMorningConfirmation(root, session, edition, bytes, asOf);
  if (newYorkDate(witness.observedAt) !== session) return null;
  const native = await replayAnalystVintage(root, signal, snapshot.cutoff);
  return native ? { native, witness, issuedAt: snapshot.issuedAt, bytes } : null;
}

/** Use only editions issued and independently witnessed before their own opens. */
export async function witnessedRatingPair(root: string, session: string, edition: string): Promise<StudyPoint[]> {
  const prior = priorRatingSession(session);
  if (!prior) return [];
  const asOf = new Date().toISOString();
  const current = await witnessedVintage(root, session, edition, asOf);
  if (!current) return [];
  const priorIssue = await previousIssueInWitnessedIndex(root, session, edition, current.bytes, asOf, prior.openAt);
  if (!priorIssue) return [];
  const previous = await witnessedVintage(root, prior.session, priorIssue.id, current.issuedAt, priorIssue);
  if (!previous) return [];
  const values = ratingBreadth(previous.native.counts, current.native.counts);
  if (!values) return [];
  return [{ instrument: "SPY", eventId: "quantisnow:" + prior.session + ":" + session,
    issuedAt: current.issuedAt, observedThrough: current.native.updatedAt, recordedAt: current.witness.observedAt,
    sourceSeal: digest([previous.witness, previous.native, current.witness, current.native]), ...values }];
}

export const analystStudy = createSecondaryStudy({
  directory: ".consensus/private-analyst-action-study/v1", earliest: "2026-11-24T12:38:00.000Z",
  policy: ANALYST_STUDY_POLICY, policySha: "7e72ed4b263e8c3bd069fadd4273a8b5e106a3e9de9b9dad61aa38be552d9187",
  requireNewRelease: true, disjointTests: true,
  readPoints: (root, session, edition, fund) => fund === undefined || fund === "SPY" ? witnessedRatingPair(root, session, edition) : Promise.resolve([]),
  validFeature: e => {
    const prior = priorRatingSession(e.session);
    return !!prior && e.fund === "SPY" && e.id === "quantisnow:" + prior.session + ":" + e.session &&
      Math.abs(e.control) <= 1 && Math.abs(e.candidate) <= 1;
  },
  granted: (fund, source) => fund === "SPY" && [FIRST_RATE_SOURCE, MARKETPARQUET_SOURCE, KIBOT_SUBSCRIBER_EOD_SOURCE].includes(source),
});
