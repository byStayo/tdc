import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { durableDirectory, durableJSON, syncDirectory } from "../publication-storage.ts";

export interface EvaluationWrite { path: string; value: unknown; immutable?: boolean }
interface PlannedWrite extends EvaluationWrite { before: string | null; after: string }
interface Journal { schemaVersion: 1; id: string; createdAt: string; writes: PlannedWrite[] }
const journalPath = (root: string) => resolve(root, ".consensus/evaluation-transaction.json");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mutable = new Set(["public/consensus/outcomes.json", "public/consensus/outcome-selection.json", "lib/consensus/models.json", "lib/consensus/performance.json"]);
function checkPath(write: EvaluationWrite): void {
  const immutable = /^public\/consensus\/(?:models\/[A-Za-z0-9_-]+|model-actions\/[0-9a-f-]+)\.json$/.test(write.path);
  if (!(mutable.has(write.path) && !write.immutable) && !(immutable && write.immutable === true))
    throw new Error("Unexpected evaluation transaction destination");
}
async function currentHash(root: string, path: string): Promise<string | null> {
  const absolute = resolve(root, path);
  // Prevent a local symlink from redirecting the reviewed destinations outside this tree.
  let check = absolute;
  while (check !== resolve(root)) {
    try { if ((await lstat(check)).isSymbolicLink()) throw new Error("Symlink in evaluation transaction destination"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    check = dirname(check);
  }
  try { return hash(JSON.parse(await readFile(absolute, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function readJournal(root: string): Promise<Journal | null> {
  let journal: Journal;
  try { journal = JSON.parse(await readFile(journalPath(root), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (journal.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/.test(journal.id) || !Array.isArray(journal.writes) || !journal.writes.length ||
      new Set(journal.writes.map(write => write.path)).size !== journal.writes.length)
    throw new Error("Invalid evaluation recovery journal");
  for (const write of journal.writes) {
    checkPath(write);
    if (write.after !== hash(write.value) || (write.before !== null && !/^[a-f0-9]{64}$/.test(write.before)))
      throw new Error("Evaluation recovery journal hash mismatch");
  }
  return journal;
}
export async function assertNoPendingEvaluation(root: string): Promise<void> {
  if (await readJournal(root)) throw new Error("Incomplete evaluation transaction; run consensus:recover before publishing or building");
}

/** Caller must hold the shared publication lock. Finish the recorded writes; never rerun a model/test window. */
export async function recoverEvaluationTransaction(root: string, afterWrite?: (path: string) => void | Promise<void>): Promise<boolean> {
  const journal = await readJournal(root);
  if (!journal) return false;
  // Check every destination before replaying any step; unknown intervening edits fail closed.
  for (const write of journal.writes) {
    const current = await currentHash(root, write.path);
    if (current !== write.before && current !== write.after) throw new Error("Evaluation recovery conflicts with an intervening file change");
    if (write.immutable && write.before !== null && write.before !== write.after) throw new Error("Immutable evaluation artifact cannot be replaced");
  }
  for (const write of journal.writes) {
    if (await currentHash(root, write.path) !== write.after) await durableJSON(resolve(root, write.path), write.value, write.immutable);
    await afterWrite?.(write.path);
  }
  const completed = resolve(root, ".consensus/evaluation-transactions", `${journal.id}.json`);
  await durableDirectory(dirname(completed), 0o700);
  // All files are durable before the pending marker is removed.
  await rename(journalPath(root), completed);
  await syncDirectory(dirname(completed));
  await syncDirectory(dirname(journalPath(root)));
  return true;
}

/** Recoverable group commit for local evaluation outputs, guarded by prebuild before deployment. */
export async function commitEvaluationTransaction(root: string, writes: EvaluationWrite[], afterWrite?: (path: string) => void | Promise<void>): Promise<void> {
  await assertNoPendingEvaluation(root);
  if (!writes.length || new Set(writes.map(write => write.path)).size !== writes.length) throw new Error("Empty or duplicate evaluation write set");
  const planned: PlannedWrite[] = [];
  for (const write of writes) {
    checkPath(write);
    const before = await currentHash(root, write.path), after = hash(write.value);
    if (write.immutable && before !== null && before !== after) throw new Error("Immutable evaluation artifact cannot be replaced");
    planned.push({ ...write, before, after });
  }
  await durableJSON(journalPath(root), { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), writes: planned } satisfies Journal, true);
  await recoverEvaluationTransaction(root, afterWrite);
}
