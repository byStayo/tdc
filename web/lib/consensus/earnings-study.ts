import { createSecondaryStudy } from "./secondary-study.ts";
import { EARNINGS_ID, EARNINGS_POLICY, EARNINGS_POLICY_SHA256, EARNINGS_ROOT, earningsInput } from "./prospective-earnings.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./history.ts";
import { readSealedFamilySession } from "./prospective-family-features.ts";
import { FIRST_RATE_SOURCE } from "./firstrate.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { PREMARKET_STUDY_POLICY } from "./premarket-study-policy.ts";
import type { Snapshot } from "./types.ts";

export const EARNINGS_STUDY_POLICY = {
  method: "sec-management-revenue-qqq-secondary-v2", instruments: ["QQQ"], family: "earnings",
  originalPolicy: EARNINGS_POLICY_SHA256, feature: EARNINGS_POLICY.definitions[EARNINGS_ID],
  target: PREMARKET_STUDY_POLICY.target,
  enrollment: EARNINGS_POLICY.selection,
  custody: PREMARKET_STUDY_POLICY.custody,
  partition: PREMARKET_STUDY_POLICY.partition,
  model: "Standardized logistic regression of matched filing age and the signed original management-midpoint deviation, versus age alone, training prevalence and 0.5. Use 600 gradient steps, penalties 0.01, 0.1, 1, 10, lowest validation Brier and first on ties. Positive candidate coefficient predeclared. No issuer, feature, sign, target or horizon substitution.",
  inference: "One private QQQ earnings attempt; three paired comparisons. Require each Brier improvement >0.01, block-bootstrap 95% lower bound >0, and one-sided p <=0.01/(15*5*3), conservatively allowing 15 families and five fund scopes. No automatic public vote or promotion; no existing production or other study holdout changes.",
  train: 300, validation: 100, test: 100, alpha: 0.01 / (15 * 5 * 3),
} as const;
export const EARNINGS_STUDY_SHA256 = "1cfedd700b9334d5518d9b7870fcfba13d161b61866368b374dc98704759cf9c";
export const earningsStudy = createSecondaryStudy({
  directory: EARNINGS_ROOT + "/study", earliest: "2026-11-24T18:31:08.088Z",
  policy: EARNINGS_STUDY_POLICY, policySha: EARNINGS_STUDY_SHA256,
  granted: (fund, source) => fund === "QQQ" && [FIRST_RATE_SOURCE, KIBOT_SUBSCRIBER_EOD_SOURCE, MARKETPARQUET_SOURCE].includes(source),
  requireNewRelease: true, disjointTests: true,
  validFeature: p => p.fund === "QQQ" && Number.isFinite(p.candidate) && p.candidate > -100 && Number.isFinite(p.control) && p.control > 0 &&
    /^(?:AMD|NVDA):\d{4}-\d\d-\d\d:\d{10}-\d\d-\d{6}:\d{10}-\d\d-\d{6}(?:\|NVDA:\d{4}-\d\d-\d\d:\d{10}-\d\d-\d{6}:\d{10}-\d\d-\d{6})?$/.test(p.id),
  readPoints: async (root, session, edition, only, registeredAt) => {
    if (only && only !== "QQQ") return [];
    const rows = await readSealedFamilySession(root, session, edition, "earnings", { id: EARNINGS_ID, instrument: "QQQ" });
    if (!rows.length) return [];
    const snapshot: Snapshot = JSON.parse(await readFile(join(root, "public/consensus", edition + ".json"), "utf8"));
    return (await Promise.all(rows.map(async row => {
      // The study has its own later registration. An actual release between the two registrations cannot sneak in through the earlier feature lane.
      const fresh = await earningsInput(root, snapshot.signals, session, snapshot.cutoff, registeredAt, row.proofs);
      if (!("data" in fresh)) return [];
      const keys = ["candidate", "control", "eventId", "observedThrough", "availableAt", "sourceHashes", "proofs"] as const;
      if (snapshot.id !== edition || snapshot.issuedAt !== row.issuedAt || keys.some(k => digest(fresh.data[k]) !== digest(row[k])))
        throw Error("Earnings study differs from its original as-issued native input");
      return [{ instrument: "QQQ" as const, eventId: row.eventId, issuedAt: row.issuedAt, observedThrough: row.observedThrough,
        recordedAt: row.recordedAt, sourceSeal: row.sourceSeal, control: row.control, candidate: row.candidate }];
    }))).flat();
  },
});
