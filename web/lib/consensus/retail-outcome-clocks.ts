import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "./history.ts";
import { EVALUATION_RELEASE_STATE, PUBLIC_OUTCOME_INDEX, validateOutcomeIndex } from "./outcome-ledger.ts";
import { PRIVATE_OUTCOME_AVAILABILITY } from "./outcome-availability.ts";
import { completedOutcomeWriteSeals } from "./prospective-family-outcomes.ts";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const iso = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Verify only the current outcome index, journal headers and owner-only availability metadata.
 * No slot in the production price ledger is opened to establish a research cutoff.
 * A completed legacy transaction without clock metadata cannot establish availability. */
export async function readRetailOutcomeClocks(root: string, index: unknown, transaction: string): Promise<readonly string[] | null> {
  validateOutcomeIndex(index);
  const indexHash = digest(index);
  const state = JSON.parse(await readFile(join(root, EVALUATION_RELEASE_STATE), "utf8"));
  if (state?.status !== "complete" || state.outcomeLedgerTransactionId !== transaction ||
      state.hashes?.[PUBLIC_OUTCOME_INDEX] !== indexHash)
    throw Error("Retail outcome clocks require the current completed outcome index");
  const header = await completedOutcomeWriteSeals(root, transaction, indexHash);
  const expected = header.after.get(PRIVATE_OUTCOME_AVAILABILITY);
  const path = join(root, PRIVATE_OUTCOME_AVAILABILITY);
  const dir = await lstat(dirname(path)).catch((e: unknown) => { if (missing(e)) return null; throw e; });
  if (dir && (!dir.isDirectory() || dir.mode & 0o077)) throw Error("Retail outcome clocks require an owner-only directory");
  const handle = dir && await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: unknown) => {
    if (missing(e)) return null;
    throw e;
  });
  if (!handle) {
    if (expected) throw Error("Missing sealed retail outcome clocks");
    return null;
  }
  try {
    if (!expected) throw Error("Unsealed retail outcome clocks");
    const stat = await handle.stat();
    // The writer emits one ISO timestamp per identity. Bound the read to that index even decades into the study.
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 1024 + 48 * index.length)
      throw Error("Retail outcome clocks require a bounded owner-only metadata file");
    const clocks = JSON.parse(await handle.readFile("utf8"));
    if (clocks?.schemaVersion !== 1 || Object.keys(clocks).length !== 3 ||
        clocks.ledgerSha256 !== header.ledgerSha256 || digest(clocks) !== expected ||
        !Array.isArray(clocks.knownAt) || clocks.knownAt.length !== index.length || !clocks.knownAt.every(iso))
      throw Error("Retail availability clocks differ from their completed ledger and public index");
    return clocks.knownAt;
  } finally {
    await handle.close();
  }
}
