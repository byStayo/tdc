import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { evaluateCandidate, planCandidate } from "../lib/consensus/learning.ts";
import { NYFED_SCE_INDEX } from "../lib/consensus/nyfed-stock-outlook.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import {
  readProspectiveFamilyFeatures,
  recordProspectiveFamilyFeatures,
  RETAIL_POLICY_SHA256,
} from "../lib/consensus/prospective-family-features.ts";
import {
  auditProspectiveRetailOutcomes,
  evaluateMatureRetail,
  retailProductionProtection,
} from "../lib/consensus/prospective-retail-outcomes.ts";
import {
  collectRetailWithOriginals,
  RETAIL_ID,
  RETAIL_ROOT,
  retailInput,
} from "../lib/consensus/prospective-retail.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";
import { enrollJointRetail, jointRetailStatus, registerJointRetail, stageJointRetail, type NewCoreSettlement } from "../lib/consensus/retail-joint.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { COMPLETED_EVALUATIONS } from "../lib/consensus/outcome-ledger.ts";
import { durableJSON } from "../lib/publication-storage.ts";
type Input = Parameters<typeof evaluateMatureRetail>[3][number];

const session = "2026-12-08",
  signup = "2026-11-24T13:02:00.000Z";
const tick = (t: TestContext, at: string) => t.mock.timers.setTime(Date.parse(at));
async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(signup) });
  const root = await mkdtemp(join(tmpdir(), "consensus-retail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const url = (d: string) =>
  "https://www.newyorkfed.org/newsevents/news/research/2026/" + d.replaceAll("-", "");
async function collect(
  t: TestContext,
  root: string,
  day: string,
  reference: string,
  value: number,
  asOf: string,
  options: { calendarDay?: string; printed?: string; suffix?: string } = {},
) {
  tick(t, asOf);
  const printed = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
  const month = printed.split(" ")[0];
  const release = url(day),
    cal = "https://www.newyorkfed.org/research/calendars/i-" + month.slice(0, 3).toLowerCase() + "26.html";
  const bodies: Record<string, string> = {
    [NYFED_SCE_INDEX]: '<a href="' + new URL(release).pathname + '">release</a>',
    [release]:
      '<div class="ts-contact-info">' +
      (options.printed ?? printed) +
      "</div><p>Findings from the " +
      reference +
      " 2026 Survey are:</p><li>The mean perceived probability that U.S. stock prices will be higher 12 months from now rose by 0.4 percentage point to " +
      value +
      "%.</li>" +
      (options.suffix ?? ""),
    [cal]:
      '<table><tr><td class="ts-data-table-head"><div>' +
      month +
      " 2026</div></td></tr><tr><td><div>" +
      (options.calendarDay ?? day.slice(8)) +
      '<br/><span><a href="survey">Survey of Consumer Expectations</a><br/>(11:00)</span></div></td></tr></table>',
  };
  const calls: string[] = [];
  const signal = await collectRetailWithOriginals(async (k) => {
    calls.push(k);
    const bytes = Buffer.from(bodies[k]);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      retrievedAt: new Date().toISOString(),
    };
  }, root);
  return { signal, calls };
}
async function issue(t: TestContext, root: string, day: string, s: Signal, time = "13:04") {
  const now = day + "T" + time + ":00.000Z";
  tick(t, now);
  const id = now.replace(/[:.]/g, "-");
  const snap = {
    schemaVersion: 1,
    origin: "prospective",
    id,
    issuedAt: now,
    cutoff: now,
    engineVersion: "consensus-rules-2.0.0",
    signals: [s],
    catalysts: [],
    sourcesAttempted: 1,
    collectionErrors: [],
  };
  const bytes = Buffer.from(JSON.stringify(snap));
  await mkdir(join(root, "public/consensus"), { recursive: true });
  await writeFile(join(root, "public/consensus", id + ".json"), bytes);
  const index = Buffer.from(
    JSON.stringify([{ id, issuedAt: now, engineVersion: snap.engineVersion, sha256: digest(snap) }]),
  );
  await recordPreopenReceipt(root, day, id, bytes, index, now);
  return id;
}
test("a real pre-open registration binds two separate monthly originals and one full target per equity", async (t) => {
  const root = await fixture(t);
  const prior = await collect(t, root, "2026-11-09", "October", 40, signup);
  const nov = await issue(t, root, "2026-11-24", prior.signal);
  const first = await recordProspectiveFamilyFeatures(root, "2026-11-24", nov, "retail");
  assert.equal(first.policySha256, RETAIL_POLICY_SHA256);
  assert.equal(first.available, 0);
  assert(first.missing.every((r) => r.reason === "outside-survey-release-target"));
  assert.equal((await auditProspectiveRetailOutcomes(root)).status, "collecting_months");
  assert.equal((await readProspectiveFamilyFeatures(root)).registeredAt, null);
  const initial = await collect(t, root, "2026-12-07", "November", 41.3, "2026-12-07T16:01:20.000Z");
  assert.equal(initial.calls.length, 3);
  const newer = await collect(t, root, "2026-12-07", "November", 41.3, "2026-12-08T12:58:58.000Z", {
    suffix: "<!-- changed navigation -->",
  });
  assert.equal(newer.calls.length, 2);
  assert.notEqual(newer.signal.source.sha256, initial.signal.source.sha256);
  const id = await issue(t, root, session, newer.signal);
  const [a, b] = await Promise.all([
    recordProspectiveFamilyFeatures(root, session, id, "retail"),
    recordProspectiveFamilyFeatures(root, session, id, "retail"),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.available, 4);
  const out = await readProspectiveFamilyFeatures(root, session, "retail");
  assert.equal(out.rows.length, 4);
  assert.deepEqual(
    out.rows.map((r) => r.instrument),
    ["SPY", "QQQ", "IWM", "DIA"],
  );
  assert(
    out.rows.every(
      (r) =>
        r.eventId === "nyfed-sce:stock:2026-11" &&
        r.candidate === 41.3 &&
        r.control === 40 &&
        r.sourceHashes.length === 4 &&
        r.proofs.length === 3,
    ),
  );
  const late = await issue(t, root, session, newer.signal, "13:08");
  assert.equal((await readProspectiveFamilyFeatures(root, session, "retail")).rows.length, 0);
  await recordProspectiveFamilyFeatures(root, session, late, "retail");
  assert.equal((await readProspectiveFamilyFeatures(root, session, "retail")).rows.length, 4);
  const file = join(root, RETAIL_ROOT, "native/2026-10/first.json");
  const m = JSON.parse(await readFile(file, "utf8"));
  m.release.sha256 = "0".repeat(64);
  await writeFile(file, JSON.stringify(m));
  await assert.rejects(() => readProspectiveFamilyFeatures(root, session, "retail"), /no longer reproduces/);
});
test("joint enrollment uses the live witness and only the first authorized native core settlement", async (t) => {
  const root=await fixture(t), registration=await registerJointRetail(root);
  const initial=await collect(t,root,"2026-11-09","October",40,signup);
  const n=await issue(t,root,"2026-11-24",initial.signal);
  await recordProspectiveFamilyFeatures(root,"2026-11-24",n,"retail");
  const signal=await collect(t,root,"2026-12-07","November",41.3,"2026-12-07T16:01:00.000Z");
  const early=await issue(t,root,session,signal.signal);
  await recordProspectiveFamilyFeatures(root,session,early,"retail");
  assert.equal((await enrollJointRetail(root,session,early)).enrolled,4);
  const late=await issue(t,root,session,signal.signal,"13:08");
  await recordProspectiveFamilyFeatures(root,session,late,"retail");
  assert.equal((await enrollJointRetail(root,session,late)).enrolled,4);
  assert.equal((await registerJointRetail(root)).registeredAt,registration.registeredAt);
  const archives=await Promise.all([n,early,late].map(async id=>JSON.parse(await readFile(join(root,"public/consensus",id+".json"),"utf8")) as Snapshot));
  await durableJSON(join(root,"public/consensus/index.json"),archives.map(s=>({id:s.id,issuedAt:s.issuedAt,engineVersion:s.engineVersion,sha256:digest(s)})));
  tick(t,"2026-12-08T21:10:00.000Z");
  assert.equal((await enrollJointRetail(root,session,late)).status,"outside_preopen");
  const clock=exchangeSession(session)!, reads:string[]=[];
  const make=(s:Snapshot,fund:NewCoreSettlement["instrument"],source:string):NewCoreSettlement=>({
    snapshotId:s.id,instrument:fund,horizon:"daily",source,issuedAt:s.issuedAt,entryAt:clock.openAt,exitAt:clock.closeAt,
    calendarVersion:"us-equities-core-2026-reviewed-2026-11-03-v1",adjustment:"total-return-adjusted",
    direction:()=>{reads.push(fund+"/"+s.id);return 1;}});
  const firstRead=[make(archives[1],"SPY",FIRST_RATE_SOURCE),make(archives[2],"SPY",FIRST_RATE_SOURCE),
    make(archives[2],"QQQ",FIRST_RATE_SOURCE),make(archives[2],"IWM","https://example.com/unverified"),make(archives[2],"DIA",FIRST_RATE_SOURCE)];
  const tx="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const core=(instrument:string,reservedAt:string)=>({instrument,reservedAt,consumedThrough:clock.closeAt,
    testWindows:[{issuedAt:archives[2].issuedAt,labelKnownAt:clock.closeAt}]});
  const reservations=[core("QQQ","2026-12-08T13:01:00.000Z"),core("SPY","2026-12-08T21:01:00.000Z")] as Parameters<typeof stageJointRetail>[4];
  await durableJSON(join(root,"public/consensus/outcomes.json"),[]);
  await stageJointRetail(root,tx,firstRead,archives,reservations);
  assert.deepEqual(reads,[]);
  await durableJSON(join(root,".consensus/evaluation-transaction.json"),{schemaVersion:1,id:tx,synthetic:true});
  await stageJointRetail(root,tx,firstRead,archives,reservations);
  assert.deepEqual(reads,["SPY/"+late,"DIA/"+late]);
  await durableJSON(join(root,"public/consensus/outcomes.json"),firstRead.map(row=>({snapshotId:row.snapshotId,instrument:row.instrument,horizon:"daily",engineVersion:"consensus-rules-2.0.0"})));
  await stageJointRetail(root,tx,firstRead,archives,reservations);
  assert.deepEqual(reads,["SPY/"+late,"DIA/"+late]);
  const before=(await jointRetailStatus(root)).cohorts?.find(row=>row.instrument==="SPY");
  assert.equal(before && "awaitingTransaction" in before && before.awaitingTransaction,1);
  await durableJSON(join(root,COMPLETED_EVALUATIONS,tx+".json"),{schemaVersion:1,id:tx,synthetic:true});
  const after=(await jointRetailStatus(root,true)).cohorts!;
  assert.deepEqual(after.map(row=>[row.instrument,"confirmed" in row&&row.confirmed]),[["SPY",1],["QQQ",0],["IWM",0],["DIA",1]]);
  assert(after.every(row=>"supersededEnrollments" in row && row.supersededEnrollments===1));
  assert.equal((await jointRetailStatus(root)).status,"registered");
});
test("wrong issuer dates, late enrollment, short sessions and late controls cannot create a prospective survey pair", async (t) => {
  const root = await fixture(t),
    cur = await collect(t, root, "2026-12-07", "November", 41.3, "2026-12-07T16:01:00.000Z", {
      calendarDay: "08",
    });
  assert.equal(cur.signal.status, "available");
  await assert.rejects(() => readdir(join(root, RETAIL_ROOT, "native")));
  await collect(t, root, "2026-12-07", "November", 41.3, "2026-12-07T16:01:00.000Z", {
    suffix: "<p>Correction: this release has been revised.</p>",
  });
  await assert.rejects(() => readdir(join(root, RETAIL_ROOT, "native")));
  await collect(t, root, "2026-12-07", "November", 41.3, "2026-12-07T16:01:00.000Z", {
    printed: "December 8, 2026",
  });
  await assert.rejects(() => readdir(join(root, RETAIL_ROOT, "native")));
  await collect(t, root, "2026-11-09", "October", 40, "2026-11-24T13:00:00.000Z");
  const ok = await collect(t, root, "2026-12-07", "November", 41.3, "2026-12-07T16:03:00.000Z");
  assert.deepEqual(
    await retailInput(root, ok.signal, session, "2026-12-08T13:00:00.000Z", "2026-12-07T16:03:00.000Z"),
    { reason: "release-predates-registration" },
  );
  assert.deepEqual(
    await retailInput(
      root,
      {
        ...ok.signal,
        source: {
          ...ok.signal.source,
          releasedAt: "2026-11-25",
          url: url("2026-11-25"),
          observedAt: "2026-10-31",
        },
        series: [{ date: "2026-10-31", value: 41.3 }],
        metrics: [],
      },
      "2026-11-27",
      "2026-11-27T13:00:00.000Z",
      signup,
    ),
    { reason: "outside-survey-release-target" },
  );
  const path = join(root, RETAIL_ROOT, "native/2026-10/first.json"),
    prior = JSON.parse(await readFile(path, "utf8"));
  prior.sealedAt = "2026-12-07T16:02:00.000Z";
  await writeFile(path, JSON.stringify(prior));
  assert.deepEqual(await retailInput(root, ok.signal, session, "2026-12-08T13:00:00.000Z", signup), {
    reason: "native-proof-mismatch",
  });
});
function monthlyInputs(count: number) {
  const rows: Input[] = [];
  const first = Date.UTC(2030, 0, 1, 14, 30);
  for (let i = 0; i < count; i++) {
    const instant = (offset: number) => new Date(first + i * 31 * 86_400_000 + offset).toISOString(),
      session = instant(0).slice(0, 10);
    const point = {
      id: RETAIL_ID,
      instrument: "SPY",
      family: "retail",
      horizon: "daily",
      policySha256: RETAIL_POLICY_SHA256,
      recordedAt: instant(-60_000),
      eventId: "nyfed-sce:stock:" + session.slice(0, 7),
      candidate: (i % 9) + 0.1,
      control: i % 7,
      edition: instant(-120_000).replace(/[:.]/g, "-"),
    } as Input["point"];
    rows.push({
      point,
      labelKnownAt: instant(42 * 60 * 60_000),
      request: {
        slot: i,
        session,
        openAt: instant(0),
        closeAt: instant(390 * 60_000),
        issuedAt: instant(-120_000),
        identity: {
          snapshotId: point.edition,
          instrument: "SPY",
          horizon: "daily",
          engineVersion: "consensus-rules-2.0.0",
        },
      },
    });
  }
  return rows;
}
test("private settlement stays sealed on immature dates, and the holdout plan is durable before any outcomes are opened", async (t) => {
  const root = await fixture(t);
  const rows = monthlyInputs(500);
  const asOf = "2080-01-01T00:00:00.000Z",
    dir = join(root, "maturity");
  const noRead = async () => {
    throw Error("outcomes opened too early");
  };
  assert.equal(
    (await evaluateMatureRetail(dir, "SPY", signup, rows.slice(0, -1), asOf, noRead)).status,
    "collecting_months",
  );
  const actual = await evaluateMatureRetail(dir, "SPY", signup, rows, asOf, async (slots) => {
    const plan = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
    const seal = JSON.parse(await readFile(join(dir, "plan-seal.json"), "utf8"));
    assert.equal(seal.planSha256, digest(plan));
    assert.equal(plan.testIds.length, 100);
    assert.equal(slots.length, 500);
    return new Map(
      slots.map((r) => [r.slot, { status: "paired" as const, up: (r.slot % 3 === 0 ? 1 : 0) as 0 | 1 }]),
    );
  });
  assert.equal(actual.status, "evaluated_private");
  assert.equal(
    (await evaluateMatureRetail(dir, "SPY", signup, rows.slice(1), asOf, noRead)).status,
    "evaluated_private",
  );
  const aggregate = join(dir, "aggregate.json"),
    saved = JSON.parse(await readFile(aggregate, "utf8"));
  saved.candidateBrier = 0;
  await writeFile(aggregate, JSON.stringify(saved));
  await assert.rejects(() => evaluateMatureRetail(dir, "SPY", signup, rows, asOf, noRead), /Changed sealed/);
  const planFile = join(dir, "plan.json"),
    planCopy = JSON.parse(await readFile(planFile, "utf8"));
  planCopy.frozenAt = "2079-01-01T00:00:00.000Z";
  await writeFile(planFile, JSON.stringify(planCopy));
  await assert.rejects(
    () => evaluateMatureRetail(dir, "SPY", signup, rows, asOf, noRead),
    /Changed sealed private SCE test plan/,
  );
  const overlapping = retailProductionProtection([], [], [
    { instrument: "SPY", testWindows: [{ issuedAt: signup, labelKnownAt: asOf }], consumedThrough: asOf },
  ] as Parameters<typeof retailProductionProtection>[2]);
  assert.equal(
    overlapping("SPY", signup, "2026-12-08T14:30:00.000Z", "2026-12-08T21:00:00.000Z"),
    "reserved_window",
  );
  assert.equal(overlapping("QQQ", signup, "2026-12-08T14:30:00.000Z", "2026-12-08T21:00:00.000Z"), null);
  const later = retailProductionProtection([], [], [
    {instrument:"SPY", testWindows:[{issuedAt:"2026-12-09T12:00:00.000Z",labelKnownAt:"2026-12-10T02:00:00.000Z"}],consumedThrough:signup}
  ] as Parameters<typeof retailProductionProtection>[2]);
  const interval = ["2026-12-08T13:00:00.000Z","2026-12-08T14:30:00.000Z","2026-12-08T21:00:00.000Z"] as const;
  assert.equal(later("SPY",...interval),null);
  assert.equal(later("SPY",...interval,"2026-12-09T12:00:00.000Z"),"reserved_window");
});

