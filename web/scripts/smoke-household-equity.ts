import { publicText } from "../lib/consensus/collector.ts";
import { collectHouseholdEquity } from "../lib/consensus/household-equity.ts";

// Source-only smoke: four bounded public Fed reads; no snapshot, publication or model writes.
let requests = 0;
const signal = await collectHouseholdEquity(async url => { requests++; return publicText(url); });
console.log(JSON.stringify({
  status: signal.status, requests, summary: signal.summary, source: signal.source,
  unit: signal.unit, series: signal.series, householdEquity: signal.householdEquity,
  directionalInstruments: signal.directionalInstruments, scores: signal.scores,
}, null, 2));
if (signal.status !== "available") process.exitCode = 1;
