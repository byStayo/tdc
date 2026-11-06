import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyReviewedEarnings, attachReview, validateReview, type ReviewPacket } from "../lib/consensus/reviewed.ts";
import { guidanceRows } from "../lib/consensus/guidance.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { applyScoringPolicy } from "../lib/consensus/scoring-policy.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import { INSTRUMENTS, type Snapshot } from "../lib/consensus/types.ts";

const cutoff = "2026-11-04T22:00:00.000Z";
const review: ReviewPacket = JSON.parse(await readFile(new URL("./fixtures/qualcomm-reviewed-2026-11-04.json", import.meta.url), "utf8"));
function snapshot(): Snapshot {
  return { schemaVersion: 1, id: "2026-11-04T22-00-00-000Z", issuedAt: cutoff, cutoff, origin: "prospective", engineVersion: "test-v1", signals: missingSignals(cutoff), catalysts: [], sourcesAttempted: 0, collectionErrors: [] };
}

test("the expanded reviewed issuer sample preserves Qualcomm GAAP values, negative prior EPS and exact PDF provenance", () => {
  assert.equal(review.earnings.length, 4);
  assert.equal(review.guidance!.length, 4);
  const next = applyScoringPolicy(attachReview(snapshot(), review));
  validateSnapshot(next);
  const qcom = next.signals.find((s) => s.id === "earnings-QCOM")!;
  assert.deepEqual(qcom.instruments, ["MARKET", "SPY", "QQQ"]);
  assert.deepEqual(qcom.series, [{ date: "2025-09-28", value: 11.270 }, { date: "2026-09-27", value: 10.322 }]);
  assert.equal(qcom.metrics.find((m) => m.label === "GAAP diluted EPS")!.value, 1.17);
  assert.equal(qcom.metrics.find((m) => m.label === "Prior-year GAAP diluted EPS")!.value, -2.89);
  assert.ok(Math.abs(qcom.metrics[1].value - (-8.411712511091393)) < 1e-10);
  assert.equal(qcom.source.observedAt, "2026-09-27");
  assert.equal(qcom.source.releasedAt, "2026-11-04");
  assert.equal(qcom.source.sha256, "6aa674a7f42a75aae351ccce55ae33ac2da34774827fdec43297f9ae6e12c4c6");
  assert.deepEqual(qcom.scores, { daily: null, weekly: null, monthly: null });
  assert.match(qcom.summary, /8\.4% below/);
  assert.doesNotMatch(qcom.summary, /above/);
  const development = next.signals.find((s) => s.id === "review-qualcomm-quarter")!;
  assert.deepEqual(development.instruments, ["MARKET", "SPY", "QQQ"]);
  assert.deepEqual(development.scores, { daily: null, weekly: null, monthly: null });
});

test("Qualcomm guidance remains a separate company range and is absent from unrelated instrument views", () => {
  const next = applyScoringPolicy(attachReview(snapshot(), review));
  for (const instrument of INSTRUMENTS) {
    const row = guidanceRows(next, instrument, cutoff).find((r) => r.ticker === "QCOM");
    assert.equal(Boolean(row), ["MARKET", "SPY", "QQQ"].includes(instrument), instrument);
    if (!row) continue;
    assert.equal(row.low, 10.4);
    assert.equal(row.high, 11.2);
    assert.equal(row.fiscalPeriod, "FY2027 Q1");
    assert.equal(row.source.publishedAt, "2026-11-04");
    assert.equal(row.reviewDue, null);
  }
});

test("the completed Qualcomm result schedule is removed only from the new edition and full recollection retains its facts", () => {
  const before = structuredClone(review);
  before.developments = before.developments.filter((d) => d.id !== "qualcomm-quarter");
  before.earnings = before.earnings.filter((e) => e.ticker !== "QCOM");
  before.guidance = before.guidance!.filter((g) => g.ticker !== "QCOM");
  before.earningsSchedule!.push({ ticker: "QCOM", sourceId: "qualcomm-schedule", fiscalPeriod: "FY2026 Q4", reportDate: "2026-11-04", releaseTiming: "after_close", webcastAt: "2026-11-04T21:45:00.000Z" });
  const old = applyScoringPolicy(attachReview(snapshot(), before)), encoded = JSON.stringify(old);
  const next = applyScoringPolicy(attachReview(old, review));
  assert.ok(old.catalysts.some((c) => c.id.startsWith("issuer-earnings-qcom")));
  assert.equal(next.catalysts.some((c) => c.id.startsWith("issuer-earnings-qcom")), false);
  assert.equal(next.signals.some((s) => s.id === "issuer-calendar-qcom"), false);
  assert.equal(old.signals.some((s) => s.id === "earnings-QCOM"), false);
  assert.equal(JSON.stringify(old), encoded);
  const recollected = applyScoringPolicy(attachReview(snapshot(), review));
  assert.equal(recollected.signals.filter((s) => s.id === "earnings-QCOM").length, 1);
  assert.equal(observationDigest(recollected), observationDigest(next));
  const rechecked = structuredClone(review);
  rechecked.reviewedAt = cutoff;
  rechecked.sources.forEach((s) => { s.retrievedAt = cutoff; });
  assert.equal(observationDigest(applyScoringPolicy(attachReview(snapshot(), rechecked))), observationDigest(next));
});

test("expanding issuer capacity still rejects duplicate facts, wrong issuer sources and conflicting same-quarter results", () => {
  for (const mutate of [
    (p: ReviewPacket) => { p.earnings.push(structuredClone(p.earnings.at(-1)!)); },
    (p: ReviewPacket) => { p.guidance!.push(structuredClone(p.guidance!.at(-1)!)); },
    (p: ReviewPacket) => { p.earnings.at(-1)!.sourceId = "amd-fy26-q3-release"; },
    (p: ReviewPacket) => { p.guidance!.at(-1)!.sourceId = "amd-fy26-q3-release"; },
    (p: ReviewPacket) => { p.sources.find((s) => s.id === "qualcomm-fy26-q4-release")!.publishedAt = "2026-11-05"; },
  ]) {
    const changed = structuredClone(review); mutate(changed);
    assert.throws(() => validateReview(changed, cutoff));
  }
  const qcom = applyReviewedEarnings([], review, cutoff).find((s) => s.id === "earnings-QCOM")!;
  qcom.metrics[0].value = 10.442; // Non-GAAP revenue must not silently replace GAAP.
  assert.throws(() => applyReviewedEarnings([qcom], review, cutoff), /Conflicting/);
});

test("flat company revenue is described as unchanged without inventing a positive or negative change", () => {
  const flat = structuredClone(review);
  flat.earnings.at(-1)!.revenueBillions = flat.earnings.at(-1)!.priorRevenueBillions;
  const qcom = applyReviewedEarnings([], flat, cutoff).find((s) => s.id === "earnings-QCOM")!;
  assert.match(qcom.summary, /unchanged from the comparable/);
  assert.doesNotMatch(qcom.summary, /above|below/);
});