test("a delayed production price crosses both fold boundaries and purges overlapping test decisions before label access", async (t) => {
  const root = await fixture(t), dir = join(root, "delayed-maturity");
  const rows = monthlyInputs(501), asOf = "2080-01-01T00:00:00.000Z";
  const neverRead = async () => { throw Error("Opened private directions before a sufficient independent holdout"); };
  rows[299].labelKnownAt = rows[300].point.recordedAt;
  rows[399].labelKnownAt = rows[400].point.recordedAt;
  rows[420].labelKnownAt = rows[421].point.recordedAt;
  assert.equal((await evaluateMatureRetail(dir, "SPY", signup, rows.slice(0, 500), asOf, neverRead)).status,
    "awaiting_nonoverlapping_test");
  await assert.rejects(readFile(join(dir, "plan.json")), { code: "ENOENT" });
  assert.equal((await evaluateMatureRetail(dir, "SPY", signup, rows, rows[500].labelKnownAt, neverRead)).status,
    "awaiting_nonoverlapping_test");
  const selected = rows.filter((_, i) => i !== 421);
  const up = (slot: number): 0 | 1 => slot % 3 === 0 ? 1 : 0;
  const actual = await evaluateMatureRetail(dir, "SPY", signup, rows, asOf, async (requests) => {
    assert.deepEqual(requests.map(r => r.slot), selected.map(p => p.request.slot));
    const plan = JSON.parse(await readFile(join(dir, "plan.json"), "utf8"));
    const seal = JSON.parse(await readFile(join(dir, "plan-seal.json"), "utf8"));
    assert.equal(seal.planSha256, digest(plan));
    assert.deepEqual(plan.testIds, selected.slice(400).map(p => p.point.eventId));
    assert.deepEqual(plan.features.map((p: {labelKnownAt:string})=>p.labelKnownAt), selected.map(p=>p.labelKnownAt));
    return new Map(requests.map(r => [r.slot, {status: "paired" as const, up: up(r.slot)}]));
  });
  assert.equal(actual.status, "evaluated_private");
  const checked = planCandidate(selected.map(({point, request, labelKnownAt}) => ({
    id: point.eventId, engineVersion: RETAIL_ID, issuedAt: point.recordedAt, labelKnownAt,
    features: [point.control, point.candidate], up: up(request.slot)
  })), asOf, {minimumSamples:500, minimumTestSamples:100, nonOverlappingTest:true});
  assert(checked.status === "ready");
  assert.deepEqual([checked.split.train.length, checked.split.validation.length, checked.split.test.length], [299,99,100]);
  const saved = JSON.parse(await readFile(join(dir, "aggregate.json"), "utf8"));
  assert.equal(saved.pairedDatasetSha256, checked.datasetHash);
  assert.equal(saved.coefficient, evaluateCandidate(checked).model.weights[1]);
  const bad = {...rows[0], labelKnownAt: rows[0].request.openAt};
  await assert.rejects(evaluateMatureRetail(dir, "SPY", signup, [bad], asOf, neverRead), /maturity pool/);
});

