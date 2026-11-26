import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyReviewedEarnings, attachReview, validateReview, type ReviewPacket } from "../lib/consensus/reviewed.ts";
import { guidanceRows } from "../lib/consensus/guidance.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { applyScoringPolicy } from "../lib/consensus/scoring-policy.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import { INSTRUMENTS, type Snapshot } from "../lib/consensus/types.ts";

const cutoff = "2026-11-03T22:00:00.000Z";
const review: ReviewPacket = JSON.parse(await readFile(new URL("./fixtures/amd-reviewed-2026-11-03.json", import.meta.url), "utf8"));
function snapshot(): Snapshot {
  return { schemaVersion: 1, id: "2026-11-03T22-00-00-000Z", issuedAt: cutoff, cutoff, origin: "prospective", engineVersion: "test-v1", signals: missingSignals(cutoff), catalysts: [], sourcesAttempted: 0, collectionErrors: [] };
}

test("a reviewed issuer absent from SEC collection gets exact quarter facts, original provenance and no directional vote", () => {
  const before = snapshot(), encoded = JSON.stringify(before);
  const next = applyScoringPolicy(attachReview(before, review));
  validateSnapshot(next);
  const amd = next.signals.find((s) => s.id === "earnings-AMD")!;
  assert.deepEqual(amd.instruments, ["MARKET", "SPY", "QQQ"]);
  assert.deepEqual(amd.series, [{ date: "2025-09-27", value: 9.246 }, { date: "2026-09-26", value: 13.377 }]);
  assert.equal(amd.metrics.find((m) => m.label === "GAAP diluted EPS")!.value, 1.46);
  assert.equal(amd.metrics.find((m) => m.label === "Prior-year GAAP diluted EPS")!.value, 0.75);
  assert.ok(Math.abs(amd.metrics[1].value - (13.377 / 9.246 - 1) * 100) < 1e-10);
  assert.equal(amd.source.observedAt, "2026-09-26");
  assert.equal(amd.source.releasedAt, "2026-11-03T21:15:00.000Z");
  assert.equal(amd.source.retrievedAt, review.sources[0].retrievedAt);
  assert.equal(amd.source.sha256, review.sources[0].sha256);
  assert.deepEqual(amd.scores, { daily: null, weekly: null, monthly: null });
  assert.equal(JSON.stringify(before), encoded);
});

test("full recollection retains reviewed-only issuers and timestamp-only rechecks create no new evidence", () => {
  const initial = applyScoringPolicy(attachReview(snapshot(), review));
  const rechecked = structuredClone(review);
  rechecked.reviewedAt = cutoff;
  rechecked.sources.forEach((s) => { s.retrievedAt = cutoff; });
  const next = applyScoringPolicy(attachReview(initial, rechecked));
  const recollected = applyScoringPolicy(attachReview(snapshot(), review));
  assert.equal(next.signals.filter((s) => s.id === "earnings-AMD").length, 1);
  assert.equal(observationDigest(next), observationDigest(initial));
  assert.equal(observationDigest(recollected), observationDigest(initial));
});

test("a subsequent quarter supersedes the saved AMD release and same-quarter conflicts stop publication", () => {
  const signal = applyReviewedEarnings([], review, cutoff)[0];
  const conflict = structuredClone(signal);
  conflict.metrics[0].value = 14;
  assert.throws(() => applyReviewedEarnings([conflict], review, cutoff), /Conflicting/);
  const later = structuredClone(conflict);
  later.source.observedAt = "2026-12-26";
  assert.deepEqual(applyReviewedEarnings([later], review, "2027-02-01T00:00:00.000Z"), [later]);
});

test("AMD outlook keeps company range arithmetic and excludes unrelated instrument views", () => {
  const next = applyScoringPolicy(attachReview(snapshot(), review));
  for (const instrument of INSTRUMENTS) {
    const rows = guidanceRows(next, instrument, cutoff);
    const applicable = ["MARKET", "SPY", "QQQ"].includes(instrument);
    assert.equal(rows.length, applicable ? 1 : 0, instrument);
    if (!applicable) continue;
    assert.ok(Math.abs(rows[0].low - 16.49) < 1e-10);
    assert.ok(Math.abs(rows[0].high - 17.51) < 1e-10);
    assert.equal(rows[0].fiscalPeriod, "FY2026 Q4");
    assert.equal(rows[0].reviewDue, null);
  }
  assert.equal(guidanceRows(snapshot(), "MARKET", cutoff).length, 0);
});

test("the completed AMD schedule disappears only from the new edition, while its past calendar remains intact", () => {
  const scheduled = structuredClone(review);
  scheduled.earnings = []; scheduled.guidance = []; scheduled.developments = [];
  scheduled.sources[0] = { ...scheduled.sources[0], id: "amd-schedule", url: "https://ir.amd.com/news-events/press-releases/detail/1300/amd-to-report-fiscal-third-quarter-2026-financial-results", publishedAt: "2026-10-06" };
  scheduled.earningsSchedule = [{ ticker: "AMD", sourceId: "amd-schedule", fiscalPeriod: "FY2026 Q3", reportDate: "2026-11-03", releaseTiming: "after_close", webcastAt: "2026-11-03T22:00:00.000Z" }];
  const earlier = attachReview(snapshot(), scheduled), encoded = JSON.stringify(earlier);
  assert.ok(earlier.catalysts.some((c) => c.id.startsWith("issuer-earnings-amd")));
  const next = applyScoringPolicy(attachReview(earlier, review));
  validateSnapshot(next);
  assert.equal(next.catalysts.some((c) => c.id.startsWith("issuer-earnings-amd")), false);
  assert.equal(next.signals.some((s) => s.id === "issuer-calendar-amd"), false);
  assert.equal(JSON.stringify(earlier), encoded);
  assert.equal(guidanceRows(earlier, "MARKET", cutoff).length, 0);
  assert.notEqual(observationDigest(next), observationDigest(earlier));
});

test("AMD facts and outlook reject another issuer's source and unverified future evidence", () => {
  for (const mutate of [
    (p: ReviewPacket) => { p.sources[0].url = "https://www.apple.com/newsroom/2026/11/results/"; },
    (p: ReviewPacket) => { p.sources[0].publishedAt = "2026-11-04T00:00:00.000Z"; },
    (p: ReviewPacket) => { p.earnings[0].priorPeriodEnd = "2025-06-28"; },
    (p: ReviewPacket) => { p.guidance![0].revenue = { kind: "midpoint_tolerance", midpoint: 17, tolerancePercent: 100 }; },
  ]) {
    const changed = structuredClone(review); mutate(changed);
    assert.throws(() => validateReview(changed, cutoff));
  }
});
