import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { prepareFirstRate } from "../lib/consensus/firstrate.ts";
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

async function collect(script: string, scriptArgs: string[] = [], timeout?: number) {
  const { stdout } = await run(
    process.execPath,
    ["--experimental-strip-types", resolve(PROJECT_ROOT, "scripts", script), ...scriptArgs],
    { cwd: PROJECT_ROOT, maxBuffer: 512_000, timeout },
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
    : await collect("collect-following-feeds.ts", ["--scheduled"]);
  const form144 = await collect("research-sec-form144.ts", ["--collect-only"], 60_000)
    .catch((error: { killed?: boolean; stderr?: string }) => ({
      status: "unavailable",
      error: error.killed ? "SEC Form 144 check exceeded 60 seconds"
        : error.stderr?.match(/^Error: (.+)$/m)?.[1] || "SEC Form 144 check did not complete",
    }));
  const firstRate = await prepareFirstRate(PROJECT_ROOT).catch((error: { killed?: boolean; stderr?: string; message?: string }) => ({
    status: "unavailable",
    error: error.killed ? "FirstRate source capture exceeded 105 seconds"
      : error.stderr?.trim().slice(0, 200) || error.message || "FirstRate preparation did not complete",
  }));
  const consensus = await collect("publish-consensus.ts");
  const issuerRevenue = await collect("research-issuer-revenue.ts", ["--collect-only"], 60_000)
    .catch((error: { killed?: boolean; stderr?: string }) => ({
      status: "unavailable",
      error: error.killed ? "SEC earnings check exceeded 60 seconds"
        : error.stderr?.match(/^Error: (.+)$/m)?.[1] || "SEC earnings check did not complete",
    }));
  const receipt = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    editorial,
    following,
    consensus,
    issuerRevenue,
    form144,
    firstRate,
  };
  await durableJSON(resolve(PROJECT_ROOT, ".editorial/latest-preparation.json"), receipt);
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}
