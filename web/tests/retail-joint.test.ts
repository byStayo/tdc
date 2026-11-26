import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

async function checkFuturePhases(t: TestContext, daily: boolean) {
  const root = await mkdtemp(join(tmpdir(), "retail-joint-future-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Isolated synthetic clock: the real operational calendar still stops in November 2027.
  const url = new URL("../lib/consensus/exchange-calendar.ts", import.meta.url).href;
  const hooks = registerHooks({
    load(target, ctx, next) {
      if (target !== url) return next(target, ctx);
      return {
        format: "module",
        shortCircuit: true,
        source: `
      export const EXCHANGE_CALENDAR={from:"2026-01-01",through:"2070-01-01"};
      export const REVIEWED_EXCHANGE_THROUGH=EXCHANGE_CALENDAR.through;
      export const exchangeCalendarVersion=()=>"synthetic-weekday-calendar";
      export const hasReviewedCalendar=d=>d>=EXCHANGE_CALENDAR.from && d<=REVIEWED_EXCHANGE_THROUGH;
      export const verifyExpectedSessions=a=>a;
      export const exchangeSession=d=>({session:d,openAt:d+"T14:30:00.000Z",closeAt:d+"T21:00:00.000Z"});
      export const exchangeSessions=()=>[];
      export const availableExchangeSessions=exchangeSessions, trailingExchangeSessions=exchangeSessions;
      export const isUnresolvedExchangeDate=()=>false;
      export const hasReviewedCalendarRange=(from,through)=>hasReviewedCalendar(from)&&hasReviewedCalendar(through)&&from<=through;
    `,
      };
    },
  });
  t.after(() => hooks.deregister());
  const { registerJointRetail, jointRetailStatus, JOINT_RETAIL_ROOT, priorRetailCoreConflict } = await import(
    "../lib/consensus/retail-joint.ts"
  );
  const { retailForecast } = await import("../lib/consensus/retail-joint-model.ts");
  const { FIRST_RATE_SOURCE } = await import("../lib/consensus/firstrate.ts");
  const { COMPLETED_EVALUATIONS } = await import("../lib/consensus/outcome-ledger.ts");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T14:01:00Z") });
  const study = daily ? (await import("../lib/consensus/premarket-study.ts")).premarketStudy :
    { register: registerJointRetail, status: jointRetailStatus, registrationPath: JOINT_RETAIL_ROOT + "/registration.json" };
  const r = await study.register(root);
  const fund = daily ? "TLT" : "SPY";
  const source = daily ? (await import("../lib/consensus/market-history-settlement.ts")).MARKET_HISTORY_SOURCE : FIRST_RATE_SOURCE;
  const folder = join(root, dirname(study.registrationPath), fund);
  const businessDay = (i: number) => new Date(Date.UTC(2027, 0, 4 + Math.floor(i / 5) * 7 + i % 5));
  const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  const raw = async (p: string, x: unknown) => {
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, JSON.stringify(x, null, 2) + "\n", { mode: 0o600 });
  };
  const save = (p: string, x: unknown) => raw(p, { value: x, sha256: hash(x) });
  const loaded = async (p: string) => JSON.parse(await readFile(p, "utf8")).value;
  const testLabels: { path: string; value: unknown }[] = [];
  const ids: object[] = [],
    archive: object[] = [];
  let simulatedReservations = 0,
    lastClose = "";
  async function cohort(
    start: number,
    end: number,
    phase: "train" | "validation" | "test",
    parent: string,
    model?: Parameters<typeof retailForecast>[0],
  ) {
    for (let i = start; i < end; i++) {
      const d = daily ? businessDay(i) : new Date(Date.UTC(2026, 11 + i, 7));
      if (!daily) d.setUTCDate(7 + ((2 - d.getUTCDay() + 7) % 7)); // A regular Tuesday after the hypothetical Monday release.
      const day = d.toISOString().slice(0, 10);
      const issuedAt = day + "T12:30:00.000Z",
        capturedAt = day + "T12:31:00.000Z",
        registeredAt = day + "T12:32:00.000Z",
        after = (daily && i === 400 ? businessDay(401).toISOString().slice(0, 10) : day) + "T21:05:00.000Z";
      const eventId = daily ? "prior-premarket:" + fund + ":" + day : "nyfed-sce:stock:" + new Date(Date.UTC(2026, 10 + i, 1)).toISOString().slice(0, 7);
      const edition = issuedAt.replace(/[:.]/g, "-"),
        sourceReleasedAt = new Date(+d - 86_400_000 + 16 * 3600000).toISOString();
      const earlier = lastClose || "2026-11-23T21:00:00.000Z";
      // Since every window of these three real-style core test schedules was settled earlier or reserved later,
      // their rolling global high-water marks do not delete this separately preregistered observation.
      const records = ["daily", "weekly", "monthly"].map((horizon) => ({
        instrument: fund,
        horizon,
        reservedAt: earlier,
        consumedThrough: earlier,
        testWindows: [{ issuedAt: new Date(Date.parse(earlier) - 10 * 86400000).toISOString(), labelKnownAt: earlier }],
      }));
      records.push({
        instrument: fund,
        horizon: "daily",
        reservedAt: after,
        consumedThrough: after,
        testWindows: [{ issuedAt, labelKnownAt: after }],
      });
      assert.equal(priorRetailCoreConflict(records, fund, issuedAt, after, registeredAt), false);
      assert.equal(priorRetailCoreConflict(records, fund, issuedAt, after, after), true);
      simulatedReservations += records.length;
      lastClose = after;
      const control = daily ? (i % 5) - 2 : 38 + (i % 9),
        candidate = daily ? ((i % 13) - 6) / 10 : 40 + (i % 13);
      const event = {
        registration: hash(r),
        fund,
        id: eventId,
        edition,
        session: day,
        issuedAt,
        sourceReleasedAt,
        sourceSeal: hash([i, "original"]),
        capturedAt,
        registeredAt,
        control,
        candidate,
        phase,
        parent,
        previousCoreHeads: hash(records.slice(0, 3)),
        prediction: model ? retailForecast(model, control, candidate) : null,
      };
      const eventSha = hash(event),
        transaction = "aaaaaaaa-aaaa-4aaa-bbbb-" + String(i + 1).padStart(12, "0");
      const label = { eventSha, transaction, up: (i * 7) % 13 < 6 ? 1 : 0, salt: hash(["synthetic", i]) };
      const admission = {
        eventSha,
        transaction,
        acceptedAt: after,
        source,
        labelCommitment: hash(label),
      };
      const af = edition + ".json";
      await Promise.all([
        save(join(folder, "events", af), event),
        save(join(folder, "witnesses", af), { eventSha, confirmedAt: day + "T12:33:00.000Z" }),
        save(join(folder, "admissions", af), admission),
        raw(join(root, COMPLETED_EVALUATIONS, transaction + ".json"), {
          schemaVersion: 1,
          id: transaction,
          synthetic: true,
        }),
      ]);
      if (phase === "test") testLabels.push({ path: join(folder, "private-labels", af), value: label });
      else await save(join(folder, "private-labels", af), label);
      ids.push({ snapshotId: edition, instrument: fund, horizon: "daily", engineVersion: "consensus-rules-2.0.0" });
      archive.push({ id: edition, issuedAt });
    }
    await raw(join(root, "public/consensus/outcomes.json"), ids);
    await raw(join(root, "public/consensus/index.json"), archive);
    t.mock.timers.setTime(Date.parse(lastClose) + 60000);
  }
  const status = async () => (await study.status(root, true)).cohorts!.find(c => c.instrument === fund)!;
  await cohort(0, 300, "train", hash(r));
  assert.equal((await status()).stage, "collecting_validation");
  const training = await loaded(join(folder, "training.json"));
  await cohort(300, 400, "validation", hash(training));
  assert.equal((await status()).stage, "collecting_test");
  const model = await loaded(join(folder, "model.json"));
  const last = daily ? 501 : 500; // The second daily test decision overlapped the first delayed receipt.
  await cohort(400, last - 1, "test", hash(model), model.model);
  const unfinished = await status();
  assert.equal(unfinished.stage, "collecting_test");
  assert.equal("test" in unfinished && unfinished.test, 99);
  await assert.rejects(readFile(join(folder, "test.json")), { code: "ENOENT" });
  await cohort(last - 1, last, "test", hash(model), model.model);
  assert.equal((await status()).stage, "private_evidence_needs_review");
  const testPlan = await loaded(join(folder, "test.json"));
  assert.equal(testPlan.members.length, 100);
  assert.equal(testPlan.parent, hash(model));
  assert(simulatedReservations >= 2000);
  if (daily) {
    const overlapping = businessDay(401).toISOString().slice(0, 10);
    assert(testPlan.members.every((m: { session: string }) => m.session !== overlapping));
  }
  // The overlapping receipt deliberately lacks a label file. A completed test proves it was never opened.
  for (const [i, item] of testLabels.entries()) if (!daily || i !== 1) await save(item.path, item.value);
  const completed = await status();
  assert.equal(completed.stage, "evaluated_privately");
  assert.equal("confirmed" in completed && completed.confirmed, last);
  const result = await loaded(join(folder, "result.json"));
  assert.equal(result.aggregate.testCount, 100);
  assert.equal(result.aggregate.promoted, false);
  assert.equal(result.aggregate.comparators.length, 3);
  await rm(testLabels[0].path);
  assert.equal((await status()).stage, "evaluated_privately");
}

test("500 future monthly enrollments preserve core windows and test labels stay sealed until all forecasts exist", t => checkFuturePhases(t, false));
test("the daily premarket policy matures after 500 disjointly partitioned targets and excludes a delayed overlapping test label", t => checkFuturePhases(t, true));
