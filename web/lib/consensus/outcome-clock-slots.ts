import { constants, createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { digest } from "./history.ts";
import { COMPLETED_EVALUATIONS, EVALUATION_RELEASE_STATE, PRIVATE_OUTCOME_LEDGER, PUBLIC_OUTCOME_INDEX, validateOutcomeIndex } from "./outcome-ledger.ts";
import { PRIVATE_OUTCOME_AVAILABILITY } from "./outcome-availability.ts";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const iso = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export async function ownerSettlementLines(path: string) {
  const [file,dir] = await Promise.all([lstat(path),lstat(dirname(path))]);
  if (!file.isFile() || file.mode & 0o077 || !dir.isDirectory() || dir.mode & 0o077)
    throw Error("Owner-only regular settlement evidence required");
  return createInterface({input:createReadStream(path,{ encoding:"utf8" }),crlfDelay:Infinity});
}

/** The completed transaction can contain other outcomes. Read only its path, identity and digest fields. */
export async function completedOutcomeWriteSeals(root: string, transaction: string, indexHash: string) {
  if (!/^[a-f0-9-]{36}$/.test(transaction)) throw Error("No completed production outcome transaction");
  const stream = await ownerSettlementLines(resolve(root, COMPLETED_EVALUATIONS, transaction + ".json"));
  let id: string | undefined, path: string | undefined;
  const seals = new Map<string,string>();
  for await (const line of stream) {
    if (line.startsWith('  "id": ')) id = JSON.parse(line.trim().slice(6).replace(/,$/,""));
    if (line === "    {" || line === "    }," || line === "    }") path = undefined;
    const dest = /^      "path": "([^"]+)",$/.exec(line);
    if (dest) path = dest[1];
    const after = /^      "after": "([a-f0-9]{64})",?$/.exec(line);
    if (path && after) {
      if (seals.has(path)) throw Error("Duplicate path in completed settlement transaction");
      seals.set(path,after[1]);
    }
  }
  const seal = seals.get(PRIVATE_OUTCOME_LEDGER);
  if (id !== transaction || !seal || !/^[a-f0-9]{64}$/.test(seal) || seals.get(PUBLIC_OUTCOME_INDEX) !== indexHash)
    throw Error("Private price ledger and public identities lack a matching completed transaction");
  return { ledgerSha256: seal, after: seals };
}

/** Verify only the current outcome index, journal headers and owner-only availability metadata.
 * No slot in the production price ledger is opened to establish a research cutoff.
 * A completed legacy transaction without clock metadata cannot establish availability. */
export async function readOutcomeClockSlots(root: string, index: unknown, transaction: string): Promise<readonly string[] | null> {
  validateOutcomeIndex(index);
  const indexHash = digest(index);
  const state = JSON.parse(await readFile(join(root, EVALUATION_RELEASE_STATE), "utf8"));
  if (state?.status !== "complete" || state.outcomeLedgerTransactionId !== transaction ||
      state.hashes?.[PUBLIC_OUTCOME_INDEX] !== indexHash)
    throw Error("Prospective outcome clocks require the current completed outcome index");
  const header = await completedOutcomeWriteSeals(root, transaction, indexHash);
  const expected = header.after.get(PRIVATE_OUTCOME_AVAILABILITY);
  const path = join(root, PRIVATE_OUTCOME_AVAILABILITY);
  const dir = await lstat(dirname(path)).catch((e: unknown) => { if (missing(e)) return null; throw e; });
  if (dir && (!dir.isDirectory() || dir.mode & 0o077)) throw Error("Prospective outcome clocks require an owner-only directory");
  const handle = dir && await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: unknown) => {
    if (missing(e)) return null;
    throw e;
  });
  if (!handle) {
    if (expected) throw Error("Missing sealed prospective outcome clocks");
    return null;
  }
  try {
    if (!expected) throw Error("Unsealed prospective outcome clocks");
    const stat = await handle.stat();
    // The writer emits one ISO timestamp per identity. Bound the read to that index even decades into the study.
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 1024 + 48 * index.length)
      throw Error("Prospective outcome clocks require a bounded owner-only metadata file");
    const clocks = JSON.parse(await handle.readFile("utf8"));
    if (clocks?.schemaVersion !== 1 || Object.keys(clocks).length !== 3 ||
        clocks.ledgerSha256 !== header.ledgerSha256 || digest(clocks) !== expected ||
        !Array.isArray(clocks.knownAt) || clocks.knownAt.length !== index.length || !clocks.knownAt.every(iso))
      throw Error("Prospective availability clocks differ from their completed ledger and public index");
    return clocks.knownAt;
  } finally {
    await handle.close();
  }
}
