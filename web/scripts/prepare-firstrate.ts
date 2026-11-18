import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { prepareFirstRate } from "../lib/consensus/firstrate.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--cached-only"))
  throw new Error("Usage: npm run consensus:prepare-firstrate -- [--cached-only]");
const unlock = await acquirePublicationLock(root, "firstrate-price-preparation");
let failure: { error: unknown } | undefined;
try {
  console.log(JSON.stringify(await prepareFirstRate(root, args[0] === "--cached-only")));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(unlock, failure);
}
