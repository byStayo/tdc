import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { HORIZONS, INSTRUMENTS, type Snapshot } from "../lib/consensus/types.ts";

const file = (path: string) => readFile(new URL("../" + path, import.meta.url));
async function live(path: string) {
  const response = await fetch("https://thedailyconsensus.com" + path, {
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Public ${path} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const snapshot: Snapshot = JSON.parse((await file("lib/consensus/current.json")).toString());
const health = JSON.parse((await live("/api/health")).toString());
if (health.status !== "ready" || health.consensus?.edition !== snapshot.id || health.research?.status !== "ok" ||
    INSTRUMENTS.some(symbol => symbol !== "MARKET" && health.reports?.[symbol]?.status !== "ok"))
  throw new Error(`Public health or reports differ from the expected edition ${snapshot.id}`);
for (const name of [snapshot.id + ".json", "index.json", "outcomes.json", "outcome-selection.json"]) {
  const path = "/consensus/" + name;
  const [current, expected] = await Promise.all([live(path), file("public" + path)]);
  if (!current.equals(expected)) throw new Error(`Live bytes differ for ${path}`);
}
const mismatches: string[] = [];
for (const symbol of INSTRUMENTS) {
  const reports = await Promise.all(HORIZONS.map(async horizon => {
    const report = JSON.parse((await live(`/api/consensus?symbol=${symbol}&horizon=${horizon}`)).toString());
    return report.edition === snapshot.id && report.consensusBasis === "as-issued" &&
      isDeepStrictEqual(report.consensus, asIssuedConsensus(snapshot, symbol, horizon));
  }));
  reports.forEach((matched, i) => { if (!matched) mismatches.push(`${symbol}/${HORIZONS[i]}`); });
}
if (mismatches.length) throw new Error("Live consensus differs from the saved edition for " + mismatches.join(", "));
console.log(JSON.stringify({ edition: snapshot.id, health: health.status, reports: INSTRUMENTS.length,
  matchedPublicFiles: 4, matchedConsensusViews: INSTRUMENTS.length * HORIZONS.length }));
