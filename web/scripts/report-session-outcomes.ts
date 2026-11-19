import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { assertEvaluationReleaseState } from "../lib/consensus/evaluation-transaction.ts";
import { dailySessionOutcomes } from "../lib/consensus/outcome-coverage-audit.ts";
import { loadEvaluationOutcomes } from "../lib/consensus/outcome-ledger.ts";
import { verifyPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { verifiedPrivateSession } from "../lib/consensus/kibot-verified-session.ts";

const [session, ...options] = process.argv.slice(2);
if (!session || new Set(options).size !== options.length || options.some(flag => !["--require-preopen", "--private-research"].includes(flag)))
  throw new Error("Usage: consensus:session-outcomes -- YYYY-MM-DD [--require-preopen] [--private-research]");
const root = fileURLToPath(new URL("../", import.meta.url));
const { current, snapshots } = await verifyPublicationTree(root);
await assertEvaluationReleaseState(root);
const outcomes = await loadEvaluationOutcomes(root);
const observed = new Date().toISOString();
const result = dailySessionOutcomes(snapshots, outcomes, session, current.engineVersion, { asOf: observed, ledgerObservedAt: observed });
const requirePreopen = options.includes("--require-preopen");
if (requirePreopen && !result.edition) throw new Error("No selected edition for the pre-open check");
const preopen = requirePreopen && result.edition ? await verifyPreopenReceipt(root, session, result.edition,
  await readFile(resolve(root, "public/consensus", result.edition + ".json")), observed) : undefined;
const privateResearch = options.includes("--private-research")
  ? await verifiedPrivateSession(root, snapshots, session, current.engineVersion, observed) : undefined;
console.log(JSON.stringify({ ...result, preopen, privateResearch }, null, 2));
if (result.eligibleOutcomes !== result.funds.length) process.exitCode = 2;