test("an already reserved close-based monthly plan stays fixed when the matching label actually arrived later", async (t) => {
  const root = await fixture(t), dir = join(root, "legacy-maturity");
  const rows = monthlyInputs(500), asOf = "2080-01-01T00:00:00.000Z";
  const features = rows.map(({point,request}) => ({id: point.eventId, sha256: digest(point), edition: point.edition,
    issuedAt: point.recordedAt, labelKnownAt: request.closeAt}));
  const plan = { version:1, policySha256:RETAIL_POLICY_SHA256, instrument:"SPY", registeredAt:signup, frozenAt:asOf,
    features, testStarts:features[400].issuedAt, testIds: features.slice(400).map(r=>r.id)};
  const seal = {version:1, policySha256:RETAIL_POLICY_SHA256, planSha256:digest(plan)};
  await mkdir(dir, {mode:0o700});
  await durableJSON(join(dir,"plan.json"),plan,true);
  await durableJSON(join(dir,"plan-seal.json"),seal,true);
  const neverRead = async () => { throw Error("Reopened labels for a changed legacy clock"); };
  assert.equal((await evaluateMatureRetail(dir,"SPY",signup,rows,asOf,neverRead)).status,"reserved_label_clock_changed");
  assert.equal((await evaluateMatureRetail(dir,"SPY",signup,[],asOf,neverRead)).status,
    "reserved_source_or_production_window_unavailable");
  assert.deepEqual(JSON.parse(await readFile(join(dir,"plan.json"),"utf8")),plan);
  assert.deepEqual(await readdir(dir), ["plan-seal.json","plan.json"]);
  const past = {policy:RETAIL_POLICY_SHA256, planSha256:seal.planSha256, passes:true, promoted:false};
  await durableJSON(join(dir,"aggregate.json"),past,true);
  await durableJSON(join(dir,"result-seal.json"),{version:1, planSha256:seal.planSha256,
    passes:true, resultSha256:digest(past)},true);
  const retained = await evaluateMatureRetail(dir,"SPY",signup,[],asOf,neverRead);
  assert.equal(retained.status, "sealed_legacy_result");
  assert(!("passes" in retained));
});

