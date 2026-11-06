import { INSTRUMENTS, type Instrument } from "./consensus/types.ts";
import type { BlueskySample, CueCounts } from "./consensus/bluesky.ts";

export const COMMUNITY_CONTACT = "support@thedailyconsensus.com";
export const COMMUNITY_LABELS = { upward: "Upward language", downward: "Downward language", mixed: "Mixed language", unclassified: "Unclassified" } as const;
export interface CommunitySample {
  schemaVersion: 1;
  method: "bluesky-language-cues-v1";
  id: string;
  startedAt: string;
  endedAt: string;
  expiresAt: string;
  receivedEvents: number;
  minimumParticipants: 10;
  readings: { instrument: Instrument; participants: number; distribution: CueCounts | null }[];
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join("|") === [...expected].sort().join("|");
const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
/** Strict allowlist prevents accidentally shipping stream content or account identifiers. */
export function validateCommunity(value: unknown): asserts value is CommunitySample {
  if (!isObject(value) || !keys(value, ["schemaVersion", "method", "id", "startedAt", "endedAt", "expiresAt", "receivedEvents", "minimumParticipants", "readings"])) throw new Error("Invalid community aggregate");
  if (value.schemaVersion !== 1 || value.method !== "bluesky-language-cues-v1" || value.minimumParticipants !== 10 || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id) || !integer(value.receivedEvents) || value.receivedEvents === 0) throw new Error("Invalid community aggregate metadata");
  for (const date of [value.startedAt, value.endedAt, value.expiresAt]) if (typeof date !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error("Invalid community dates");
  const start = Date.parse(value.startedAt as string), end = Date.parse(value.endedAt as string), expires = Date.parse(value.expiresAt as string);
  if (end - start < 10_000 || end - start > 901_000 || expires - end !== 86_400_000) throw new Error("Invalid community window");
  if (!Array.isArray(value.readings) || value.readings.length !== INSTRUMENTS.length) throw new Error("Invalid community readings");
  const marketCount = (value.readings[0] as Record<string, unknown>)?.participants;
  if (!integer(marketCount) || marketCount < 10) throw new Error("Insufficient community sample for publication");
  value.readings.forEach((row, i) => {
    if (!isObject(row) || !keys(row, ["instrument", "participants", "distribution"]) || row.instrument !== INSTRUMENTS[i] || !integer(row.participants) || row.participants > marketCount || row.participants > Number(value.receivedEvents)) throw new Error("Invalid community row");
    if (row.participants < 10) { if (row.distribution !== null) throw new Error("Small sample must be suppressed"); }
    else {
      if (!isObject(row.distribution) || !keys(row.distribution, Object.keys(COMMUNITY_LABELS)) || Object.values(row.distribution).some((v) => !integer(v)) || Object.values(row.distribution).reduce<number>((sum, v) => sum + Number(v), 0) !== row.participants) throw new Error("Invalid community distribution");
    }
  });
}
export function publicCommunity(sample: BlueskySample, now = Date.now()): CommunitySample {
  if (sample.malformedEvents > sample.receivedEvents * 0.01 || sample.status !== "sampled") throw new Error("Unverified community sample");
  const result = { schemaVersion: 1 as const, method: sample.method, id: sample.sourceDigest, startedAt: sample.startedAt, endedAt: sample.endedAt, expiresAt: sample.expiresAt, receivedEvents: sample.receivedEvents, minimumParticipants: sample.minimumParticipants, readings: sample.readings.map((r) => ({ instrument: r.instrument, participants: r.participants, distribution: r.distribution ? { upward: r.distribution.upward, downward: r.distribution.downward, mixed: r.distribution.mixed, unclassified: r.distribution.unclassified } : null })) };
  validateCommunity(result);
  if (Date.parse(result.endedAt) > now + 10_000 || Date.parse(result.expiresAt) <= now) throw new Error("Community sample is expired or future dated");
  return result;
}
export function currentCommunity(value: unknown, now = Date.now()): CommunitySample | null {
  if (value === null) return null;
  validateCommunity(value);
  return Date.parse(value.endedAt) > now + 10_000 || Date.parse(value.expiresAt) <= now ? null : value;
}
