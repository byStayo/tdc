import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const run = promisify(execFile);
const scripts = fileURLToPath(new URL("./", import.meta.url));
const firstProspective = "2026-11-03T06:28:30.460Z";
const sealed = "022d23d33b1643fdea09faa8309e1e25faea503d94c2bf8ef72176ba7c9c6370";
export const H6_RETAIL_STUDY = "prelaunch-fed-h6-retail-deposit-iwm-v1";
type Native = {
  method: string;
  before: string;
  pairedCandidates: number;
  train: number;
  validation: number;
  test: number;
  combined: number;
  control: number;
  trainingBase: number;
  coin: number;
  coefficient: number;
  uncertainty: { interval95: [number, number]; correctedLower: number }[];
  passed: boolean;
};
export interface H6RetailStudySummary {
  method: string;
  paired: number;
  train: number;
  validation: number;
  test: number;
  modelBrier: number;
  controlBrier: number;
  baseRateBrier: number;
  coinBrier: number;
  coefficient: number;
  controlInterval95: [number, number];
  correctedControlLower: number;
  passed: boolean;
  sealedSHA256: string;
}
/** Only rounded aggregate statistics from the old-definition research may enter the public History table. */
export async function readH6RetailStudy(root: string, firstIssue: string): Promise<H6RetailStudySummary> {
  if (firstIssue !== firstProspective) throw Error("H.6 study is registered against the first prospective issue");
  const folder = resolve(root, ".consensus/private-h6-retail-iwm"),
    file = resolve(folder, "result.json");
  const result = await readResearchReceipt<Native>(file);
  if (
    !result ||
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") !== sealed ||
    result.method !== H6_RETAIL_STUDY ||
    result.before !== firstIssue
  )
    throw Error("Sealed H.6 historical result differs");
  const { stdout } = await run("python3", ["-B", resolve(scripts, "verify-h6-retail-outcome.py"), folder], {
    timeout: 120_000,
    maxBuffer: 16_384,
  });
  const reproduced: H6RetailStudySummary = JSON.parse(stdout);
  const summary: H6RetailStudySummary = {
    method: result.method,
    paired: result.pairedCandidates,
    train: result.train,
    validation: result.validation,
    test: result.test,
    modelBrier: result.combined,
    controlBrier: result.control,
    baseRateBrier: result.trainingBase,
    coinBrier: result.coin,
    coefficient: result.coefficient,
    controlInterval95: result.uncertainty[0].interval95,
    correctedControlLower: result.uncertainty[0].correctedLower,
    passed: result.passed,
    sealedSHA256: sealed,
  };
  for (const [key, value] of Object.entries(summary)) {
    const other = reproduced[key as keyof H6RetailStudySummary];
    if (typeof value === "number" && typeof other === "number" && Math.abs(value - other) < 1e-12) continue;
    if (
      Array.isArray(value) &&
      Array.isArray(other) &&
      value.length === other.length &&
      value.every((v, i) => Math.abs(v - other[i]) < 1e-12)
    )
      continue;
    if (value !== other) throw Error("Independent H.6 research replay failed: " + key);
  }
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw Error("Usage: read-h6-retail-study.ts WEB_ROOT FIRST_PROSPECTIVE_ISSUE");
  console.log(JSON.stringify(await readH6RetailStudy(resolve(args[0]), args[1])));
}