test("unsettled production windows and intraday next-target editions protect future validation dates across horizons", () => {
  const sessions = exchangeSessions("2026-01-02", "2027-07-30").slice(0, 330);
  const edition = (issuedAt: string) =>
    ({
      id: issuedAt.replace(/[:.]/g, "-"),
      issuedAt,
      cutoff: issuedAt,
      signals: [],
      engineVersion: "consensus-rules-2.0.0",
    }) as unknown as Snapshot;
  const snapshots = sessions.map((s) => edition(s + "T12:00:00.000Z"));
  const check = (list: Snapshot[], day: string) => {
    const clock = exchangeSession(day)!;
    return retailProductionProtection(list, [], [])(
      "SPY",
      day + "T12:00:00.000Z",
      clock.openAt,
      clock.closeAt,
    );
  };
  assert.equal(check(snapshots, sessions[38]), null);
  assert.equal(check(snapshots, sessions[302]), "possible_validation_or_test");
  // A second publication for the same entry date consumes no additional rank.
  const versions = snapshots.flatMap((s) => [s, edition(s.issuedAt.replace("12:00", "12:05"))]);
  assert.equal(check(versions, sessions[260]), null);
  // A pre-close edition can register the following target while this target is still trading.
  const day = sessions[299],
    extra = edition(day + "T18:00:00.000Z");
  assert.equal(check(snapshots, day), null);
  assert.equal(
    check([...snapshots.slice(0, 300), extra, ...snapshots.slice(300)], day),
    "possible_validation_or_test",
  );
});
