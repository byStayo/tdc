import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { effectiveStatus } from "../lib/consensus/engines/v2.ts";
import { ETF_FLOW_PREFIX } from "../lib/consensus/etf-flows.ts";
import { selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { PROSPECTIVE_MINIMUM } from "../lib/consensus/learning-audit.ts";
import { FAMILIES } from "../lib/consensus/registry.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import type { Instrument, Outcome } from "../lib/consensus/types.ts";

const futuresByETF = {
  SPY: "13874A",
  QQQ: "209742",
  IWM: "239742",
  DIA: "124603",
  TLT: "020601",
} as const;
const root = fileURLToPath(new URL("../", import.meta.url));
const { snapshots } = await verifyPublicationTree(root);
const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
const saved = JSON.parse(await readFile(resolve(root, ".consensus/private-kibot/evaluation.json"), "utf8"));
if (saved.schemaVersion !== 2 || !Array.isArray(saved.outcomes) ||
    saved.outcomes.some((row: Outcome) => {
      const snapshot = byId.get(row.snapshotId);
      return row.horizon !== "daily" || !snapshot ||
        snapshot.engineVersion !== row.engineVersion || snapshot.issuedAt !== row.issuedAt;
    }))
  throw new Error("Private outcome ledger differs from verified history");

const { policy, selected } = selectScoredOutcomes(saved.outcomes);
const groups = Object.entries(futuresByETF).flatMap(([instrument, contract]) => {
  const sessions = selected.filter(row => row.instrument === instrument);
  const candidates = [
    { family: "capital", id: ETF_FLOW_PREFIX + instrument, points: 1 },
    { family: "institutions", id: `cftc-${contract}-asset`, points: 2 },
  ];
  return candidates.map(({ family, id, points }) => {
    const dates: string[] = [];
    for (const session of sessions) {
      const signal = byId.get(session.snapshotId)!.signals.find(signal => signal.id === id);
      if (!signal || effectiveStatus(signal, session.issuedAt) !== "available" ||
          Date.parse(signal.source.retrievedAt) > Date.parse(session.issuedAt) ||
          (signal.source.releasedAt && Date.parse(signal.source.releasedAt) > Date.parse(session.issuedAt))) continue;
      const tail = signal.series.slice(-points);
      if (tail.length !== points || tail.some(point =>
        !Number.isFinite(point.value) || point.date > newYorkDate(session.issuedAt))) continue;
      dates.push(tail.at(-1)!.date);
    }
    return { instrument, family, selectedSessions: sessions.length, pairedSessions: dates.length,
      distinctObservationDates: new Set(dates).size };
  });
});

const familyGroups = (Object.keys(futuresByETF) as Instrument[]).flatMap(instrument => {
  const sessions = selected.filter(row => row.instrument === instrument);
  const issued = sessions.map(session => {
    const snapshot = byId.get(session.snapshotId)!;
    const cutoff = Date.parse(snapshot.cutoff);
    const observations = snapshot.signals.filter(signal =>
      signal.instruments.includes(instrument) &&
      effectiveStatus(signal, snapshot.cutoff) === "available" &&
      Date.parse(signal.source.retrievedAt) <= cutoff &&
      (!signal.source.releasedAt || Date.parse(signal.source.releasedAt) <= cutoff));
    return { observations, readings: asIssuedConsensus(snapshot, instrument, "daily").families };
  });
  return FAMILIES.map(({ id: family }) => {
    const observations = issued.map(row => row.observations.filter(signal => signal.family === family));
    return { instrument, family, selectedSessions: sessions.length,
      pairedObservationSessions: observations.filter(signals => signals.length > 0).length,
      pairedVoteSessions: issued.filter(row => row.readings.some(reading =>
        reading.id === family && reading.score !== null)).length,
      distinctObservationDates: new Set(observations.flatMap(signals =>
        signals.map(signal => signal.source.observedAt!.slice(0, 10)))).size };
  });
});

// Count coverage only. Do not inspect returns or consume a holdout reservation.
console.log(JSON.stringify({ scope: "private-pairing-only", policy, horizon: "daily",
  minimumEligibleModelRows: PROSPECTIVE_MINIMUM, groups, familyGroups }, null, 2));
