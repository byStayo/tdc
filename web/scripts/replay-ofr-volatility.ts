import { fileURLToPath } from "node:url";
import { replayOfrVolatility } from "../lib/consensus/ofr-volatility-review.ts";

if (process.argv.length !== 2) throw Error("Usage: node --experimental-strip-types scripts/replay-ofr-volatility.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
console.log(JSON.stringify(await replayOfrVolatility(root), null, 2));
