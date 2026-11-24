import { randomBytes } from "node:crypto";
import { lstat, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import {
  exchangeCalendarVersion,
  exchangeSession,
  hasReviewedCalendar,
  REVIEWED_EXCHANGE_THROUGH,
} from "./exchange-calendar.ts";
import { readReservations } from "./learning-audit.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { digest } from "./history.ts";
import { COMPLETED_EVALUATIONS, PUBLIC_OUTCOME_INDEX, validateOutcomeIndex } from "./outcome-ledger.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { newYorkDate } from "./time.ts";
import { fitSecondary, secondaryForecast, scoreSecondary, type Fitted, type Forecast, type Phase, type StudyFund, type StudyPolicy } from "./secondary-study-model.ts";
import type { Outcome, Snapshot } from "./types.ts";

export type StudyPoint = {
  instrument: StudyFund; eventId: string; issuedAt: string; observedThrough: string;
  recordedAt: string; sourceSeal: string; control: number; candidate: number;
};

type Options = {
  directory: string;
  policy: StudyPolicy;
  policySha: string;
  earliest: string;
  granted: (fund: StudyFund, source: string) => boolean;
  requireNewRelease: boolean;
  disjointTests: boolean;
  validFeature: (p: Pick<Event, "fund" | "id" | "session" | "control" | "candidate">) => boolean;
  readPoints: (root: string, session: string, edition: string, fund?: StudyFund) => Promise<StudyPoint[]>;
};

const wall = () => new Date().toISOString();
const canonical = (s: string) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const checkedHash = (s: string) => /^[a-f0-9]{64}$/.test(s);
const editionPattern = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Envelope<T> = { value: T; sha256: string };
type Registration = { registeredAt: string; policy: StudyPolicy; policySha: string };
type Event = {
  registration: string;
  fund: StudyFund;
  id: string;
  edition: string;
  session: string;
  issuedAt: string;
  sourceReleasedAt: string;
  sourceSeal: string;
  capturedAt: string;
  registeredAt: string;
  control: number;
  candidate: number;
  phase: Phase;
  parent: string;
  previousCoreHeads: string;
  prediction: Forecast | null;
};
type Admission = { eventSha: string; transaction: string; acceptedAt: string; source: string; labelCommitment: string };
type Secret = { eventSha: string; transaction: string; up: 0 | 1; salt: string };
type Member = { id: string; edition: string; session: string; eventSha: string; approvalSha: string };
type Qualified = { event: Event; admission: Admission; member: Member };
type Frozen = { members: Member[]; parent: string; frozenAt: string };
type Fit = Frozen & { model: Fitted };
type Summary = ReturnType<typeof scoreSecondary>;
const noDir = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function files(p: string) {
  try {
    return (await readdir(p)).sort();
  } catch (e) {
    if (noDir(e)) return [];
    throw e;
  }
}
async function read<T>(p: string) {
  const f = await readResearchReceipt<Envelope<T>>(p);
  if (!f) return null;
  if (Object.keys(f).sort().join() !== "sha256,value" || f.sha256 !== digest(f.value))
    throw Error("Changed private secondary study evidence");
  return f.value;
}
async function first<T>(p: string, value: T) {
  await durableDirectory(dirname(p), 0o700);
  try {
    await durableJSON(p, { value, sha256: digest(value) }, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const old = await read<T>(p);
  if (!old) throw Error("Lost private secondary study evidence");
  return old;
}
interface CoreUse {
  reservedAt: string;
  instrument: string;
  consumedThrough: string;
  testWindows: { issuedAt: string; labelKnownAt: string }[];
}
/** A genuinely future shared target can later serve the core's independently selected test. No already reserved target can enroll. */
export function priorCoreConflict(
  records: readonly CoreUse[],
  fund: StudyFund,
  issued: string,
  close: string,
  enrolled: string,
) {
  return records.some(
    (r) =>
      r.instrument === fund &&
      r.reservedAt <= enrolled &&
      (r.consumedThrough >= issued || r.testWindows.some((w) => w.issuedAt <= close && w.labelKnownAt >= issued)),
  );
}
function priorCoreCommitment(records: readonly CoreUse[], fund: StudyFund, through: string) {
  return digest(
    records
      .filter((r) => r.instrument === fund && r.reservedAt <= through)
      .map((r) =>
        digest({
          reservedAt: r.reservedAt,
          consumedThrough: r.consumedThrough,
          windows: r.testWindows.map((w) => ({ issuedAt: w.issuedAt, labelKnownAt: w.labelKnownAt })),
        }),
      )
      .sort(),
  );
}
function phaseInfo(r: Registration, training: Frozen | null, model: Fit | null, test: Frozen | null) {
  if (test) return null;
  if (model) return { phase: "test" as const, parent: digest(model), after: model.frozenAt };
  if (training) return { phase: "validation" as const, parent: digest(training), after: training.frozenAt };
  return { phase: "train" as const, parent: digest(r), after: r.registeredAt };
}
async function hasTransactionHeader(root: string, transaction: string, pending = false) {
  if (!uuid.test(transaction)) throw Error("Invalid core transaction identity");
  const p = pending
    ? join(root, ".consensus/evaluation-transaction.json")
    : join(root, COMPLETED_EVALUATIONS, transaction + ".json");
  try {
    const s = await lstat(p);
    if (!s.isFile() || s.mode & 0o077) throw Error("Untrusted completed core transaction");
    const f = await open(p, "r");
    try {
      // Journals also contain core prices. Read only the fixed non-price header.
      const prefix = Buffer.from('{\n  "schemaVersion": 1,\n  "id": "' + transaction + '",\n');
      const b = Buffer.alloc(prefix.length);
      const { bytesRead } = await f.read(b, 0, b.length, 0);
      if (bytesRead !== b.length || !b.equals(prefix)) throw Error("Changed completed core transaction header");
    } finally {
      await f.close();
    }
    return true;
  } catch (e) {
    if (noDir(e)) return false;
    throw e;
  }
}

export type NewCoreSettlement = Pick<
  Outcome,
  | "snapshotId"
  | "instrument"
  | "horizon"
  | "source"
  | "issuedAt"
  | "entryAt"
  | "exitAt"
  | "adjustment"
  | "calendarVersion"
> & { direction: () => 0 | 1 };
/** At most one inspected held-out outcome from any overlapping issue-to-receipt interval. */
export function disjointByReceipt<T extends { event: { registeredAt: string }; admission: { acceptedAt: string } }>(ordered: readonly T[]): T[] {
  const selected: T[] = [];
  let previousKnownAt = "";
  for (const row of ordered) {
    if (row.event.registeredAt <= previousKnownAt) continue;
    selected.push(row);
    previousKnownAt = row.admission.acceptedAt;
  }
  return selected;
}

export function createSecondaryStudy(options: Options) {
  const { directory, earliest, policy, policySha } = options;
  if (digest(policy) !== policySha) throw Error("Changed secondary policy requires a new preregistration");
  const funds = policy.instruments;
  const registrationPath = join(directory, "registration.json");
  const advanceMarker = join(directory, "advance-needed.json");
  const pathFor = (root: string, ...parts: string[]) => join(root, directory, ...parts);
  async function registration(root: string) {
    const r = await read<Registration>(join(root, registrationPath));
    if (
      r &&
      (r.policySha !== policySha ||
        digest(r.policy) !== policySha ||
        !canonical(r.registeredAt) ||
        r.registeredAt < earliest ||
        r.registeredAt > wall())
    )
      throw Error("The secondary study registration differs from its original policy or clock");
    if (!r && (await files(pathFor(root))).length) throw Error("The original secondary study registration is missing");
    return r;
  }
  async function register(root: string) {
    const old = await registration(root);
    if (old) return old;
    const registeredAt = wall();
    if (registeredAt < earliest) throw Error("Clock predates the joint preregistration policy");
    await first(join(root, registrationPath), { registeredAt, policy, policySha });
    return (await registration(root))!;
  }

  const eventFile = (root: string, fund: StudyFund, edition: string) => pathFor(root, fund, "events", edition + ".json");
  type PreopenSeal = { eventSha: string; confirmedAt: string };
  async function witness(root: string, e: Event) {
    const s = await read<PreopenSeal>(pathFor(root, e.fund, "witnesses", e.edition + ".json"));
    if (
      s &&
      (s.eventSha !== digest(e) ||
        !canonical(s.confirmedAt) ||
        s.confirmedAt < e.registeredAt ||
        s.confirmedAt >= exchangeSession(e.session)!.openAt ||
        s.confirmedAt > wall())
    )
      throw Error("Invalid secondary study pre-open seal");
    return s;
  }
  async function phaseFiles(root: string, fund: StudyFund) {
    const folder = pathFor(root, fund);
    const [train, validation, model, test, result, resultHead] = await Promise.all([
      read<Frozen>(join(folder, "training.json")),
      read<Frozen>(join(folder, "validation.json")),
      read<Fit>(join(folder, "model.json")),
      read<Frozen>(join(folder, "test.json")),
      read<{ parent: string; aggregate: Summary }>(join(folder, "result.json")),
      read<string>(join(folder, "result-head.json")),
    ]);
    if (
      (validation && (!train || validation.parent !== digest(train))) ||
      (model &&
        (!validation ||
          model.parent !== validation.parent ||
          digest(model.members) !== digest(validation.members) ||
          model.frozenAt < validation.frozenAt)) ||
      (test && (!model || test.parent !== digest(model))) ||
      (result && (!test || result.parent !== digest(test))) ||
      (resultHead && (!result || digest(result) !== resultHead))
    )
      throw Error("Invalid secondary study phase chain");
    return { train, model, test, result };
  }
  function validateEvent(e: Event, r: Registration) {
    if (
      !e ||
      e.registration !== digest(r) ||
      !funds.includes(e.fund) ||
      !editionPattern.test(e.edition) ||
      !options.validFeature(e) ||
      !checkedHash(e.sourceSeal) ||
      !checkedHash(e.parent) ||
      !checkedHash(e.previousCoreHeads) ||
      ![e.registeredAt, e.sourceReleasedAt, e.issuedAt, e.capturedAt].every(canonical) ||
      r.registeredAt >= e.registeredAt ||
      (options.requireNewRelease && r.registeredAt >= e.sourceReleasedAt) ||
      e.sourceReleasedAt > e.issuedAt ||
      e.issuedAt > e.capturedAt ||
      e.capturedAt > e.registeredAt ||
      newYorkDate(e.registeredAt) !== e.session ||
      ![e.candidate, e.control].every(Number.isFinite) ||
      !(["train", "validation", "test"] as Phase[]).includes(e.phase) ||
      (e.phase === "test"
        ? !e.prediction ||
          Object.keys(e.prediction).sort().join() !== "base,coin,control,signal" ||
          Object.values(e.prediction).some((p) => !Number.isFinite(p) || p < 0 || p > 1)
        : e.prediction !== null)
    )
      throw Error("Invalid as-issued secondary study enrollment");
    const c = exchangeSession(e.session);
    if (!c || Date.parse(c.closeAt) - Date.parse(c.openAt) !== 390 * 60000 || e.registeredAt >= c.openAt)
      throw Error("Secondary study enrollment outside the full pre-open session");
  }
  /** Only called after the original same-day live archive/witness has been verified. No historical input override. */
  async function enroll(root: string, session: string, edition: string) {
    const r = await registration(root);
    if (!r) return { status: "not_registered", enrolled: 0 };
    const start = wall(),
      c = hasReviewedCalendar(session) && exchangeSession(session);
    if (!c || Date.parse(c.closeAt) - Date.parse(c.openAt) !== 390 * 60000 || newYorkDate(start) !== session || start >= c.openAt) return { status: "outside_preopen", enrolled: 0 };
    const points = await options.readPoints(root, session, edition);
    if (!points.length) return { status: "no_new_witnessed_release", enrolled: 0 };
    const records = await readReservations(root);
    if (records.some((record) => record.reservedAt > wall()))
      throw Error("Existing core reservation postdates the current enrollment clock");
    let enrolled = 0;
    for (const p of points) {
      const fund = funds.find((f) => f === p.instrument);
      if (!fund || (options.requireNewRelease && p.observedThrough <= r.registeredAt)) continue;
      const { train, model, test } = await phaseFiles(root, fund),
        phase = phaseInfo(r, train, model, test);
      const registeredAt = wall();
      if (
        !phase ||
        phase.after >= registeredAt ||
        registeredAt >= c.openAt ||
        registeredAt < start ||
        priorCoreConflict(records, fund, p.issuedAt, c.closeAt, registeredAt)
      )
        continue;
      const e: Event = {
        registration: digest(r),
        fund,
        id: p.eventId,
        edition,
        session,
        issuedAt: p.issuedAt,
        sourceReleasedAt: p.observedThrough,
        sourceSeal: p.sourceSeal,
        capturedAt: p.recordedAt,
        registeredAt,
        control: p.control,
        candidate: p.candidate,
        phase: phase.phase,
        parent: phase.parent,
        previousCoreHeads: priorCoreCommitment(records, fund, registeredAt),
        prediction: phase.phase === "test" ? secondaryForecast(model!.model, p.control, p.candidate) : null,
      };
      validateEvent(e, r);
      const saved = await first(eventFile(root, fund, edition), e);
      validateEvent(saved, r);
      if (digest({ ...saved, registeredAt: e.registeredAt }) !== digest(e))
        throw Error("Conflicting pre-open secondary study enrollment");
      if (!(await witness(root, saved))) {
        const confirmedAt = wall();
        if (confirmedAt < saved.registeredAt || confirmedAt >= c.openAt) continue;
        await first(pathFor(root, fund, "witnesses", edition + ".json"), { eventSha: digest(saved), confirmedAt });
        if (!(await witness(root, saved))) throw Error("Lost secondary study pre-open seal");
      }
      enrolled++;
    }
    return { status: enrolled ? "registered_targets" : "outside_registered_phase_or_existing_holdout", enrolled };
  }

  /** Called from the first native core settlement only, after the core has sealed its transaction. Never reopen its outcome ledger. */
  async function stage(
    root: string,
    transaction: string,
    fresh: readonly NewCoreSettlement[],
    archives: readonly Pick<Snapshot, "id" | "issuedAt">[],
    reservations: readonly CoreUse[],
  ) {
    if (!fresh.length) return;
    if (!uuid.test(transaction)) throw Error("Invalid joint core-settlement transaction");
    const r = await registration(root);
    if (!r) return;
    let previous: Set<string> | undefined;
    for (const row of fresh) {
      try {
        const fund = funds.find((f) => f === row.instrument);
        if (!fund || row.horizon !== "daily" || !editionPattern.test(row.snapshotId) || !options.granted(fund, row.source))
          continue;
        const e = await read<Event>(eventFile(root, fund, row.snapshotId));
        if (!e) continue;
        if (!previous) {
          if (!(await hasTransactionHeader(root, transaction, true)))
            throw Error("No matching pending first-settlement transaction");
          const before: unknown = JSON.parse(await readFile(join(root, PUBLIC_OUTCOME_INDEX), "utf8"));
          validateOutcomeIndex(before);
          previous = new Set(before.filter((v) => v.horizon === "daily").map((v) => v.instrument + "/" + v.snapshotId));
        }
        if (previous.has(fund + "/" + row.snapshotId)) continue;
        validateEvent(e, r);
        if (!(await witness(root, e))) continue;
        const c = exchangeSession(e.session)!;
        if (
          e.fund !== fund ||
          e.edition !== row.snapshotId ||
          row.issuedAt !== e.issuedAt ||
          row.entryAt !== c.openAt ||
          row.exitAt !== c.closeAt ||
          row.adjustment !== OUTCOME_PRICE_BASIS ||
          row.calendarVersion !== exchangeCalendarVersion(e.session, e.session) ||
          c.closeAt >= wall() ||
          priorCoreConflict(reservations, fund, e.issuedAt, c.closeAt, e.registeredAt) ||
          priorCoreCommitment(reservations, fund, e.registeredAt) !== e.previousCoreHeads
        )
          continue;
        const final = archives
          .filter((a) => a.issuedAt < c.openAt)
          .reduce<(typeof archives)[number] | undefined>((a, b) => (!a || b.issuedAt > a.issuedAt ? b : a), undefined);
        if (final?.id !== e.edition) continue;
        // Verify exactly the original feature certificate again before receiving even its single sign.
        const source = (await options.readPoints(root, e.session, e.edition, fund)).find((x) => x.instrument === fund);
        if (
          !source ||
          source.issuedAt !== e.issuedAt ||
          source.recordedAt !== e.capturedAt ||
          source.observedThrough !== e.sourceReleasedAt ||
          source.sourceSeal !== e.sourceSeal ||
          source.eventId !== e.id ||
          source.candidate !== e.candidate ||
          source.control !== e.control
        )
          throw Error("The original secondary study feature differs");
        const eventSha = digest(e),
          dir = pathFor(root, fund);
        await durableJSON(join(root, advanceMarker), { transaction });
        const up = row.direction();
        if (up !== 0 && up !== 1) throw Error("Invalid direction from the normal core settlement");
        const secret = await first<Secret>(join(dir, "private-labels", e.edition + ".json"), {
          eventSha,
          transaction,
          up,
          salt: randomBytes(32).toString("hex"),
        });
        if (secret.eventSha !== eventSha || secret.transaction !== transaction || secret.up !== up)
          throw Error("Conflicting first core settlement");
        // The outcome is first knowable here, after its private sign has been durably received.
        const acceptedAt = wall();
        if (acceptedAt <= c.closeAt) throw Error("Core settlement clock moved before the close");
        const a = await first<Admission>(join(dir, "admissions", e.edition + ".json"), {
          eventSha,
          transaction,
          acceptedAt,
          source: row.source,
          labelCommitment: digest(secret),
        });
        if (a.eventSha !== eventSha || a.transaction !== transaction || a.labelCommitment !== digest(secret))
          throw Error("Conflicting secondary study admission");
      } catch (error) {
        console.error(
          "Private secondary study settlement unavailable for",
          row.instrument,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  type Inventory = {
    qualified: Qualified[];
    waiting: number;
    missedFirstSettlement: number;
    uncommitted: number;
    witnessed: number;
    unsealed: number;
    superseded: number;
    phases: Set<Phase>;
  };
  async function inventory(root: string, fund: StudyFund, r: Registration): Promise<Inventory> {
    const directory = pathFor(root, fund),
      names = await files(join(directory, "events"));
    const qualified: Qualified[] = [],
      eventIds = new Set<string>();
    let waiting = 0,
      missedFirstSettlement = 0,
      uncommitted = 0,
      unsealed = 0,
      superseded = 0;
    const phases = new Set<Phase>();
    // The four identity fields in this public index carry no price or outcome.
    const publicRows: unknown = names.length ? JSON.parse(await readFile(join(root, PUBLIC_OUTCOME_INDEX), "utf8")) : [];
    validateOutcomeIndex(publicRows);
    const archive = names.length
      ? (JSON.parse(await readFile(join(root, "public/consensus/index.json"), "utf8")) as {
          id: string;
          issuedAt: string;
        }[])
      : [];
    const resolved = new Set(
      publicRows.filter((row) => row.instrument === fund && row.horizon === "daily").map((row) => row.snapshotId),
    );
    for (const file of names) {
      const edition = file.endsWith(".json") ? file.slice(0, -5) : "";
      if (!editionPattern.test(edition)) throw Error("Invalid private joint event name");
      const event = await read<Event>(join(directory, "events", file));
      if (!event || event.edition !== edition || event.fund !== fund) throw Error("Missing sealed joint event");
      validateEvent(event, r);
      if (!(await witness(root, event))) {
        unsealed++;
        continue;
      }
      phases.add(event.phase);
      const admission = await read<Admission>(join(directory, "admissions", file));
      const openAt = exchangeSession(event.session)!.openAt;
      if (archive.some((s) => s.issuedAt > event.issuedAt && s.issuedAt < openAt)) {
        if (admission) throw Error("A settled study enrollment lost its final as-issued identity");
        superseded++;
        continue;
      }
      if (!admission) {
        if (resolved.has(edition)) missedFirstSettlement++;
        else waiting++;
        continue;
      }
      if (
        admission.eventSha !== digest(event) ||
        !canonical(admission.acceptedAt) ||
        admission.acceptedAt <= exchangeSession(event.session)!.closeAt ||
        admission.acceptedAt > wall() ||
        !options.granted(fund, admission.source) ||
        !checkedHash(admission.labelCommitment)
      )
        throw Error("Changed joint admission");
      if (!(await hasTransactionHeader(root, admission.transaction))) {
        uncommitted++;
        continue;
      }
      if (!resolved.has(edition) || eventIds.has(event.id))
        throw Error("Joint admission lost its public identity or repeats a source event");
      eventIds.add(event.id);
      qualified.push({
        event,
        admission,
        member: {
          id: event.id,
          edition,
          session: event.session,
          eventSha: digest(event),
          approvalSha: digest(admission),
        },
      });
    }
    return {
      qualified: qualified.sort((a, b) => a.member.session.localeCompare(b.member.session)),
      waiting,
      missedFirstSettlement,
      uncommitted,
      unsealed,
      superseded,
      phases,
      witnessed: names.length - unsealed,
    };
  }
  function validatePlan(p: Frozen, parent: string, phase: Phase, q: Qualified[]) {
    const n = policy[phase];
    if (
      p.parent !== parent ||
      !canonical(p.frozenAt) ||
      p.frozenAt > wall() ||
      !Array.isArray(p.members) ||
      p.members.length !== n ||
      new Set(p.members.map((m) => m.id)).size !== n
    )
      throw Error("Invalid sealed secondary study phase");
    const members = new Map(q.map((item) => [item.member.id, item]));
    return p.members.map((m, i) => {
      const item = members.get(m.id);
      if (
        !item ||
        item.event.phase !== phase ||
        item.event.parent !== parent ||
        digest(item.member) !== digest(m) ||
        item.admission.acceptedAt > p.frozenAt ||
        (i > 0 && (m.session <= p.members[i - 1].session ||
          (phase === "test" && options.disjointTests && item.event.registeredAt <= members.get(p.members[i - 1].id)!.admission.acceptedAt)))
      )
        throw Error("A frozen joint phase lost one of its original admissions");
      return item;
    });
  }
  async function sign(root: string, row: Qualified) {
    const s = await read<Secret>(pathFor(root, row.event.fund, "private-labels", row.event.edition + ".json"));
    if (
      !s ||
      s.eventSha !== row.member.eventSha ||
      s.transaction !== row.admission.transaction ||
      !checkedHash(s.salt) ||
      ![0, 1].includes(s.up) ||
      digest(s) !== row.admission.labelCommitment
    )
      throw Error("Sealed secondary outcome changed");
    return s.up;
  }
  async function trainingSet(root: string, rows: Qualified[]) {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.event.id,
        engineVersion: policy.method,
        issuedAt: row.event.registeredAt,
        labelKnownAt: row.admission.acceptedAt,
        features: [row.event.control, row.event.candidate],
        up: await sign(root, row),
      })),
    );
  }
  async function advanceFund(root: string, fund: StudyFund, r: Registration, change: boolean) {
    const data = await inventory(root, fund, r),
      dir = pathFor(root, fund),
      q = data.qualified;
    let { train, model, test, result } = await phaseFiles(root, fund);
    if ((!train && (data.phases.has("validation") || data.phases.has("test"))) || (!model && data.phases.has("test")))
      throw Error("An issued later-phase forecast lost its original frozen plan");
    const select = (phase: Phase, parent: string, after: string) => {
      const eligible = q.filter(v => v.event.phase === phase && v.event.parent === parent && v.event.registeredAt > after);
      return (phase === "test" && options.disjointTests ? disjointByReceipt(eligible) : eligible).slice(0, policy[phase]);
    };
    const freeze = (list: Qualified[], parent: string): Frozen => ({
      parent,
      members: list.map((v) => v.member),
      frozenAt: wall(),
    });
    const availableTrain = select("train", digest(r), r.registeredAt);
    if (change && !train && availableTrain.length === policy.train)
      train = await first(join(dir, "training.json"), freeze(availableTrain, digest(r)));
    const trainRows = train ? validatePlan(train, digest(r), "train", q) : [];
    const availableVal = train ? select("validation", digest(train), train.frozenAt) : [];
    if (change && train && !model && availableVal.length === policy.validation) {
      const chosen = await first(join(dir, "validation.json"), freeze(availableVal, digest(train)));
      const vr = validatePlan(chosen, digest(train), "validation", q);
      const [tr, va] = await Promise.all([trainingSet(root, trainRows), trainingSet(root, vr)]);
      if (new Set(tr.map((row) => row.up)).size < 2)
        return { instrument: fund, stage: "training_has_one_class", enrolled: data.witnessed, confirmed: q.length };
      model = await first(join(dir, "model.json"), { ...chosen, frozenAt: wall(), model: fitSecondary(tr, va, policy) });
    }
    if (model && train) validatePlan(model, digest(train), "validation", q);
    const availableTest = model ? select("test", digest(model), model.frozenAt) : [];
    if (change && model && !test && availableTest.length === policy.test)
      test = await first(join(dir, "test.json"), freeze(availableTest, digest(model)));
    if (test && model) {
      const tr = validatePlan(test, digest(model), "test", q);
      if (change && !result) {
        const fixed = await Promise.all(
          tr.map(async (v) => {
            const prediction = v.event.prediction;
            if (
              !prediction ||
              digest(prediction) !== digest(secondaryForecast(model!.model, v.event.control, v.event.candidate)) ||
              v.event.registeredAt <= model!.frozenAt
            )
              throw Error("The held-out prediction differs from its pre-open reservation");
            return { id: v.event.id, prediction, up: await sign(root, v) };
          }),
        );
        result = await first(join(dir, "result.json"), {
          parent: digest(test),
          aggregate: scoreSecondary(fund, policy, policySha, model.model, fixed),
        });
      }
      if (change && result) {
        const head = await first(join(dir, "result-head.json"), digest(result));
        if (head !== digest(result)) throw Error("Changed one-time secondary study result");
      }
    }
    return {
      instrument: fund,
      stage: result
        ? "evaluated_privately"
        : model
          ? "collecting_test"
          : train
            ? "collecting_validation"
            : "collecting_train",
      enrolled: data.witnessed,
      confirmed: q.length,
      train: trainRows.length || availableTrain.length,
      validation: model?.members.length ?? availableVal.length,
      test: test?.members.length ?? availableTest.length,
      awaitingFirstCoreSettlement: data.waiting,
      firstCoreSettlementNotCaptured: data.missedFirstSettlement,
      awaitingTransaction: data.uncommitted,
      unsealedPreopen: data.unsealed,
      supersededEnrollments: data.superseded,
    };
  }

  /** Public-facing predictions and the main model never read this private result. Status reads only counts and identities. */
  async function status(root: string, advance = false) {
    const r = await registration(root);
    const base = {
      method: policy.method,
      policySha,
      calendarThrough: REVIEWED_EXCHANGE_THROUGH,
      requiredPerFund: { train: 300, validation: 100, test: 100 },
      automaticPromotion: false,
    };
    if (!r) return { ...base, status: "not_registered", registeredAt: null, cohorts: [] };
    const cohorts = [];
    for (const fund of funds) {
      try {
        cohorts.push(await advanceFund(root, fund, r, advance));
      } catch (error) {
        cohorts.push({
          instrument: fund,
          stage: "private_evidence_needs_review",
          reason: error instanceof Error ? error.message : "Unable to verify private study",
        });
      }
    }
    if (
      advance &&
      cohorts.every(
        (c) => c.stage !== "private_evidence_needs_review" && !("awaitingTransaction" in c && c.awaitingTransaction),
      )
    ) {
      await unlink(join(root, advanceMarker)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
    return { ...base, status: "registered", registeredAt: r.registeredAt, cohorts };
  }
  return { register, enroll, stage, status, registrationPath, advanceMarker };
}
