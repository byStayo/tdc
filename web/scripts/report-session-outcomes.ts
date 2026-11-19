import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { assertEvaluationReleaseState } from "../lib/consensus/evaluation-transaction.ts";
import { dailySessionOutcomes } from "../lib/consensus/outcome-coverage-audit.ts";
import { loadEvaluationOutcomes } from "../lib/consensus/outcome-ledger.ts";
import { verifyPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";

const [session, option, ...extra] = process.argv.slice(2);
if (!session || (option !== undefined && option !== "--require-preopen") || extra.length)
  throw new Error("Usage: consensus:session-outcomes -- YYYY-MM-DD [--require-preopen]");
const root = fileURLToPath(new URL("../", import.meta.url));
const { current, snapshots } = await verifyPublicationTree(root);
await assertEvaluationReleaseState(root);
const outcomes = await loadEvaluationOutcomes(root);
const observed = new Date().toISOString();
const result = dailySessionOutcomes(snapshots, outcomes, session, current.engineVersion, { asOf: observed, ledgerObservedAt: observed });
if (option && !result.edition) throw new Error("No selected edition for the pre-open check");
const preopen = option && result.edition ? await verifyPreopenReceipt(root, session, result.edition,
  await readFile(resolve(root, "public/consensus", result.edition + ".json")), observed) : undefined;
console.log(JSON.stringify({ ...result, preopen }, null, 2));
if (result.eligibleOutcomes !== result.funds.length) process.exitCode = 2;
