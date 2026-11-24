import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { prepareFirstRate, prepareFirstRatePremarket } from "../lib/consensus/firstrate.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["--cached-only", "--review-withheld", "--premarket-only"].includes(args[0])))
  throw new Error("Usage: npm run consensus:prepare-firstrate -- [--cached-only | --review-withheld | --premarket-only]");
const unlock = await acquirePublicationLock(root, "firstrate-price-preparation");
let failure: { error: unknown } | undefined;
try {
  const result = args[0] === "--premarket-only" ? await prepareFirstRatePremarket(root)
    : await prepareFirstRate(root, args[0] === "--cached-only", undefined, args[0] === "--review-withheld");
  console.log(JSON.stringify(result));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(unlock, failure);
}
