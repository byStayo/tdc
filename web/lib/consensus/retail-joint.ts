import { FIRST_RATE_SOURCE } from "./firstrate.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { readSealedRetailSession } from "./prospective-family-features.ts";
import { RETAIL_ID } from "./prospective-retail.ts";
import { JOINT_RETAIL_POLICY, JOINT_RETAIL_SHA } from "./retail-joint-model.ts";
import { createSecondaryStudy } from "./secondary-study.ts";
export { priorCoreConflict as priorRetailCoreConflict, type NewCoreSettlement } from "./secondary-study.ts";

export const JOINT_RETAIL_ROOT = ".consensus/private-nyfed-retail-joint/v2";
const sources = new Set([FIRST_RATE_SOURCE, MARKETPARQUET_SOURCE, KIBOT_SUBSCRIBER_EOD_SOURCE]);
export const jointRetailStudy = createSecondaryStudy({
  directory: JOINT_RETAIL_ROOT, policy: JOINT_RETAIL_POLICY, policySha: JOINT_RETAIL_SHA,
  earliest: "2026-11-24T08:56:55.000Z", requireNewRelease: true, disjointTests: false,
  granted: (_, source) => sources.has(source),
  validFeature: e => /^nyfed-sce:stock:20\d{2}-(?:0[1-9]|1[012])$/.test(e.id) &&
    [e.control, e.candidate].every(x => Number.isFinite(x) && x >= 0 && x <= 100),
  readPoints: async (root, session, edition) => (await readSealedRetailSession(root, session, edition)).filter(p => p.id === RETAIL_ID),
});

export const { register: registerJointRetail, enroll: enrollJointRetail, stage: stageJointRetail, status: jointRetailStatus,
  registrationPath: JOINT_RETAIL_REGISTRATION, advanceMarker: JOINT_RETAIL_ADVANCE_MARKER } = jointRetailStudy;
