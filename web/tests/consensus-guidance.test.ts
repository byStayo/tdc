import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { attachReview, validateReview, type ReviewPacket } from "../lib/consensus/reviewed.ts";
import { guidanceBounds, guidanceRows } from "../lib/consensus/guidance.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import { editionTiming } from "../lib/consensus/edition-timing.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const cutoff = "2026-11-03T08:00:00.000Z";
const base: ReviewPacket = JSON.parse(await readFile(new URL("./fixtures/reviewed-developments-2026-11-03.json", import.meta.url), "utf8"));
function packet(): ReviewPacket {
  return {
    ...structuredClone(base), reviewedAt: "2026-11-03T07:59:00.000Z",
    sources: [...structuredClone(base.sources),
      { id: "msft-guidance", name: "Microsoft quarterly call", url: "https://www.microsoft.com/en-us/investor/events/fy-2027/earnings-fy-2027-q1", publishedAt: "2026-10-28", retrievedAt: "2026-11-03T07:58:00.000Z", sha256: "c".repeat(64) },
      { id: "nvda-guidance", name: "NVIDIA quarterly release filed with SEC", url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm", publishedAt: "2026-08-26", retrievedAt: "2026-11-03T07:58:00.000Z", sha256: "d".repeat(64) },
    ],
    guidance: [
      { ticker: "MSFT", sourceId: "msft-guidance", fiscalPeriod: "FY2027 Q2", revenue: { kind: "range", low: 96, high: 97.1 }, assumptions: "Company expectations denominated in US dollars." },
      { ticker: "NVDA", sourceId: "nvda-guidance", fiscalPeriod: "FY2027 Q3", revenue: { kind: "midpoint_tolerance", midpoint: 108, tolerancePercent: 2 }, assumptions: "No China data-center compute revenue assumed." },
    ],
    earningsSchedule: [{ ticker: "NVDA", sourceId: "nvda-guidance", fiscalPeriod: "FY2027 Q3", reportDate: "2026-11-17", releaseTiming: "date_only" }],
  };
}
function snapshot(review = packet()): Snapshot {
  // Schedule citations use an issuer announcement; the SEC exhibit is used only for guidance.
  review.earningsSchedule![0].sourceId = "nvidia-schedule";
  if (!review.sources.some((s) => s.id === "nvidia-schedule")) review.sources.push({
    id: "nvidia-schedule", name: "NVIDIA scheduled earnings announcement", url: "https://investor.nvidia.com/events-and-presentations", publishedAt: "2026-10-28", retrievedAt: "2026-11-03T07:58:00.000Z", sha256: "e".repeat(64),
  });
  return { schemaVersion: 1, id: "2026-11-03T08-00-00-000Z", issuedAt: cutoff, cutoff, origin: "prospective", engineVersion: "test-v1", signals: missingSignals(cutoff), catalysts: [], sourcesAttempted: 1, collectionErrors: [], review };
}

test("guidance arithmetic preserves company ranges and derives midpoint bounds without an actual result", () => {
  const saved = snapshot();
  validateReview(saved.review!, cutoff);
  const rows = guidanceRows(saved, "MARKET", cutoff);
  assert.deepEqual(guidanceBounds(rows[0]), { low: 96, high: 97.1 });
  assert.ok(Math.abs(rows[1].low - 105.84) < 1e-10);
  assert.ok(Math.abs(rows[1].high - 110.16) < 1e-10);
  assert.equal(rows[1].revenue.kind, "midpoint_tolerance");
  assert.equal(rows[1].source.publishedAt, "2026-08-26");
  assert.equal(rows[1].reviewDue, null);
  assert.equal(guidanceRows(saved, "IWM", cutoff).length, 0);
  assert.equal(guidanceRows(saved, "TLT", cutoff).length, 0);
});

test("invalid ranges, issuer mismatches and unverified provenance stop guidance publication", () => {
  for (const mutate of [
    (p: ReviewPacket) => { p.guidance![0].revenue = { kind: "range", low: 98, high: 97 }; },
    (p: ReviewPacket) => { p.guidance![0].revenue = { kind: "range", low: 0, high: 97 }; },
    (p: ReviewPacket) => { p.guidance![0].revenue = { kind: "midpoint_tolerance", midpoint: Number.MAX_VALUE, tolerancePercent: 50 }; },
    (p: ReviewPacket) => { p.guidance![0].revenue = { kind: "midpoint_tolerance", midpoint: Number.MIN_VALUE, tolerancePercent: 99 }; },
    (p: ReviewPacket) => { p.guidance![0].revenue = { kind: "midpoint_tolerance", midpoint: 108, tolerancePercent: 100 }; },
    (p: ReviewPacket) => { p.guidance![0].sourceId = "apple-release"; },
    (p: ReviewPacket) => { p.sources.find((s) => s.id === "nvda-guidance")!.url = "https://www.sec.gov/Archives/edgar/data/320193/000104581026000073/q2fy27pr.htm"; },
    (p: ReviewPacket) => { p.sources.find((s) => s.id === "nvda-guidance")!.publishedAt = "2026-11-04"; },
    (p: ReviewPacket) => { p.guidance!.push(structuredClone(p.guidance![0])); },
    (p: ReviewPacket) => { p.guidance![0].fiscalPeriod = "FY2027 Q5"; },
  ]) {
    const p = snapshot().review!; mutate(p);
    assert.throws(() => validateReview(p, cutoff));
  }
});

test("the latest source-check label includes saved guidance without changing provider timestamps", () => {
  const saved = snapshot();
  const before = JSON.stringify(saved.signals);
  assert.equal(editionTiming(saved, []).latestSourceCheck, "2026-11-03T07:58:00.000Z");
  assert.equal(JSON.stringify(saved.signals), before);
  saved.review!.sources.find((s) => s.id === "nvda-guidance")!.retrievedAt = "2026-11-04T00:00:00.000Z";
  assert.equal(editionTiming(saved, []).latestSourceCheck, "2026-11-03T07:58:00.000Z");
});

test("scheduled results trigger review on the New York date, not earlier UTC midnight", () => {
  const saved = snapshot();
  assert.equal(guidanceRows(saved, "QQQ", "2026-11-17T04:59:00.000Z")[1].reviewDue, null);
  assert.match(guidanceRows(saved, "QQQ", "2026-11-17T05:00:00.000Z")[1].reviewDue!, /scheduled results day/);
  assert.equal(guidanceRows(saved, "QQQ", saved.cutoff)[1].reviewDue, null);
});

test("source rechecks cannot refresh guidance age and a later reported quarter requires review", () => {
  const saved = snapshot();
  saved.review!.sources.find((s) => s.id === "msft-guidance")!.retrievedAt = "2027-03-01T00:00:00.000Z";
  assert.match(guidanceRows(saved, "SPY", "2027-03-01T00:00:00.000Z")[0].reviewDue!, /120 days/);
  saved.signals.push({ ...missingSignals(cutoff)[0], id: "earnings-MSFT", status: "available", source: { ...missingSignals(cutoff)[0].source, observedAt: "2026-12-31" }, metrics: [{ label: "Quarter revenue", value: 96.5, unit: "$bn", date: "2026-12-31" }] });
  assert.match(guidanceRows(saved, "SPY", "2027-02-01T00:00:00.000Z")[0].reviewDue!, /later reported quarter/);
});

test("new guidance changes the evidence digest without changing signal votes or enriching older editions", () => {
  const original = snapshot(); delete original.review;
  const before = JSON.stringify(original);
  const packetWith = snapshot().review!;
  const without = structuredClone(packetWith); delete without.guidance;
  const old = attachReview(original, without);
  const next = attachReview(original, packetWith);
  validateSnapshot(next);
  assert.deepEqual(next.signals, old.signals);
  assert.notEqual(observationDigest(next), observationDigest(old));
  assert.equal(guidanceRows(old, "MARKET", cutoff).length, 0);
  assert.equal(JSON.stringify(original), before);
  const checkOnly = structuredClone(packetWith);
  checkOnly.reviewedAt = cutoff;
  checkOnly.sources.forEach((s) => { s.retrievedAt = cutoff; });
  assert.equal(observationDigest(attachReview(original, checkOnly)), observationDigest(next));
});
