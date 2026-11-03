import type { Consensus, Horizon, Instrument, Snapshot } from "./types.ts";
import { HORIZONS, INSTRUMENTS } from "./types.ts";
import { calculateConsensus as calculateV1 } from "./engines/v1.ts";
import { calculateConsensus as calculateV2 } from "./engine.ts";

/** Legacy archives remain byte-for-byte unchanged; only their recorded engine may read them. */
export function versionedConsensus(snapshot: Snapshot, instrument: Instrument, horizon: Horizon): Consensus {
  switch (snapshot.engineVersion) {
    case "consensus-rules-1.0.0":
    case "consensus-rules-1.1.0":
      return calculateV1(snapshot.signals, instrument, horizon, snapshot.cutoff);
    case "consensus-rules-2.0.0":
      return calculateV2(snapshot.signals, instrument, horizon, snapshot.cutoff);
    default:
      throw new Error(`Unsupported as-issued engine: ${snapshot.engineVersion}`);
  }
}

export function asIssuedConsensus(snapshot: Snapshot, instrument: Instrument, horizon: Horizon): Consensus {
  if (snapshot.consensus) {
    const stored = snapshot.consensus.filter((item) => item.instrument === instrument && item.horizon === horizon);
    if (stored.length !== 1) throw new Error("Missing or duplicate as-issued consensus");
    return stored[0];
  }
  return versionedConsensus(snapshot, instrument, horizon);
}

export function freezeConsensus(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    consensus: INSTRUMENTS.flatMap((instrument) =>
      HORIZONS.map((horizon) => versionedConsensus(snapshot, instrument, horizon)),
    ),
  };
}

export function validateConsensusRecords(snapshot: Snapshot, derive: boolean): void {
  if (!snapshot.consensus) return;
  const records = snapshot.consensus;
  if (!Array.isArray(records) || records.length !== INSTRUMENTS.length * HORIZONS.length ||
      new Set(records.map((r) => `${r.instrument}:${r.horizon}`)).size !== records.length)
    throw new Error("Incomplete or duplicate as-issued consensus records");
  const bounded = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  for (const record of records) {
    if (!INSTRUMENTS.includes(record.instrument) || !HORIZONS.includes(record.horizon) ||
        !bounded(record.coverage, 0, 1) || (record.score !== null && !bounded(record.score, -1, 1)) ||
        (record.directionalCoverage !== undefined && !bounded(record.directionalCoverage, 0, 1)) ||
        (record.agreement !== null && !bounded(record.agreement, 0, 1)) ||
        typeof record.abstain !== "boolean" || !record.label ||
        !Array.isArray(record.reasons) || record.reasons.some((reason) => typeof reason !== "string" || !reason) ||
        !Array.isArray(record.families) || !record.families.length ||
        new Set(record.families.map((f) => f.id)).size !== record.families.length ||
        [record.bullish, record.bearish, record.neutral].some((n) => !Number.isInteger(n) || n < 0) ||
        record.families.some((f) => !f.id || !f.label || !bounded(f.weight, 0, 1e6) ||
          !Number.isInteger(f.expected) || f.expected < 1 || !Number.isInteger(f.available) ||
          f.available < 0 || f.available > f.expected || (f.score !== null && !bounded(f.score, -1, 1)) ||
          !["available", "stale", "unavailable", "not_formed"].includes(f.status)))
      throw new Error("Invalid as-issued consensus record");
    const voters = record.families.filter(f => f.score !== null), weight = voters.reduce((sum, f) => sum + f.weight, 0);
    const expectedScore = weight ? voters.reduce((sum, f) => sum + f.score! * f.weight, 0) / weight : null;
    const bullish = voters.filter(f => f.score! > 0.1).length, bearish = voters.filter(f => f.score! < -0.1).length;
    if (record.abstain !== (record.reasons.length > 0) ||
        (record.abstain && record.label !== "Incomplete picture") ||
        (!record.abstain && record.label === "Incomplete picture") ||
        record.bullish !== bullish || record.bearish !== bearish || record.neutral !== voters.length - bullish - bearish ||
        (record.score === null) !== (expectedScore === null) ||
        (record.score !== null && expectedScore !== null && Math.abs(record.score - expectedScore) > 1e-12))
      throw new Error("Inconsistent as-issued consensus record");
    if (derive && JSON.stringify(record) !== JSON.stringify(versionedConsensus(snapshot, record.instrument, record.horizon)))
      throw new Error("As-issued consensus differs from its recorded engine");
  }
}
