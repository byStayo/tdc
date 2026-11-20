import { fileURLToPath } from "node:url";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { effectiveStatus } from "../lib/consensus/engines/v2.ts";
import { ETF_FLOW_PREFIX } from "../lib/consensus/etf-flows.ts";
import { SCORING_POLICY } from "../lib/consensus/evaluation.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { readPrivateResearchSessions } from "../lib/consensus/kibot-verified-session.ts";
import { PROSPECTIVE_MINIMUM } from "../lib/consensus/learning-audit.ts";
import { FAMILIES } from "../lib/consensus/registry.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import type { Instrument } from "../lib/consensus/types.ts";

const futuresByETF = {
  SPY: "13874A",
  QQQ: "209742",
  IWM: "239742",
  DIA: "124603",
  TLT: "020601",
} as const;
const root = fileURLToPath(new URL("../", import.meta.url));
const { current, snapshots } = await verifyPublicationTree(root);
const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
const { checked } = await readPrivateResearchSessions(root, snapshots, current.engineVersion);
const selected = checked.selections;
const groups = Object.entries(futuresByETF).flatMap(([instrument, contract]) => {
  const sessions = selected.filter(row => row.instrument === instrument);
  const candidates = [
    { family: "capital", id: ETF_FLOW_PREFIX + instrument, points: 1 },
    { family: "institutions", id: `cftc-${contract}-asset`, points: 2 },
  ];
  return candidates.map(({ family, id, points }) => {
    const dates: string[] = [];
    for (const session of sessions) {
      const snapshot = byId.get(session.edition)!;
      const signal = snapshot.signals.find(signal => signal.id === id);
      if (!signal || effectiveStatus(signal, snapshot.cutoff) !== "available" ||
          Date.parse(signal.source.retrievedAt) > Date.parse(snapshot.cutoff) ||
          (signal.source.releasedAt && Date.parse(signal.source.releasedAt) > Date.parse(snapshot.cutoff))) continue;
      const tail = signal.series.slice(-points);
      if (tail.length !== points || tail.some(point =>
        !Number.isFinite(point.value) || point.date > newYorkDate(snapshot.cutoff))) continue;
      dates.push(tail.at(-1)!.date);
    }
    return { instrument, family, selectedSessions: sessions.length, pairedSessions: dates.length,
      distinctObservationDates: new Set(dates).size };
  });
});

const familyGroups = (Object.keys(futuresByETF) as Instrument[]).flatMap(instrument => {
  const sessions = selected.filter(row => row.instrument === instrument);
  const issued = sessions.map(session => {
    const snapshot = byId.get(session.edition)!;
    const cutoff = Date.parse(snapshot.cutoff);
    const observations = snapshot.signals.filter(signal =>
      signal.instruments.includes(instrument) &&
      effectiveStatus(signal, snapshot.cutoff) === "available" &&
      Date.parse(signal.source.retrievedAt) <= cutoff &&
      (!signal.source.releasedAt || Date.parse(signal.source.releasedAt) <= cutoff));
    return { inputEligible: session.inputEligible, observations, readings: asIssuedConsensus(snapshot, instrument, "daily").families };
  });
  const inputEligibleSessions = issued.filter(row => row.inputEligible).length;
  return FAMILIES.map(({ id: family }) => {
    const observations = issued.map(row => row.observations.filter(signal => signal.family === family));
    return { instrument, family, selectedSessions: sessions.length,
      inputEligibleSessions,
      pairedInputEligibleObservationSessions: observations.filter((signals, index) => signals.length > 0 && issued[index].inputEligible).length,
      pairedObservationSessions: observations.filter(signals => signals.length > 0).length,
      pairedVoteSessions: issued.filter(row => row.readings.some(reading =>
        reading.id === family && reading.score !== null)).length,
      distinctObservationDates: new Set(observations.flatMap(signals =>
        signals.map(signal => signal.source.observedAt!.slice(0, 10)))).size };
  });
});

// Family pairing uses only the as-issued observations and verified settlement identities.
console.log(JSON.stringify({ scope: "private-pairing-only", policy: SCORING_POLICY, horizon: "daily", through: checked.through,
  minimumEligibleModelRows: PROSPECTIVE_MINIMUM, groups, familyGroups }, null, 2));
