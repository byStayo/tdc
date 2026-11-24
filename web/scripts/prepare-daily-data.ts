import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { prepareKibotPrimary } from "../lib/consensus/kibot-eod-primary.ts";
import { prepareMarketHistoryRanges } from "../lib/consensus/market-history-ranges.ts";
import { prepareFirstRate, prepareFirstRatePremarket } from "../lib/consensus/firstrate.ts";
import { prepareTltClosingTrend } from "../lib/consensus/tlt-close-preparation.ts";
import { prepareTltBoundaryQualification } from "../lib/consensus/market-history-boundary-preparation.ts";
import { editorialPreparationMode } from "../lib/editorial-preparation-mode.ts";
import { attachForm144Sources } from "../lib/sec-form144-editorial.ts";
import {
  collectEditorialEvidence,
  PROJECT_ROOT,
  saveEditorialEvidence,
} from "./collect-editorial-evidence.ts";

const run = promisify(execFile);
const mode = editorialPreparationMode(process.argv.slice(2));

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
const rangeAbort = new AbortController();
// Native range checks run during the independent public evidence pass. Always join them before issuing a draft or releasing the lock.
const rangeJob = prepareMarketHistoryRanges(PROJECT_ROOT, { live: mode.freePriceAccount, signal: rangeAbort.signal })
  .catch((error: Error) => ({ status: "unavailable", reason: error.message }));
try {
  const baseEvidence = await collectEditorialEvidence(fetch, { archiveRoot: PROJECT_ROOT });
  const { editorialSources, ...form144 } = await collect("research-sec-form144.ts", ["--editorial"], 60_000)
    .catch((error: { killed?: boolean; stderr?: string }) => ({
      status: "unavailable", editorialSources: null,
      error: error.killed ? "SEC Form 144 check exceeded 60 seconds"
        : error.stderr?.match(/^Error: (.+)$/m)?.[1] || "SEC Form 144 check did not complete",
    }));
  const evidence = attachForm144Sources(baseEvidence, editorialSources, new Date().toISOString());
  const output = await saveEditorialEvidence(evidence);
  const editorial = {
    output,
    collectedAt: evidence.collectedAt,
    available: evidence.sources.filter(source => source.status === "ok").length,
    unavailable: evidence.sources.filter(source => source.status !== "ok").map(source => source.id),
  };
  const following = mode.following
    ? await collect("collect-following-feeds.ts", ["--scheduled"])
    : { status: mode.freePriceAccount ? "separate_scheduled_digest" : "skipped_public_only" };
  const regularSessionRanges = await rangeJob;
  const firstRate = await prepareFirstRate(PROJECT_ROOT).catch((error: { killed?: boolean; stderr?: string; message?: string }) => ({
    status: "unavailable",
    error: error.killed ? "FirstRate source capture exceeded 105 seconds"
      : error.stderr?.trim().slice(0, 200) || error.message || "FirstRate preparation did not complete",
  }));
  const priorPremarket = await prepareFirstRatePremarket(PROJECT_ROOT);
  const tltClosingTrend = await prepareTltClosingTrend(PROJECT_ROOT).catch((error: Error) =>
    ({ status: "unavailable", error: error.message.slice(0, 220) }));
  const tltSettlementQualification = !mode.freePriceAccount ? { status: "skipped_public_only" } :
    await prepareTltBoundaryQualification(PROJECT_ROOT, (from, through) =>
      collect("research-market-history-boundaries.ts", [from, through, "--collect", "--settle-verified"], 120_000))
      .catch((error: { killed?: boolean; stderr?: string; message?: string }) => ({ status: "unavailable",
        error: error.killed ? "TLT qualification exceeded 120 seconds" : error.stderr?.match(/^Error: (.+)$/m)?.[1] ||
          error.message?.slice(0, 180) || "TLT qualification did not complete" }));
  const kibotSubscriber = mode.freePriceAccount
    ? await prepareKibotPrimary(PROJECT_ROOT).catch(() => ({ status: "source_unavailable" }))
    : { status: "skipped_public_only" };
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
    priorPremarket,
    tltClosingTrend,
    tltSettlementQualification,
    kibotSubscriber,
    regularSessionRanges,
  };
  await durableJSON(resolve(PROJECT_ROOT, ".editorial/latest-preparation.json"), receipt);
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  rangeAbort.abort();
  await rangeJob;
  await finishPublicationLock(release, failure);
}
