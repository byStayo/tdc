import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { confirmFirstRateHoldingPeriods, prepareFirstRate, prepareFirstRatePremarket } from "../lib/consensus/firstrate.ts";

import { prepareFirstRateRanges } from "../lib/consensus/firstrate-ranges.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["--cached-only", "--confirm-holding-periods", "--review-withheld", "--premarket-only", "--ranges-only"].includes(args[0])))
  throw new Error("Usage: npm run consensus:prepare-firstrate -- [--cached-only | --confirm-holding-periods | --review-withheld | --premarket-only | --ranges-only]");
const unlock = await acquirePublicationLock(root, "firstrate-price-preparation");
let failure: { error: unknown } | undefined;
try {
  const result = args[0] === "--confirm-holding-periods" ? await confirmFirstRateHoldingPeriods(root)
    : args[0] === "--ranges-only" ? await prepareFirstRateRanges(root)
    : args[0] === "--premarket-only" ? await prepareFirstRatePremarket(root)
    : await prepareFirstRate(root, args[0] === "--cached-only", undefined, args[0] === "--review-withheld");
  console.log(JSON.stringify(result));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(unlock, failure);
}
