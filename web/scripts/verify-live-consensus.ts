import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { PUBLIC_ORIGIN, recordPreopenReceipt, scheduledPreopenSession } from "../lib/consensus/preopen-receipt.ts";
import { PROSPECTIVE_FAMILY_RULES, recordProspectiveFamilyFeatures } from "../lib/consensus/prospective-family-features.ts";
import { premarketStudy } from "../lib/consensus/premarket-study.ts";
import { etfFlowStudy } from "../lib/consensus/etf-flow-study.ts";
import { secondaryFamilyStudies } from "../lib/consensus/secondary-family-studies.ts";
import { enrollJointRetail } from "../lib/consensus/retail-joint.ts";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { HORIZONS, INSTRUMENTS, type Snapshot } from "../lib/consensus/types.ts";

const [option, explicitSession, ...extra] = process.argv.slice(2);
if (extra.length || (option === "--record-preopen" ? !explicitSession :
    option === "--scheduled-preopen" ? !!explicitSession : option !== undefined))
  throw new Error("Usage: consensus:verify-live [--record-preopen YYYY-MM-DD | --scheduled-preopen]");
const root = fileURLToPath(new URL("../", import.meta.url));
const file = (path: string) => readFile(new URL("../" + path, import.meta.url));
async function live(path: string) {
  const response = await fetch(PUBLIC_ORIGIN + path, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Public ${path} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function verify(snapshot: Snapshot, session?: string) {
  const health = JSON.parse((await live("/api/health")).toString());
  if (health.status !== "ready" || health.consensus?.edition !== snapshot.id || health.research?.status !== "ok" ||
      INSTRUMENTS.some(symbol => symbol !== "MARKET" && health.reports?.[symbol]?.status !== "ok"))
    throw new Error(`Public health or reports differ from the expected edition ${snapshot.id}`);
  const verified = new Map<string, Buffer>();
  for (const name of [snapshot.id + ".json", "index.json", "outcomes.json", "outcome-selection.json"]) {
    const path = "/consensus/" + name;
    const [current, expected] = await Promise.all([live(path), file("public" + path)]);
    if (!current.equals(expected)) throw new Error(`Live bytes differ for ${path}`);
    if (session && (name === snapshot.id + ".json" || name === "index.json")) verified.set(name, current);
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
  const preopen = session ? await recordPreopenReceipt(root, session, snapshot.id,
    verified.get(snapshot.id + ".json")!, verified.get("index.json")!, new Date().toISOString()) : undefined;
  let familyFeatures, retailFeatures, jointRetail, priorPremarket, fundFlows;
  const secondaryFamilies: Record<string, {status: string; enrolled: number}> = {};
  if (session && preopen) {
    try {
      familyFeatures = await recordProspectiveFamilyFeatures(root, session, snapshot.id);
    } catch (error) {
      console.error("Private family feature capture failed.", error instanceof Error ? error.message : String(error));
      familyFeatures = { status: "failed" };
    }
    try {
      retailFeatures = await recordProspectiveFamilyFeatures(root, session, snapshot.id, "retail");
    } catch (error) {
      console.error("Private monthly retail capture failed.", error instanceof Error ? error.message : String(error));
      retailFeatures = { status: "failed" };
    }
    try {
      priorPremarket = await premarketStudy.enroll(root, session, snapshot.id);
    } catch (error) {
      console.error("Private premarket enrollment failed.", error instanceof Error ? error.message : String(error));
      priorPremarket = { status: "failed" };
    }
    try { fundFlows = await etfFlowStudy.enroll(root, session, snapshot.id); }
    catch (error) {
      console.error("Private fund-flow enrollment failed.", error instanceof Error ? error.message : String(error));
      fundFlows = { status: "failed" };
    }
    if ("available" in familyFeatures) {
      const missing = new Set(familyFeatures.missing.map(m => m.id + "/" + m.instrument));
      for (const {name, study} of secondaryFamilyStudies) {
        const eligible = PROSPECTIVE_FAMILY_RULES.some(rule => rule.family === name && !missing.has(rule.id + "/" + rule.instrument));
        if (!eligible) {
          secondaryFamilies[name] = {status: "no_witnessed_source_input", enrolled: 0};
          continue;
        }
        try { secondaryFamilies[name] = await study.enroll(root, session, snapshot.id); }
        catch (error) {
          console.error("Private enrollment failed for", name, error instanceof Error ? error.message : String(error));
          secondaryFamilies[name] = {status: "failed", enrolled: 0};
        }
      }
    }
    if ("available" in retailFeatures && retailFeatures.available) try {
      jointRetail = await enrollJointRetail(root, session, snapshot.id);
    } catch(error) {
      console.error("Private joint retail enrollment failed.",error instanceof Error?error.message:String(error));
      jointRetail = { status: "failed" };
    }
  }
  console.log(JSON.stringify({ edition: snapshot.id, health: health.status, reports: INSTRUMENTS.length,
    matchedPublicFiles: 4, matchedConsensusViews: INSTRUMENTS.length * HORIZONS.length, preopen, familyFeatures, retailFeatures, jointRetail, priorPremarket, fundFlows, secondaryFamilies }));
}

const readCurrent = async (): Promise<Snapshot> => JSON.parse((await file("lib/consensus/current.json")).toString());
if (!option) {
  await verify(await readCurrent());
} else {
  const release = await acquirePublicationLock(root, "public-preopen-verification");
  let failure;
  try {
    const snapshot = await readCurrent();
    const session = explicitSession ?? scheduledPreopenSession(snapshot.issuedAt, new Date().toISOString());
    if (session) await verify(snapshot, session);
    else console.log(JSON.stringify({ status: "no_current_preopen_target", edition: snapshot.id }));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}
