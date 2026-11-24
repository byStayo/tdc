import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "./history.ts";
import { outcomeKey } from "./evaluation.ts";
import { COMPLETED_EVALUATIONS, EVALUATION_RELEASE_STATE, PRIVATE_OUTCOME_LEDGER, PUBLIC_OUTCOME_INDEX, outcomeIndex } from "./outcome-ledger.ts";
import type { Outcome } from "./types.ts";

export const PRIVATE_OUTCOME_AVAILABILITY = ".consensus/private-evaluation/label-availability.json";
export type OutcomeAvailability = { schemaVersion: 1; ledgerSha256: string; knownAt: string[] };
const canonical = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function validateOutcomeAvailability(value: unknown, outcomes: Outcome[], asOf: string): asserts value is OutcomeAvailability {
  const receipt = value as Partial<OutcomeAvailability> | null;
  if (!canonical(asOf) || receipt?.schemaVersion !== 1 || receipt.ledgerSha256 !== digest(outcomes) ||
      !Array.isArray(receipt.knownAt) || receipt.knownAt.length !== outcomes.length ||
      receipt.knownAt.some((at, i) => !canonical(at) || !canonical(outcomes[i].exitAt) || at < outcomes[i].exitAt || at > asOf))
    throw Error("Outcome availability differs from the original ledger, market close or verification time");
}

export function outcomeAvailability(outcomes: Outcome[], knownAt: string[]): OutcomeAvailability {
  const receipt = { schemaVersion: 1 as const, ledgerSha256: digest(outcomes), knownAt };
  validateOutcomeAvailability(receipt, outcomes, new Date().toISOString());
  return receipt;
}

export function outcomeClockMap(outcomes: Outcome[], receipt: OutcomeAvailability) {
  validateOutcomeAvailability(receipt, outcomes, new Date().toISOString());
  return new Map(outcomes.map((row, i) => [outcomeKey(row), receipt.knownAt[i]]));
}

/** The chronological gate requires a strictly earlier receipt. Sample the wall clock again if both steps share a millisecond. */
export async function observationCutoff(verifiedAt: string): Promise<string> {
  if (new Date().toISOString() === verifiedAt) await new Promise(resolve => setTimeout(resolve, 1));
  return new Date().toISOString();
}

/** Retain clocks only for exactly reproduced research outcomes. A revised vendor observation needs its own clock. */
export function researchOutcomeAvailability(outcomes: Outcome[], observedAt: string, previous?: { outcomes: Outcome[]; availability?: OutcomeAvailability }) {
  const prior = new Map<string, { checksum: string; at: string }>();
  if (previous?.availability) {
    validateOutcomeAvailability(previous.availability, previous.outcomes, observedAt);
    previous.outcomes.forEach((row, i) => prior.set(outcomeKey(row), { checksum: digest(row), at: previous.availability!.knownAt[i] }));
  }
  return outcomeAvailability(outcomes, outcomes.map(row => {
    const old = prior.get(outcomeKey(row));
    return old && old.checksum === digest(row) ? old.at : observedAt;
  }));
}

type Journal = { id: string; schemaVersion: number; createdAt: string; writes: { path: string; after: string; value: unknown }[] };
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function privateJSON<T>(path: string): Promise<T | null> {
  try {
    const [file, directory] = await Promise.all([lstat(path), lstat(dirname(path))]);
    if (!file.isFile() || file.mode & 0o077 || !directory.isDirectory() || directory.mode & 0o077) throw Error("Owner-only evaluation receipt required");
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) { if (missing(e)) return null; throw e; }
}

/** Caller holds the evaluation lock. Originally only the completed journals recorded when the prices were in hand. */
export async function loadOutcomeAvailability(root: string, outcomes: Outcome[], observedAt: string): Promise<OutcomeAvailability> {
  const file = join(root, PRIVATE_OUTCOME_AVAILABILITY), directory = join(root, COMPLETED_EVALUATIONS);
  const saved = await privateJSON<OutcomeAvailability>(file);
  const state = await readFile(join(root, EVALUATION_RELEASE_STATE), "utf8").then(t => JSON.parse(t) as { status: string; outcomeLedgerTransactionId?: string })
    .catch((e: unknown) => { if (missing(e)) return null; throw e; });
  const id = state?.outcomeLedgerTransactionId;
  if (!id) {
    if (saved) throw Error("Outcome availability lacks its completed transaction");
    // Legacy public-only ledgers have no original receipt. The time of this verified read is a conservative bound.
    return outcomeAvailability(outcomes, outcomes.map(() => observedAt));
  }
  if (!uuid.test(id) || state?.status !== "complete") throw Error("Incomplete outcome availability transaction");
  const head = await privateJSON<Journal>(join(directory, id + ".json"));
  const ledgerHash = digest(outcomes);
  if (head?.id !== id || !canonical(head.createdAt) || head.createdAt > observedAt ||
      !head.writes.some(w => w.path === PRIVATE_OUTCOME_LEDGER && w.after === ledgerHash && digest(w.value) === ledgerHash))
    throw Error("Outcome availability lacks the original completed ledger");
  const bound = head.writes.find(w => w.path === PRIVATE_OUTCOME_AVAILABILITY);
  if (bound || saved) {
    if (!saved || !bound || bound.after !== digest(saved) || digest(bound.value) !== bound.after) throw Error("Private outcome availability differs from its sealed transaction");
    validateOutcomeAvailability(saved, outcomes, observedAt);
    return saved;
  }

  // One-time migration. A completed historical journal proves an earlier clock only for a byte-equivalent
  // ledger prefix and its independently bound public identities. Unrelated or corrected runs confer no earlier clock.
  const dates = outcomes.map(() => head.createdAt);
  const prefixes = new Map<number, { ledger: string; index: string }>();
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) continue;
    const j = name === id + ".json" ? head : await privateJSON<Journal>(join(directory, name));
    if (!j || j.schemaVersion !== 1 || j.id + ".json" !== name || !canonical(j.createdAt) || j.createdAt > head.createdAt) continue;
    const ledger = j.writes.find(w => w.path === PRIVATE_OUTCOME_LEDGER), index = j.writes.find(w => w.path === PUBLIC_OUTCOME_INDEX);
    if (!ledger || !index || !Array.isArray(ledger.value) || !ledger.value.length || ledger.value.length > outcomes.length) continue;
    const n = ledger.value.length;
    let prefix = prefixes.get(n);
    if (!prefix) {
      const subset = outcomes.slice(0, n);
      prefix = { ledger: digest(subset), index: digest(outcomeIndex(subset)) };
      prefixes.set(n, prefix);
    }
    if (ledger.after !== prefix.ledger || index.after !== prefix.index || digest(ledger.value) !== ledger.after || digest(index.value) !== index.after) continue;
    if (outcomes.slice(0, n).some(row => j.createdAt < row.exitAt)) throw Error("Completed price evidence predates the market close");
    for (let i = 0; i < n; i++) if (j.createdAt < dates[i]) dates[i] = j.createdAt;
  }
  return outcomeAvailability(outcomes, dates);
}
