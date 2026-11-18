import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import {
  collectEditorialEvidence,
  PROJECT_ROOT,
  saveEditorialEvidence,
} from "./collect-editorial-evidence.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--public-only"))
  throw new Error("Usage: npm run editorial:prepare -- [--public-only]");
const publicOnly = args[0] === "--public-only";

async function collect(script: string, ...scriptArgs: string[]) {
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", resolve(PROJECT_ROOT, "scripts", script), ...scriptArgs],
    { cwd: PROJECT_ROOT, maxBuffer: 512_000 },
  );
  return JSON.parse(stdout);
}

const release = await acquirePublicationLock(PROJECT_ROOT, "daily-data-preparation");
let failure: { error: unknown } | undefined;
try {
  const evidence = await collectEditorialEvidence();
  const output = await saveEditorialEvidence(evidence);
  const editorial = {
    output,
    collectedAt: evidence.collectedAt,
    available: evidence.sources.filter(source => source.status === "ok").length,
    unavailable: evidence.sources.filter(source => source.status !== "ok").map(source => source.id),
  };
  const following = publicOnly
    ? { status: "skipped_public_only" }
    : await collect("collect-following-feeds.ts", "--scheduled");
  const consensus = await collect("publish-consensus.ts");
  const receipt = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    editorial,
    following,
    consensus,
  };
  await durableJSON(resolve(PROJECT_ROOT, ".editorial/latest-preparation.json"), receipt);
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}
