import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectAnalystRatings, replayAnalystVintage } from "../lib/consensus/analyst-ratings.ts";
import { analystStudy, priorRatingSession, ratingBreadth, witnessedRatingPair } from "../lib/consensus/analyst-study.ts";
import { digest } from "../lib/consensus/history.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import type { HistoryEntry, Snapshot } from "../lib/consensus/types.ts";

const fixture = await readFile(new URL("./fixtures/quantisnow-analyst-ratings-2026-11-06.json", import.meta.url), "utf8");
const counts = (u: number, d: number, i = 4, r = 2) => ({ upgrades: u, downgrades: d, initiations: i, reiterations: r, total: u + d + i + r });

test("rating changes use consecutive full calendar sessions, identical monthly bases and the provider's two populations", () => {
  assert.equal(priorRatingSession("2026-11-25")?.session, "2026-11-24");
  for (const excluded of ["2026-11-23", "2026-11-26", "2026-11-27", "2026-11-30", "2026-12-01"]) assert.equal(priorRatingSession(excluded), null);
  assert.deepEqual(ratingBreadth(counts(194,301), counts(213,316)), { candidate: 4 / 34, control: -107 / 495 });
  assert.deepEqual(ratingBreadth(counts(5,5), counts(6,6)), {candidate: 0, control: 0});
  for (const c of [counts(7,8,0), counts(5,5,4,3), counts(1,10), {...counts(6,6), total: 99}]) assert.equal(ratingBreadth(counts(5,5), c), null);
  assert.equal(ratingBreadth(counts(0,0), counts(1,3)), null);
});

test("normal collection pins native bytes and a witnessed, registered SPY forward pair enrolls once", async t => {
  const root = await mkdtemp(join(tmpdir(), "tdc-analyst-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({apis: ["Date"], now: Date.parse("2026-11-24T12:45:00.000Z")});
  await analystStudy.register(root);
  const dir = join(root, "public/consensus"), history: HistoryEntry[] = [];
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, "outcomes.json"), "[]");

  async function issue(day: string, increment = false) {
    const raw = JSON.parse(fixture); raw.updatedAt = day + " 06:15:37";
    const partial = raw.months.find((m: {monthToDate: boolean}) => m.monthToDate);
    if (increment) {
      for (const values of [partial.values, partial.breakdown[0].values]) {
        values.upgrades += 7; values.downgrades += 3; values.total += 10;
        values.ratio = values.upgrades / values.downgrades;
      }
    }
    const text = JSON.stringify(raw), sha256 = createHash("sha256").update(text).digest("hex");
    const captured = day + "T12:55:00.000Z";
    t.mock.timers.setTime(Date.parse(captured));
    const signal = await collectAnalystRatings(async () => ({text, sha256, retrievedAt: captured}), () => captured, undefined, root);
    const native = await replayAnalystVintage(root, signal, captured);
    assert.equal(native?.sha256, sha256);
    const issuedAt = day + "T13:02:00.000Z", id = issuedAt.replace(/[:.]/g, "-");
    const snapshot: Snapshot = { id, issuedAt, cutoff: captured, schemaVersion: 1, engineVersion: "consensus-rules-2.0.0",
      origin: "prospective", signals: [signal], catalysts: [], collectionErrors: [], sourcesAttempted: 1 };
    const archive = Buffer.from(JSON.stringify(snapshot));
    history.push({id, issuedAt, sha256: digest(snapshot), engineVersion: snapshot.engineVersion});
    const index = Buffer.from(JSON.stringify(history));
    await writeFile(join(dir, id + ".json"), archive); await writeFile(join(dir, "index.json"), index);
    return {id, day, signal, archive, index, sha256, captured};
  }
  const earlier = await issue("2026-11-24");
  t.mock.timers.setTime(Date.parse(earlier.day + "T13:03:00.000Z"));
  await recordPreopenReceipt(root, earlier.day, earlier.id, earlier.archive, earlier.index, new Date().toISOString());
  const current = await issue("2026-11-25", true);
  t.mock.timers.setTime(Date.parse(current.day + "T13:03:00.000Z"));
  await assert.rejects(witnessedRatingPair(root, current.day, current.id), /pre-open public archive receipt/);
  await recordPreopenReceipt(root, current.day, current.id, current.archive, current.index, new Date().toISOString());
  const pairs = await witnessedRatingPair(root, current.day, current.id);
  assert.equal(pairs.length, 1); assert.equal(pairs[0].instrument, "SPY"); assert.equal(pairs[0].candidate, 0.4);
  assert.equal(pairs[0].control, (66 - 98) / 164);
  const enrolled = await analystStudy.enroll(root, current.day, current.id);
  assert.equal(enrolled.enrolled, 1);
  await analystStudy.enroll(root, current.day, current.id);
  const status = await analystStudy.status(root);
  assert.equal(status.cohorts.length, 1);
  const mutated = structuredClone(current.signal);
  mutated.metrics.slice(-5)[0].value++;
  await assert.rejects(replayAnalystVintage(root, mutated, current.captured));
  const file = join(root, ".consensus/private-quantisnow-vintages/v1", current.sha256 + ".json");
  const original = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({...original, retrievedAt: current.day + "T13:06:00.000Z"}), {mode: 0o600});
  await assert.rejects(witnessedRatingPair(root, current.day, current.id), /cutoff/);
  await writeFile(file, JSON.stringify({...original, text: original.text + " "}), {mode: 0o600});
  await assert.rejects(witnessedRatingPair(root, current.day, current.id), /Invalid analyst/);
  await rm(file); assert.deepEqual(await witnessedRatingPair(root, current.day, current.id), []);
});
