import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
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
test("private settlement stays sealed on immature dates, and the holdout plan is durable before any outcomes are opened", async (t) => {
  const root = await fixture(t);
  const rows: Input[] = [];
  const first = Date.UTC(2030, 0, 1, 14, 30);
  for (let i = 0; i < 500; i++) {
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
