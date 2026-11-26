import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rollbackActiveModel } from "../lib/consensus/model-rollback.ts";
import type { Instrument, Horizon } from "../lib/consensus/types.ts";
const value = (flag: string) => { const i = process.argv.indexOf(flag); return i < 0 ? "" : process.argv[i + 1] ?? ""; };
console.log(JSON.stringify(await rollbackActiveModel(resolve(dirname(fileURLToPath(import.meta.url)), ".."), {
  instrument: value("--instrument") as Instrument, horizon: value("--horizon") as Horizon, to: value("--to"), reason: value("--reason"),
})));
