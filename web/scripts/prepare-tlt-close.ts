import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { prepareTltClosingTrend } from "../lib/consensus/tlt-close-preparation.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--recheck"))
  throw new Error("Usage: npm run consensus:prepare-tlt-close -- [--recheck]");
const root = fileURLToPath(new URL("../", import.meta.url));
const release = await acquirePublicationLock(root, "tlt-closing-trend");
let failure: { error: unknown } | undefined;
try {
  console.log(JSON.stringify(await prepareTltClosingTrend(root, args.length === 1)));
} catch (error) {
  failure = { error };
  throw error;
} finally { await finishPublicationLock(release, failure); }
