import { exchangeSession } from "./exchange-calendar.ts";
import { FIRST_RATE_SOURCE, latestFirstRateSession } from "./firstrate.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKET_HISTORY_SOURCE } from "./market-history-settlement.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { PREMARKET_STUDY_POLICY } from "./premarket-study-policy.ts";
import { PROSPECTIVE_FAMILY_DEFINITIONS, PROSPECTIVE_FAMILY_POLICY_SHA256, PROSPECTIVE_FAMILY_RULES,
  readSealedFamilySession } from "./prospective-family-features.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import type { StudyFund } from "./secondary-study-model.ts";

type Rule = typeof PROSPECTIVE_FAMILY_RULES[number];
type Family = Rule["family"];
type EventFeatures = { fund: StudyFund; id: string; session: string; control: number; candidate: number };
const families = ["technicals", "options", "news"] as const;
const earliest = "2026-11-24T11:02:04.000Z";
const shaByFamily = {
  technicals: "56cc485171c3a68e0181f17a227d8158d6dac57158f46e97ecc37d38b739207e",
  options: "9a0e2a318455d36a463894a267af2a437bdce0b850f1650e747fb8e466cee2a0",
  news: "7f01b3f25bc679b84af7e3637a3a2584aa58c081b05114732a831b3f4ce00c36",
};

function policyFor(family: Family, rules: Rule[]) {
  return {
    method: "as-issued-" + family + "-secondary-v1",
    originalPolicy: PROSPECTIVE_FAMILY_POLICY_SHA256,
    comparisonSet: PROSPECTIVE_FAMILY_RULES,
    family, instruments: rules.map(r => r.instrument), feature: PROSPECTIVE_FAMILY_DEFINITIONS[rules[0].id],
    target: PREMARKET_STUDY_POLICY.target,
    enrollment: "Use the original core feature draft, its same-day public pre-open witness, its actual registration time and its native source seal. Retain the original event ID, untransformed input and fixed control. Register the new study decision under its own policy on the target morning before the entry open. Inputs that already had a public witness may support that still-unobserved target. A later registration cannot enroll a past target. Settle the final edition before entry only. Each native event counts once per rule and ETF.",
    custody: PREMARKET_STUDY_POLICY.custody,
    partition: PREMARKET_STUDY_POLICY.partition,
    model: "Fit standardized logistic regression with control and original candidate multiplied by the rule's declared expected sign. Compare control alone, training prevalence and 0.5. Use 600 gradient steps and penalties 0.01, 0.1, 1, 10. Select the lowest validation Brier, first on ties. The fitted coefficient on the signed candidate must be positive. No sign, feature, ETF or horizon substitution.",
    inference: "One attempt for each of the six original rule and ETF comparisons, and three paired comparisons per attempt. Require each Brier improvement above 0.01, each paired block-bootstrap 95% lower endpoint above zero and each one-sided p at most 0.01/(6*3). All studies remain private and none promote a vote.",
    train: 300, validation: 100, test: 100, alpha: 0.01 / (6 * 3),
  } as const;
}

function validFeature(rule: Rule, event: EventFeatures) {
  const { fund, id, session, candidate, control } = event;
  if (fund !== rule.instrument || !Number.isFinite(candidate) || !Number.isFinite(control)) return false;
  if (rule.family === "news") {
    const period = /^bls:payroll:(20\d\d-(?:0[2-9]|1[012]))$/.exec(id)?.[1];
    // BLS reports integer jobs. Express the values in thousands using the original release precision.
    const jobs = (n: number) => Number.isSafeInteger(Math.round(n * 1000)) && Math.round(n * 1000) / 1000 === n;
    return !!period && period < session.slice(0, 7) && jobs(candidate) && jobs(control);
  }
  const open = exchangeSession(session)?.openAt;
  if (!open) return false;
  const prior = latestFirstRateSession(open);
  if (rule.family === "options") return id === "market-history:spx-iv:" + prior &&
    [-1, 0, 1].includes(candidate) && Number.isInteger(control) && control >= 1 && control <= 5;
  const reportedReturn = (n: number) => n >= -100 && Number(n.toFixed(1)) === n;
  return id === "firstrate:" + fund + ":" + prior && reportedReturn(candidate) && reportedReturn(control);
}

/** Each result is native-replayed through the original, independently sealed pre-open feature recorder. */
async function points(rules: Rule[], root: string, session: string, edition: string, only?: StudyFund): Promise<StudyPoint[]> {
  const selected = rules.filter(rule => only === undefined || rule.instrument === only);
  const settled = await Promise.allSettled(selected.map(async rule => {
    const rows = await readSealedFamilySession(root, session, edition, "core", rule);
    return rows.map(row => {
      const candidate = row.candidate === 0 ? 0 : row.candidate * rule.expectedSign;
      if (row.id !== rule.id || row.instrument !== rule.instrument || row.session !== session || row.edition !== edition ||
          !validFeature(rule, { fund: row.instrument, id: row.eventId, session, candidate, control: row.control }))
        throw Error("Original as-issued feature scope or native event differs from its registered comparison");
      return { instrument: row.instrument, eventId: row.eventId, issuedAt: row.issuedAt, observedThrough: row.observedThrough,
        recordedAt: row.recordedAt, sourceSeal: row.sourceSeal, candidate, control: row.control };
    });
  }));
  const result: StudyPoint[] = [];
  let firstFailure: unknown;
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") result.push(...outcome.value);
    else {
      firstFailure ??= outcome.reason;
      console.error("Secondary feature receipt failed for", selected[i].id, selected[i].instrument,
        outcome.reason instanceof Error ? outcome.reason.message : "unverified native source");
    }
  }
  if (!result.length && firstFailure) throw firstFailure;
  return result;
}

export const secondaryFamilyStudies = families.map(name => {
  const rules = PROSPECTIVE_FAMILY_RULES.filter(rule => rule.family === name);
  const study = createSecondaryStudy({
    directory: ".consensus/private-secondary-family-studies/v1/" + name, earliest,
    policy: policyFor(name, rules), policySha: shaByFamily[name], requireNewRelease: false, disjointTests: true,
    readPoints: (root, session, edition, only) => points(rules, root, session, edition, only),
    validFeature: event => rules.some(rule => validFeature(rule, event)),
    // Core supplies the new native sign. The shared study requires its completed journal before admitting it to a partition.
    granted: (fund, source) => source === MARKETPARQUET_SOURCE || source === KIBOT_SUBSCRIBER_EOD_SOURCE ||
      (fund === "TLT" ? source === MARKET_HISTORY_SOURCE : source === FIRST_RATE_SOURCE),
  });
  return { name, study };
});
