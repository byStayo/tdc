import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquirePublicationLock, finishPublicationLock } from "../publication-lock.ts";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { outcomeKey, outcomeWindowSessions } from "./evaluation.ts";
import { assertEvaluationReleaseState } from "./evaluation-transaction.ts";
import {
  EXCHANGE_CALENDAR,
  REVIEWED_EXCHANGE_THROUGH,
  exchangeSession,
  exchangeSessions,
} from "./exchange-calendar.ts";
import { digest, verifyPublicationTree } from "./history.ts";
import {
  attemptAlpha,
  MINIMUM_TEST_LABELS,
  pairedLossEvidence,
  PROSPECTIVE_MINIMUM,
  readReservations,
  type EvaluationReservation,
} from "./learning-audit.ts";
import { evaluateCandidate, planCandidate, type TrainingRow } from "./learning.ts";
import { permitsModelInputs, predict } from "./model.ts";
import { EVALUATION_RELEASE_STATE, PUBLIC_OUTCOME_INDEX, validateOutcomeIndex } from "./outcome-ledger.ts";
import { readProspectiveFamilyFeatures, RETAIL_POLICY_SHA256 } from "./prospective-family-features.ts";
import { prospectiveSelection, readApprovedLabels } from "./prospective-family-outcomes.ts";
import { RETAIL_ID, RETAIL_ROOT, RETAIL_RULES } from "./prospective-retail.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";
import { HORIZONS, type Outcome, type Snapshot } from "./types.ts";

type Identity = Pick<Outcome, "snapshotId" | "instrument" | "horizon" | "engineVersion">;
type Point = Awaited<ReturnType<typeof readProspectiveFamilyFeatures>>["rows"][number];
type Fund = (typeof RETAIL_RULES)[number]["instrument"];
type Slot = Parameters<typeof readApprovedLabels>[1][number];
type Input = { point: Point; request: Slot };
type Plan = {
  version: 1;
  policySha256: string;
  instrument: Fund;
  registeredAt: string;
  frozenAt: string;
  features: { id: string; sha256: string; edition: string; issuedAt: string; labelKnownAt: string }[];
  testStarts: string;
  testIds: string[];
};
type ResultSeal = { version: 1; planSha256: string; resultSha256: string; passes: boolean };
const selectionFile = "public/consensus/outcome-selection.json";
const dateRange = () => exchangeSessions(EXCHANGE_CALENDAR.from, REVIEWED_EXCHANGE_THROUGH);
const isInstant = (s: string) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const key = (s: string, h: string, e: string) => [s, h, e].join("/");
const full = (a: string, b: string) => Date.parse(b) - Date.parse(a) === 390 * 60_000;

/** A production test or consumed time stays private. For an unresolved future fold, the actual number of
 * model-eligible, permanently selected, already settled observations can establish a larger guaranteed training prefix.
 * Count distinct entry windows and remain conservative about earlier missing prices and supersession.
 */
