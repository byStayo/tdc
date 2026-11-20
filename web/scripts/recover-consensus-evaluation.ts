import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { recoverEvaluationTransaction } from "../lib/consensus/evaluation-transaction.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = await acquirePublicationLock(root, "evaluation-recovery");
let failure: { error: unknown } | undefined;
try { console.log(JSON.stringify({ recovered: await recoverEvaluationTransaction(root), retrained: false })); }
catch (error) { failure = { error }; throw error; }
finally { await finishPublicationLock(release, failure); }
