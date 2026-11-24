import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exchangeSession } from "./exchange-calendar.ts";
import { FLOW_FUNDS, replayFlowPeers } from "./etf-flow-peers.ts";
import { ETF_FLOW_STUDY_POLICY } from "./etf-flow-study-policy.ts";
import { FIRST_RATE_SOURCE, latestFirstRateSession } from "./firstrate.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKET_HISTORY_SOURCE } from "./market-history-settlement.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import type { StudyFund } from "./secondary-study-model.ts";
import { newYorkDate } from "./time.ts";
import type { Signal, Snapshot } from "./types.ts";

/** Require the actual provider count date and its earlier NAV to be consecutive completed sessions. */
export function flowEligibleForSession(signal: Signal, session: string) {
  const p = signal.etfFlowPeers, target = exchangeSession(session);
  if (!p || !target || signal.status !== "available") return false;
  const prior = latestFirstRateSession(target.openAt), clock = exchangeSession(prior)!;
  if (prior !== signal.source.observedAt || p.observedThrough < clock.closeAt) return false;
  return p.navDate === latestFirstRateSession(clock.openAt);
}

async function points(root: string, session: string, edition: string, only?: StudyFund) {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition)) throw Error("Invalid flow edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const witness = await verifyPreopenWithMorningConfirmation(root, session, edition, bytes, new Date().toISOString());
  if (newYorkDate(witness.observedAt) !== session) return [];
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  const accepted: StudyPoint[] = [];
  for (const fund of only ? [only] : FLOW_FUNDS) {
    const signal = snapshot.signals.find(s => s.id === "etfiq-flow-" + fund);
    if (!signal || !flowEligibleForSession(signal, session)) continue;
    const p = signal.etfFlowPeers!;
    try {
      const values = await replayFlowPeers(root, signal, fund, snapshot.cutoff);
      accepted.push({ instrument: fund, eventId: "etfiq:" + fund + ":" + signal.source.observedAt, issuedAt: snapshot.issuedAt,
        observedThrough: p.observedThrough, recordedAt: witness.observedAt, sourceSeal: p.seal, ...values });
    } catch (error) {
      if (only) throw error;
      console.error("Private ETFIQ flow replay failed for", fund, String(error));
    }
  }
  return accepted;
}

export const etfFlowStudy = createSecondaryStudy({
  directory: ".consensus/private-etfiq-flow-study/v1", earliest: "2026-11-24T12:04:00.000Z",
  policy: ETF_FLOW_STUDY_POLICY, policySha: "59b05280906a64b30e678dcfa3442612dfde33cd0840e7e14a95f0c19b1085ce",
  requireNewRelease: true, disjointTests: true, readPoints: points,
  validFeature: e => {
    const clock = exchangeSession(e.session);
    return !!clock && e.id === "etfiq:" + e.fund + ":" + latestFirstRateSession(clock.openAt) &&
      Number.isFinite(e.candidate) && Number(e.candidate.toFixed(2)) === e.candidate && Math.abs(e.control) <= 1;
  },
  granted: (fund, source) => source === MARKETPARQUET_SOURCE || source === KIBOT_SUBSCRIBER_EOD_SOURCE ||
    (fund === "TLT" ? source === MARKET_HISTORY_SOURCE : source === FIRST_RATE_SOURCE),
});