export function retailProductionProtection(
  snapshots: Snapshot[],
  settled: Identity[],
  reservations: EvaluationReservation[],
) {
  const sessions = dateRange(),
    final = new Map<string, { snapshot: Snapshot; entry: string; exit: string }>(),
    possible = new Map<string, { snapshot: Snapshot; entry: string; exit: string }[]>(),
    bySession = new Map<string, Set<string>>(),
    rank = new Map<string, number>();
  const rows = new Set(settled.map((s) => outcomeKey(s))),
    counts = new Map<string, number>();
  for (const s of snapshots)
    for (const h of HORIZONS) {
      const dates = outcomeWindowSessions(s.issuedAt, h, sessions);
      if (!dates.length) continue;
      const entry = exchangeSession(dates[0])!.openAt,
        exit = exchangeSession(dates.at(-1)!)!.closeAt,
        k = key("", h, entry);
      const v = { snapshot: s, entry, exit };
      for (const day of [newYorkDate(s.issuedAt), ...dates]) {
        const active = bySession.get(day) ?? new Set<string>();
        active.add(k);
        bySession.set(day, active);
      }
      final.set(k, v);
      const group = possible.get(k) ?? [];
      group.push(v);
      possible.set(k, group);
    }
  const horizonRanks = new Map<string, number>();
  for (const [k, v] of [...final].sort((a, b) => a[1].entry.localeCompare(b[1].entry))) {
    const h = k.split("/")[1] as (typeof HORIZONS)[number];
    // Include all issued slot identities in the possible earlier rank, even if presently unresolved or superseded.
    const n = (horizonRanks.get(h) ?? 0) + 1;
    horizonRanks.set(h, n);
    rank.set(k, n);
    for (const { instrument } of RETAIL_RULES) {
      if (
        rows.has(outcomeKey({ snapshotId: v.snapshot.id, instrument, horizon: h })) &&
        permitsModelInputs(v.snapshot, instrument, h)
      ) {
        const id = key(instrument, h, v.snapshot.engineVersion);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return function protectedWindow(instrument: Fund, issuedAt: string, openAt: string, closeAt: string) {
    for (const r of reservations)
      if (r.instrument === instrument) {
        if (r.testWindows.some((w) => w.issuedAt <= closeAt && w.labelKnownAt >= issuedAt))
          return "reserved_window";
        if (issuedAt <= r.consumedThrough) return "consumed_window";
      }
    for (const k of bySession.get(openAt.slice(0, 10)) ?? []) {
      const versions = possible.get(k)!;
      const h = k.split("/")[1] as (typeof HORIZONS)[number];
      const latest = versions.at(-1)!.snapshot;
      const resolved = rows.has(outcomeKey({ snapshotId: latest.id, instrument, horizon: h }));
      const possibleVersions = resolved ? [versions.at(-1)!] : versions;
      for (const v of possibleVersions) {
        if (
          v.snapshot.issuedAt > closeAt ||
          v.exit < issuedAt ||
          !permitsModelInputs(v.snapshot, instrument, h)
        )
          continue;
        const n = counts.get(key(instrument, h, v.snapshot.engineVersion)) ?? 0;
        const earlier = rank.get(k)!;
        if (earlier > Math.floor(Math.max(PROSPECTIVE_MINIMUM, n) * 0.6))
          return "possible_validation_or_test";
      }
    }
    return null;
  };
}

/** Reserve fixed monthly identities before reading their directions. A failed attempt retains those test dates. */
async function once<T>(directory: string, filename: string, value: T) {
  await durableDirectory(directory, 0o700);
  const file = join(directory, filename);
  try {
    await durableJSON(file, value, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return (
    (await readResearchReceipt<T>(file)) ??
    (() => {
      throw Error("Private monthly plan disappeared");
    })()
  );
}
function fp({ point, request }: Input) {
  return {
    id: point.eventId,
    sha256: digest(point),
    edition: point.edition,
    issuedAt: point.recordedAt,
    labelKnownAt: request.closeAt,
  };
}
export async function evaluateMatureRetail(
  directory: string,
  fund: Fund,
  registeredAt: string,
  eligible: Input[],
  asOf: string,
  labels: (requests: Slot[]) => ReturnType<typeof readApprovedLabels>,
) {
  const ordered = eligible
    .filter((v) => v.point.instrument === fund)
    .sort((a, b) => a.request.openAt.localeCompare(b.request.openAt));
  if (
    new Set(ordered.map((v) => v.point.eventId)).size !== ordered.length ||
    new Set(ordered.map((v) => v.request.session)).size !== ordered.length ||
    !isInstant(registeredAt) ||
    !isInstant(asOf) ||
    ordered.some(
      (v) =>
        v.point.id !== RETAIL_ID ||
        v.point.policySha256 !== RETAIL_POLICY_SHA256 ||
        !/^nyfed-sce:stock:20\d{2}-(?:0[1-9]|1[0-2])$/.test(v.point.eventId) ||
        v.point.recordedAt < registeredAt ||
        !full(v.request.openAt, v.request.closeAt) ||
        v.request.closeAt >= asOf,
    )
  )
    throw Error("Invalid prospective SCE maturity pool");
  const prior = await readResearchReceipt<Plan>(join(directory, "plan.json"));
  const summary = {
    instrument: fund,
    eligibleMonths: ordered.length,
    required: PROSPECTIVE_MINIMUM,
    requiredTest: MINIMUM_TEST_LABELS,
  };
  if (!prior && ordered.length < PROSPECTIVE_MINIMUM)
    return { ...summary, status: "collecting_months" as const };
  const candidates = ordered.slice(0, PROSPECTIVE_MINIMUM);
  const witnesses = candidates.map(fp),
    testAt = Math.floor(PROSPECTIVE_MINIMUM * 0.8);
  const plan =
    prior ??
    (await once<Plan>(directory, "plan.json", {
      version: 1,
      policySha256: RETAIL_POLICY_SHA256,
      instrument: fund,
      registeredAt,
      frozenAt: asOf,
      features: witnesses,
      testStarts: witnesses[testAt].issuedAt,
      testIds: witnesses.slice(testAt).map((x) => x.id),
    }));
  if (
    plan.version !== 1 ||
    plan.policySha256 !== RETAIL_POLICY_SHA256 ||
    plan.instrument !== fund ||
    plan.registeredAt !== registeredAt ||
    !isInstant(plan.frozenAt) ||
    plan.frozenAt > asOf ||
    plan.features.length !== PROSPECTIVE_MINIMUM ||
    plan.testStarts !== plan.features[testAt].issuedAt ||
    new Set(plan.features.map((r) => r.id)).size !== PROSPECTIVE_MINIMUM ||
    plan.testIds.length < MINIMUM_TEST_LABELS ||
    digest(plan.testIds) !== digest(plan.features.slice(testAt).map((r) => r.id)) ||
    plan.features.some(
      (r, i) =>
        !isInstant(r.issuedAt) ||
        !isInstant(r.labelKnownAt) ||
        r.labelKnownAt >= plan.frozenAt ||
        r.issuedAt >= r.labelKnownAt ||
        (i > 0 && plan.features[i - 1].labelKnownAt >= r.issuedAt),
    )
  )
    throw Error("Changed private SCE test reservation");
  const expectedPlanSeal = { version: 1, policySha256: RETAIL_POLICY_SHA256, planSha256: digest(plan) };
  const existingSeal = await readResearchReceipt<typeof expectedPlanSeal>(join(directory, "plan-seal.json"));
  if (!existingSeal && digest(witnesses) !== digest(plan.features))
    throw Error("Cannot reseal unresolved private SCE test identities");
  const planSeal = existingSeal ?? (await once(directory, "plan-seal.json", expectedPlanSeal));
  if (digest(planSeal) !== digest(expectedPlanSeal)) throw Error("Changed sealed private SCE test plan");
  const resultSeal = await readResearchReceipt<ResultSeal>(join(directory, "result-seal.json"));
  if (resultSeal) {
    const previous = await readResearchReceipt<{
      policy: string;
      planSha256: string;
      passes: boolean;
      promoted: boolean;
    }>(join(directory, "aggregate.json"));
    if (
      resultSeal.version !== 1 ||
      typeof resultSeal.passes !== "boolean" ||
      resultSeal.planSha256 !== digest(plan) ||
      !previous ||
      previous.policy !== RETAIL_POLICY_SHA256 ||
      previous.planSha256 !== resultSeal.planSha256 ||
      previous.passes !== resultSeal.passes ||
      previous.promoted !== false ||
      digest(previous) !== resultSeal.resultSha256
    )
      throw Error("Changed sealed private SCE result");
    return {
      ...summary,
      status: "evaluated_private" as const,
      passes: resultSeal.passes,
      aggregateSha256: resultSeal.resultSha256,
    };
  }
  const book = new Map(ordered.map((p) => [p.point.eventId, p]));
  const pinned: Input[] = [];
  for (const row of plan.features) {
    const p = book.get(row.id);
    if (!p) return { ...summary, status: "reserved_source_or_production_window_unavailable" as const };
    if (digest(row) !== digest(fp(p))) throw Error("SCE test plan differs from its as-issued sources");
    pinned.push(p);
  }
  const got = await labels(pinned.map((v) => v.request));
  if (got.size !== pinned.length || pinned.some((p) => got.get(p.request.slot)?.status !== "paired"))
    return { ...summary, status: "awaiting_approved_settlement" as const };
  const train: TrainingRow[] = pinned.map(({ point, request }) => {
    const item = got.get(request.slot)!;
    if (item.status !== "paired" || ![0, 1].includes(item.up))
      throw Error("Private retail target failed verification");
    return {
      id: point.eventId,
      engineVersion: RETAIL_ID,
      issuedAt: point.recordedAt,
      labelKnownAt: request.closeAt,
      features: [point.control, point.candidate],
      up: item.up,
    };
  });
  const options = {
    minimumSamples: PROSPECTIVE_MINIMUM,
    minimumTestSamples: MINIMUM_TEST_LABELS,
    nonOverlappingTest: true,
  };
  const fixture = planCandidate(train, asOf, options),
    baseline = planCandidate(
      train.map((x) => ({ ...x, features: [x.features[0]] })),
      asOf,
      options,
    );
  if (fixture.status !== "ready" || baseline.status !== "ready")
    return { ...summary, status: "ineligible_purged_split" as const };
  if (digest(fixture.split.test.map((v) => v.id)) !== digest(plan.testIds))
    throw Error("Purged SCE test identity changed");
  const a = evaluateCandidate(fixture),
    b = evaluateCandidate(baseline),
    rate = fixture.split.train.reduce((s, x) => s + x.up, 0) / fixture.split.train.length;
  const comparisons = [
    { name: "prior release", p: (r: TrainingRow) => predict(b.model, [r.features[0]]) },
    { name: "training base", p: () => rate },
    { name: "coin", p: () => 0.5 },
  ].map(({ name, p }) => ({
    name,
    ...pairedLossEvidence(
      fixture.split.test.map((r) => (p(r) - r.up) ** 2 - (predict(a.model, r.features) - r.up) ** 2),
      RETAIL_POLICY_SHA256 + ":" + fund + ":" + name,
      attemptAlpha(1),
    ),
  }));
  const result = {
    instrument: fund,
    policy: RETAIL_POLICY_SHA256,
    planSha256: digest(plan),
    sampleCount: train.length,
    testCount: fixture.split.test.length,
    pairedDatasetSha256: fixture.datasetHash,
    fixedControlDatasetSha256: baseline.datasetHash,
    coefficient: a.model.weights[1],
    candidateBrier: a.candidateBrier,
    controlBrier: b.candidateBrier,
    baseBrier: a.baseRateBrier,
    coinBrier: a.coinBrier,
    comparisons,
    passes:
      a.model.weights[1] > 0 &&
      comparisons.every(
        (c) => c.meanImprovement > 0.01 && c.interval95[0] > 0 && c.pValue <= attemptAlpha(1),
      ),
    promoted: false,
  };
  const saved = await once(directory, "aggregate.json", result);
  if (digest(saved) !== digest(result)) throw Error("Past private SCE result differs");
  const seal = await once(directory, "result-seal.json", {
    version: 1,
    planSha256: digest(plan),
    resultSha256: digest(result),
    passes: result.passes,
  });
  if (
    seal.planSha256 !== digest(plan) ||
    seal.resultSha256 !== digest(result) ||
    seal.passes !== result.passes
  )
    throw Error("Conflicting private SCE research seal");
  return {
    ...summary,
    status: "evaluated_private" as const,
    passes: result.passes,
    aggregateSha256: digest(result),
  };
}

/** Post-close identities may accumulate immediately. No outcome content is opened before the dedicated test plan exists. */
export async function auditProspectiveRetailOutcomes(root: string) {
  const features = await readProspectiveFamilyFeatures(root, undefined, "retail");
  if (!features.registeredAt) return { status: "not_registered", registeredAt: null };
  const blank = () =>
    RETAIL_RULES.map((r) => ({
      instrument: r.instrument,
      eligibleMonths: 0,
      required: PROSPECTIVE_MINIMUM,
      requiredTest: MINIMUM_TEST_LABELS,
      status: "collecting_months" as const,
    }));
  if (!features.rows.length)
    return {
      status: "collecting_months",
      registeredAt: features.registeredAt,
      witnessedEvents: 0,
      cohorts: blank(),
    };
  const release = await acquirePublicationLock(root, "private-sce-monthly-research");
  let failure: { error: unknown } | undefined;
  try {
    await assertEvaluationReleaseState(root);
    const [publication, reservations, indexText, selectionText, stateText] = await Promise.all([
      verifyPublicationTree(root),
      readReservations(root),
      readFile(join(root, PUBLIC_OUTCOME_INDEX), "utf8"),
      readFile(join(root, selectionFile), "utf8"),
      readFile(join(root, EVALUATION_RELEASE_STATE), "utf8"),
    ]);
    const index: unknown = JSON.parse(indexText);
    validateOutcomeIndex(index);
    const selection = JSON.parse(selectionText) as Parameters<typeof prospectiveSelection>[2],
      state = JSON.parse(stateText) as {
        outcomeLedgerTransactionId: string;
        hashes: Record<string, string>;
      };
    if (
      state.hashes[PUBLIC_OUTCOME_INDEX] !== digest(index) ||
      state.hashes[selectionFile] !== digest(selection)
    )
      throw Error("Retail settlement identities differ from their completed transaction");
    const asOf = new Date().toISOString(),
      { bySession, byEdition, slots } = prospectiveSelection(publication.snapshots, index, selection, asOf);
    const latest = await readProspectiveFamilyFeatures(root, undefined, "retail");
    if (latest.policySha256 !== RETAIL_POLICY_SHA256 || latest.registeredAt !== features.registeredAt)
      throw Error("Retail registration changed");
    const protect = retailProductionProtection(publication.snapshots, index, reservations),
      eligible: Input[] = [],
      missing: Record<string, number> = {};
    for (const p of latest.rows) {
      const clock = exchangeSession(p.session),
        e = byEdition.get(p.edition);
      if (
        !clock ||
        !e ||
        !RETAIL_RULES.some((r) => r.instrument === p.instrument) ||
        p.id !== RETAIL_ID ||
        p.family !== "retail" ||
        e.issuedAt !== p.issuedAt ||
        e.cutoff !== p.cutoff ||
        !isInstant(p.recordedAt) ||
        p.recordedAt >= clock.openAt
      )
        throw Error("Unmatched SCE feature/witness");
      const fund = p.instrument as Fund;
      const slot = slots.get(outcomeKey({ snapshotId: p.edition, instrument: fund, horizon: "daily" }));
      const rejection =
        clock.closeAt >= asOf
          ? "awaiting_close"
          : bySession.get(p.session)?.id !== p.edition
            ? "superseded_edition"
            : !full(clock.openAt, clock.closeAt)
              ? "short_session"
              : (protect(fund, p.issuedAt, clock.openAt, clock.closeAt) ??
                (slot === undefined ? "awaiting_settlement" : null));
      if (rejection) {
        missing[rejection] = (missing[rejection] ?? 0) + 1;
        continue;
      }
      eligible.push({
        point: p,
        request: { slot: slot!, identity: index[slot!], issuedAt: e.issuedAt, ...clock },
      });
    }
    const cohorts = [];
    for (const { instrument } of RETAIL_RULES)
      cohorts.push(
        await evaluateMatureRetail(
          join(root, RETAIL_ROOT, "evaluations", instrument),
          instrument,
          features.registeredAt,
          eligible,
          asOf,
          (requests) => readApprovedLabels(root, requests, index, state.outcomeLedgerTransactionId, asOf),
        ),
      );
    return {
      status: "private_prospective_sce",
      registeredAt: features.registeredAt,
      witnessedEvents: new Set(latest.rows.map((r) => r.eventId)).size,
      missing,
      cohorts,
    };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}
