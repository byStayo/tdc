import { resolve } from "node:path";
import { replayOperfCapital } from "../lib/consensus/operf-capital-source.ts";

if (process.argv.length !== 3) throw Error("Usage: replay-operf-capital.ts PRIVATE_PAIR_RECEIPT");
const signal = await replayOperfCapital(resolve(process.argv[2]));
console.log(JSON.stringify({summary: signal.summary, metrics: signal.metrics, coverage: signal.operfCapital}, null, 2));
