import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("500 future monthly enrollments mature despite independently reserved core windows; test labels remain sealed until all forecasts exist", async (t) => {
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
  const r = await registerJointRetail(root);
  const folder = join(root, JOINT_RETAIL_ROOT, "SPY");
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
      const d = new Date(Date.UTC(2026, 11 + i, 7));
      d.setUTCDate(7 + ((2 - d.getUTCDay() + 7) % 7)); // A regular Tuesday after the hypothetical Monday release.
      const day = d.toISOString().slice(0, 10);
      const issuedAt = day + "T12:30:00.000Z",
        capturedAt = day + "T12:31:00.000Z",
        registeredAt = day + "T12:32:00.000Z",
        after = day + "T21:05:00.000Z";
      const eventId = "nyfed-sce:stock:" + new Date(Date.UTC(2026, 10 + i, 1)).toISOString().slice(0, 7);
      const edition = issuedAt.replace(/[:.]/g, "-"),
        sourceReleasedAt = new Date(+d - 86_400_000 + 16 * 3600000).toISOString();
      const earlier = lastClose || "2026-11-23T21:00:00.000Z";
      // Since every window of these three real-style core test schedules was settled earlier or reserved later,
      // their rolling global high-water marks do not delete this separately preregistered observation.
      const records = ["daily", "weekly", "monthly"].map((horizon) => ({
        instrument: "SPY",
        horizon,
        reservedAt: earlier,
        consumedThrough: earlier,
        testWindows: [{ issuedAt: new Date(Date.parse(earlier) - 10 * 86400000).toISOString(), labelKnownAt: earlier }],
      }));
      records.push({
        instrument: "SPY",
        horizon: "daily",
        reservedAt: after,
        consumedThrough: after,
        testWindows: [{ issuedAt, labelKnownAt: after }],
      });
      assert.equal(priorRetailCoreConflict(records, "SPY", issuedAt, after, registeredAt), false);
      assert.equal(priorRetailCoreConflict(records, "SPY", issuedAt, after, after), true);
      simulatedReservations += records.length;
      lastClose = after;
      const control = 38 + (i % 9),
        candidate = 40 + (i % 13);
      const event = {
        registration: hash(r),
        fund: "SPY",
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
        source: FIRST_RATE_SOURCE,
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
      ids.push({ snapshotId: edition, instrument: "SPY", horizon: "daily", engineVersion: "consensus-rules-2.0.0" });
      archive.push({ id: edition, issuedAt });
    }
    await raw(join(root, "public/consensus/outcomes.json"), ids);
    await raw(join(root, "public/consensus/index.json"), archive);
    t.mock.timers.setTime(Date.parse(lastClose) + 60000);
  }
  const status = async () => (await jointRetailStatus(root, true)).cohorts!.find((c) => c.instrument === "SPY")!;
  await cohort(0, 300, "train", hash(r));
  assert.equal((await status()).stage, "collecting_validation");
  const training = await loaded(join(folder, "training.json"));
  await cohort(300, 400, "validation", hash(training));
  assert.equal((await status()).stage, "collecting_test");
  const model = await loaded(join(folder, "model.json"));
  await cohort(400, 499, "test", hash(model), model.model);
  const unfinished = await status();
  assert.equal(unfinished.stage, "collecting_test");
  assert.equal("test" in unfinished && unfinished.test, 99);
  await assert.rejects(readFile(join(folder, "test.json")), { code: "ENOENT" });
  await cohort(499, 500, "test", hash(model), model.model);
  assert.equal((await status()).stage, "private_evidence_needs_review");
  const testPlan = await loaded(join(folder, "test.json"));
  assert.equal(testPlan.members.length, 100);
  assert.equal(testPlan.parent, hash(model));
  assert(simulatedReservations >= 2000);
  for (const item of testLabels) await save(item.path, item.value);
  const completed = await status();
  assert.equal(completed.stage, "evaluated_privately");
  assert.equal("confirmed" in completed && completed.confirmed, 500);
  const result = await loaded(join(folder, "result.json"));
  assert.equal(result.aggregate.testCount, 100);
  assert.equal(result.aggregate.promoted, false);
  assert.equal(result.aggregate.comparators.length, 3);
  await rm(testLabels[0].path);
  assert.equal((await status()).stage, "evaluated_privately");
});
