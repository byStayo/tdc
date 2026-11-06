import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { durableDirectory, durableJSON, syncDirectory } from "../publication-storage.ts";

export interface EvaluationWrite { path: string; value: unknown; immutable?: boolean }
interface PlannedWrite extends EvaluationWrite { before: string | null; after: string }
interface Journal { schemaVersion: 1; id: string; createdAt: string; writes: PlannedWrite[]; artifacts?: Record<string, string> }
type ReleaseState = { schemaVersion: 1; transactionId: string; artifacts: Record<string, string> } &
  ({ status: "pending" } | { status: "complete"; hashes: Record<string, string | null> });
const journalPath = (root: string) => resolve(root, ".consensus/evaluation-transaction.json");
const releasePath = (root: string) => resolve(root, "lib/consensus/evaluation-state.json");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mutable = new Set(["public/consensus/outcomes.json", "public/consensus/outcome-selection.json", "lib/consensus/models.json", "lib/consensus/performance.json"]);
const immutablePath = (path: string) => /^public\/consensus\/(?:models\/[A-Za-z0-9_-]+|model-actions\/[0-9a-f-]+)\.json$/.test(path);
function checkPath(write: EvaluationWrite): void {
  if (!(mutable.has(write.path) && !write.immutable) && !(immutablePath(write.path) && write.immutable === true))
    throw new Error("Unexpected evaluation transaction destination");
}
function checkArtifacts(artifacts: Record<string, string>): void {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts) ||
      Object.entries(artifacts).some(([path, digest]) => !immutablePath(path) || !/^[a-f0-9]{64}$/.test(digest)))
    throw new Error("Invalid evaluation artifact hashes");
}
async function assertArtifactReferences(root: string, artifacts: Record<string, string>, plannedReport?: unknown): Promise<void> {
  let report = plannedReport;
  if (report === undefined) {
    try { report = JSON.parse(await readFile(resolve(root, "lib/consensus/performance.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  for (const row of (report as { learning?: { artifact?: unknown }[] }).learning ?? []) {
    if (row.artifact === undefined) continue;
    const path = `public/consensus/${row.artifact}`;
    if (typeof row.artifact !== "string" || !immutablePath(path) || !artifacts[path])
      throw new Error("Performance references an unbound evaluation artifact");
  }
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
  if (journal.artifacts !== undefined) checkArtifacts(journal.artifacts);
  return journal;
}
async function readReleaseState(root: string): Promise<ReleaseState | null> {
  // Check the marker's parent chain too; it must not redirect a write outside the tree.
  await currentHash(root, "lib/consensus/evaluation-state.json");
  let state: ReleaseState;
  try { state = JSON.parse(await readFile(releasePath(root), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (state.schemaVersion !== 1 || !/^(initial|[0-9a-f-]{36})$/.test(state.transactionId) ||
      (state.status !== "pending" && state.status !== "complete")) throw new Error("Invalid evaluation release state");
  checkArtifacts(state.artifacts);
  if (state.status === "complete" && (!state.hashes || Object.keys(state.hashes).length !== mutable.size ||
      [...mutable].some(path => state.hashes[path] !== null && !/^[a-f0-9]{64}$/.test(state.hashes[path] ?? ""))))
    throw new Error("Invalid evaluation release hashes");
  return state;
}
/** This tracked, non-secret manifest survives Git/Vercel copies without the private journal. */
export async function assertEvaluationReleaseState(root: string, required = true): Promise<void> {
  const state = await readReleaseState(root);
  if (!state) {
    if (required) throw new Error("Missing evaluation release state");
    return;
  }
  if (state.status !== "complete") throw new Error("Incomplete evaluation release; recover in the original workspace before deployment");
  for (const path of mutable) if (await currentHash(root, path) !== state.hashes[path])
    throw new Error(`Evaluation release hash mismatch: ${path}`);
  for (const [path, expected] of Object.entries(state.artifacts)) if (await currentHash(root, path) !== expected)
    throw new Error(`Evaluation artifact hash mismatch: ${path}`);
  await assertArtifactReferences(root, state.artifacts);
}
export async function assertNoPendingEvaluation(root: string): Promise<void> {
  if (await readJournal(root)) throw new Error("Incomplete evaluation transaction; run consensus:recover before publishing or building");
  await assertEvaluationReleaseState(root, false);
}

/** Caller must hold the shared publication lock. Finish the recorded writes; never rerun a model/test window. */
export async function recoverEvaluationTransaction(root: string, afterWrite?: (path: string) => void | Promise<void>): Promise<boolean> {
  const journal = await readJournal(root);
  if (!journal) { await assertEvaluationReleaseState(root, false); return false; }
  // Check every destination before replaying any step; unknown intervening edits fail closed.
  for (const write of journal.writes) {
    const current = await currentHash(root, write.path);
    if (current !== write.before && current !== write.after) throw new Error("Evaluation recovery conflicts with an intervening file change");
    if (write.immutable && write.before !== null && write.before !== write.after) throw new Error("Immutable evaluation artifact cannot be replaced");
  }
  const release = await readReleaseState(root);
  if (release?.status === "pending" && release.transactionId !== journal.id) throw new Error("Evaluation release belongs to another transaction");
  const artifacts = { ...(journal.artifacts ?? release?.artifacts ?? {}) };
  for (const write of journal.writes.filter(write => write.immutable)) {
    if (artifacts[write.path] && artifacts[write.path] !== write.after) throw new Error("Immutable evaluation artifact hash changed");
    artifacts[write.path] = write.after;
  }
  for (const [path, expected] of Object.entries(artifacts)) {
    if (!journal.writes.some(write => write.immutable && write.path === path) && await currentHash(root, path) !== expected)
      throw new Error(`Evaluation artifact hash mismatch: ${path}`);
  }
  await assertArtifactReferences(root, artifacts, journal.writes.find(write => write.path === "lib/consensus/performance.json")?.value);
  // Durable tracked marker BEFORE any output changes; remote builds reject incomplete exports.
  await durableJSON(releasePath(root), { schemaVersion: 1, transactionId: journal.id, status: "pending", artifacts } satisfies ReleaseState);
  for (const write of journal.writes) {
    if (await currentHash(root, write.path) !== write.after) await durableJSON(resolve(root, write.path), write.value, write.immutable);
    await afterWrite?.(write.path);
  }
  const hashes: Record<string, string | null> = {};
  for (const path of mutable) hashes[path] = await currentHash(root, path);
  // Hashes also catch selectively committing changed outputs without their new release marker.
  await durableJSON(releasePath(root), { schemaVersion: 1, transactionId: journal.id, status: "complete", hashes, artifacts } satisfies ReleaseState);
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
  const artifacts = { ...(await readReleaseState(root))?.artifacts };
  for (const write of planned.filter(write => write.immutable)) artifacts[write.path] = write.after;
  await assertArtifactReferences(root, artifacts, planned.find(write => write.path === "lib/consensus/performance.json")?.value);
  await durableJSON(journalPath(root), { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), writes: planned, artifacts } satisfies Journal, true);
  await recoverEvaluationTransaction(root, afterWrite);
}
