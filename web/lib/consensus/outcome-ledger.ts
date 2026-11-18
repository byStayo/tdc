import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { outcomeKey, selectScoredOutcomes } from "./evaluation.ts";
import { HORIZONS, INSTRUMENTS, type Outcome } from "./types.ts";

export const PUBLIC_OUTCOME_INDEX = "public/consensus/outcomes.json";
export const PRIVATE_OUTCOME_LEDGER = ".consensus/private-evaluation/outcomes.json";
export const EVALUATION_RELEASE_STATE = "lib/consensus/evaluation-state.json";
export const COMPLETED_EVALUATIONS = ".consensus/evaluation-transactions";
type OutcomeIdentity = Pick<Outcome, "snapshotId" | "instrument" | "horizon" | "engineVersion">;

export function outcomeIndex(outcomes: Outcome[]): OutcomeIdentity[] {
  return outcomes.map(({ snapshotId, instrument, horizon, engineVersion }) => ({ snapshotId, instrument, horizon, engineVersion }));
}

export function validateOutcomeIndex(value: unknown): asserts value is OutcomeIdentity[] {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" ||
      Object.keys(row).length !== 4 || !["snapshotId", "instrument", "horizon", "engineVersion"].every(key => Object.hasOwn(row, key)) ||
      typeof row.snapshotId !== "string" || !/^[0-9TZ-]{20,30}$/.test(row.snapshotId) ||
      !INSTRUMENTS.includes(row.instrument) || row.instrument === "MARKET" ||
      !HORIZONS.includes(row.horizon) || typeof row.engineVersion !== "string" ||
      !/^consensus-rules-\d+\.\d+\.\d+$/.test(row.engineVersion)) || new Set(value.map(outcomeKey)).size !== value.length)
    throw new Error("Public outcome index must contain unique edition identities only");
}

function isFullOutcome(row: unknown): row is Outcome {
  if (!row || typeof row !== "object") return false;
  const { entry, exit, returnPct } = row as Partial<Outcome>;
  return typeof entry === "number" && Number.isFinite(entry) && entry > 0 &&
    typeof exit === "number" && Number.isFinite(exit) && exit > 0 && Number.isFinite(returnPct);
}

export function verifyPairedOutcomes(index: unknown, ledger: unknown): asserts ledger is Outcome[] {
  validateOutcomeIndex(index);
  if (!Array.isArray(ledger) || !ledger.every(isFullOutcome) || JSON.stringify(outcomeIndex(ledger)) !== JSON.stringify(index))
    throw new Error("Private evaluation ledger differs from the public outcome index");
  selectScoredOutcomes(ledger);
}

async function optionalJSON(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Caller holds the evaluation lock, or is running the read-only local completion audit. */
export async function loadEvaluationOutcomes(root: string): Promise<Outcome[]> {
  const index = await optionalJSON(resolve(root, PUBLIC_OUTCOME_INDEX)) ?? [];
  const path = resolve(root, PRIVATE_OUTCOME_LEDGER);
  const directory = await lstat(dirname(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (directory && (!directory.isDirectory() || directory.mode & 0o077))
    throw new Error("Evaluation ledger directory must be owner-only");
  const stat = directory ? await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }) : null;
  if (stat && (!stat.isFile() || stat.mode & 0o077)) throw new Error("Evaluation ledger must be owner-only");
  // A release from the previous evaluator can be migrated once without changing its actual labels.
  if (!stat && Array.isArray(index) && index.length && index.every(isFullOutcome)) {
    verifyPairedOutcomes(outcomeIndex(index), index);
    return index;
  }
  const ledger = stat ? JSON.parse(await readFile(path, "utf8")) : [];
  verifyPairedOutcomes(index, ledger);
  if (stat) {
    const state = await optionalJSON(resolve(root, EVALUATION_RELEASE_STATE)) as { outcomeLedgerTransactionId?: unknown } | null;
    const id = state?.outcomeLedgerTransactionId;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Private outcomes lack a completed evaluation transaction");
    const receipt = await optionalJSON(resolve(root, COMPLETED_EVALUATIONS, `${id}.json`)) as {
      id?: string; writes?: { path: string; after: string }[];
    } | null;
    const hash = createHash("sha256").update(JSON.stringify(ledger)).digest("hex");
    if (receipt?.id !== id || !receipt.writes?.some(write => write.path === PRIVATE_OUTCOME_LEDGER && write.after === hash))
      throw new Error("Private outcomes differ from their completed evaluation transaction");
  }
  return ledger;
}
