import { fileURLToPath } from "node:url";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { assertEvaluationReleaseState } from "../lib/consensus/evaluation-transaction.ts";
import { dailySessionOutcomes } from "../lib/consensus/outcome-coverage-audit.ts";
import { loadEvaluationOutcomes } from "../lib/consensus/outcome-ledger.ts";

const [session, ...extra] = process.argv.slice(2);
if (!session || extra.length) throw new Error("Usage: consensus:session-outcomes -- YYYY-MM-DD");
const root = fileURLToPath(new URL("../", import.meta.url));
const { current, snapshots } = await verifyPublicationTree(root);
await assertEvaluationReleaseState(root);
const outcomes = await loadEvaluationOutcomes(root);
const observed = new Date().toISOString();
const result = dailySessionOutcomes(snapshots, outcomes, session, current.engineVersion, { asOf: observed, ledgerObservedAt: observed });
console.log(JSON.stringify(result, null, 2));
if (result.eligibleOutcomes !== result.funds.length) process.exitCode = 2;
