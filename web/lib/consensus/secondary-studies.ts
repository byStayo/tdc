import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./history.ts";
import { readReservations, reservationAnchors, type EvaluationReservation } from "./learning-audit.ts";
import { auctionDispersionStudy } from "./auction-dispersion-study.ts";
import { analystStudy } from "./analyst-study.ts";
import { twseSectorStudy } from "./twse-sector-study.ts";
import { dealerStudy } from "./dealer-study.ts";
import { premarketStudy } from "./premarket-study.ts";
import { etfFlowStudy } from "./etf-flow-study.ts";
import { jointRetailStudy } from "./retail-joint.ts";
import { secondaryFamilyStudies } from "./secondary-family-studies.ts";
import { earningsStudy } from "./earnings-study.ts";
import type { NewCoreSettlement } from "./secondary-study.ts";
import type { HistoryEntry, Outcome } from "./types.ts";

export const publisherSecondaryStudies = [
  { name: "retail", study: jointRetailStudy },
  { name: "premarket", study: premarketStudy },
  { name: "fund-flows", study: etfFlowStudy },
  { name: "analysts", study: analystStudy },
  { name: "institutions", study: dealerStudy },
  { name: "international", study: twseSectorStudy },
  { name: "events", study: auctionDispersionStudy },
  ...secondaryFamilyStudies,
  { name: "earnings", study: earningsStudy },
] as const;

export type NativeStudyIntake = {
  firstNewOutcome: number;
  historySha256: string;
  reservationHeadsSha256: string;
};

export function nativeStudyIntake(firstNewOutcome: number, history: HistoryEntry[], reservations: EvaluationReservation[]): NativeStudyIntake {
  return { firstNewOutcome, historySha256: digest(history), reservationHeadsSha256: digest(reservationAnchors(reservations)) };
}

/** Called only by a pending native transaction before its first core release write. */
export async function stageNativeStudyIntake(root: string, transaction: string, plan: NativeStudyIntake, suffix: Outcome[]) {
  const history: HistoryEntry[] = JSON.parse(await readFile(join(root, "public/consensus/index.json"), "utf8"));
  if (digest(history) !== plan.historySha256) throw Error("The original archive index for private studies has changed");
  const reservations = await readReservations(root);
  if (digest(reservationAnchors(reservations)) !== plan.reservationHeadsSha256)
    throw Error("The original reservation heads for private studies have changed");
  const fresh: NewCoreSettlement[] = suffix.map(row => ({
    snapshotId: row.snapshotId, instrument: row.instrument, horizon: row.horizon, source: row.source,
    issuedAt: row.issuedAt, entryAt: row.entryAt, exitAt: row.exitAt, adjustment: row.adjustment, calendarVersion: row.calendarVersion,
    direction: () => row.returnPct > 0 ? 1 : 0,
  }));
  for (const { name, study } of publisherSecondaryStudies) {
    try { await study.stage(root, transaction, fresh, history, reservations); }
    catch (error) { console.error("Private secondary settlement failed for", name, error instanceof Error ? error.message : String(error)); }
  }
}
