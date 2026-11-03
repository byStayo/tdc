import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  attachReview,
  applyReviewedEarnings,
  validateReview,
  reviewedSignals,
  type ReviewPacket,
} from "../lib/consensus/reviewed.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import {
  validateSnapshot,
  observationDigest,
} from "../lib/consensus/history.ts";
import { effectiveStatus } from "../lib/consensus/engine.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const packet: ReviewPacket = JSON.parse(
  await readFile(
    new URL("./fixtures/reviewed-developments-2026-11-03.json", import.meta.url),
    "utf8",
  ),
);
const cutoff = "2026-11-03T08:00:00.000Z";
const earnings = (): Signal => ({
  ...missingSignals(cutoff)[0],
  id: "earnings-AAPL",
  family: "earnings",
  title: "Apple reported revenue",
  instruments: ["MARKET", "SPY", "QQQ", "DIA"],
  unit: "$bn",
  staleAfterDays: 150,
  source: { ...missingSignals(cutoff)[0].source, observedAt: "2026-06-27" },
});
const snapshot = (): Snapshot => ({
  schemaVersion: 1,
  id: "2026-11-03T08-00-00-000Z",
  issuedAt: cutoff,
  cutoff,
  origin: "prospective",
  engineVersion: "test-v1",
  signals: [earnings(), ...missingSignals(cutoff)],
  catalysts: [],
  sourcesAttempted: 1,
  collectionErrors: [],
});

test("reviewed facts retain primary provenance, instrument scope and no directional news vote", () => {
  const result = attachReview(snapshot(), packet);
  validateSnapshot(result);
  const signals = result.signals.filter((s) => s.id.startsWith("review-"));
  assert.equal(signals.length, 3);
  assert.equal(signals.filter((s) => s.instruments.includes("IWM")).length, 1);
  assert.equal(signals.filter((s) => s.instruments.includes("QQQ")).length, 3);
  assert.ok(
    signals.every((s) =>
      Object.values(s.scores).every((score) => score === null),
    ),
  );
  assert.equal(
    signals[0].source.url,
    packet.sources.find((s) => s.id === packet.developments[0].sourceIds[0])!
      .url,
  );
  assert.equal(
    result.signals.some((s) => s.id === "global-news"),
    false,
  );
});

test("newer company release replaces an older quarter with exactly comparable quarter facts", () => {
  const result = applyReviewedEarnings([earnings()], packet, cutoff)[0];
  assert.equal(result.status, "available");
  assert.equal(result.source.observedAt, "2026-09-26");
  assert.equal(result.source.releasedAt, "2026-11-02");
  assert.equal(
    result.source.sha256,
    packet.sources.find((s) => s.id === "apple-statements")!.sha256,
  );
  assert.deepEqual(result.series, [
    { date: "2025-09-27", value: 102.466 },
    { date: "2026-09-26", value: 114.477 },
  ]);
  assert.equal(
    result.metrics.find((m) => m.label === "GAAP diluted EPS")!.value,
    2.1,
  );
  assert.ok(Math.abs(result.metrics[1].value - 11.721937032771846) < 0.000001);
});

test("same-quarter conflict stops publication, while a later official quarter supersedes the saved review", () => {
  const same = earnings();
  same.source.observedAt = "2026-09-26";
  same.metrics = [
    { label: "Quarter revenue", value: 115, unit: "$bn", date: "2026-09-26" },
  ];
  assert.throws(
    () => applyReviewedEarnings([same], packet, cutoff),
    /Conflicting/,
  );
  same.metrics[0].value = 114.477;
  assert.doesNotThrow(() => applyReviewedEarnings([same], packet, cutoff));
  const later = structuredClone(same);
  later.source.observedAt = "2026-12-26";
  assert.deepEqual(
    applyReviewedEarnings([later], packet, "2027-02-01T00:00:00.000Z")[0],
    later,
  );
});

test("stale reviews remain dated context and cannot fill fresh coverage for another instrument", () => {
  const prior = snapshot();
  prior.cutoff = prior.issuedAt = "2026-11-07T08:00:00.000Z";
  prior.id = "2026-11-07T08-00-00-000Z";
  const result = attachReview(prior, packet);
  validateSnapshot(result);
  const missing = result.signals.find((s) => s.id === "global-news")!;
  assert.deepEqual(missing.instruments, ["IWM", "TLT"]);
  const fed = result.signals.find(
    (s) => s.id === "review-fed-october-decision",
  )!;
  assert.equal(effectiveStatus(fed, prior.cutoff), "stale");
  assert.equal(fed.source.observedAt, "2026-10-28T18:00:00.000Z");
});

test("review validation rejects future or mismatched sources and altered saved interpretations", () => {
  const future = structuredClone(packet);
  future.sources[0].publishedAt = "2026-11-04";
  assert.throws(() => validateReview(future, cutoff));
  const wrong = structuredClone(packet);
  wrong.earnings[0].sourceId = "fed-october";
  assert.throws(() => validateReview(wrong, cutoff));
  const mismatch = attachReview(snapshot(), packet);
  mismatch.signals.find((s) => s.id.startsWith("review-"))!.summary =
    "An unsupported and altered fact.";
  assert.throws(() => validateSnapshot(mismatch), /disagree/);
  const unknown = structuredClone(packet);
  unknown.developments[0].sourceIds = ["unknown-source"];
  assert.throws(() => validateReview(unknown, cutoff));
  const unsupported = structuredClone(packet);
  unsupported.sources[0].url = "https://unknown.example/news";
  assert.throws(() => validateReview(unsupported, cutoff));
});

test("rechecking the same facts does not manufacture an edition, and attachment leaves prior history untouched", () => {
  const prior = snapshot(),
    before = JSON.stringify(prior);
  const initial = attachReview(prior, packet);
  assert.equal(JSON.stringify(prior), before);
  const rechecked = structuredClone(packet);
  rechecked.reviewedAt = "2026-11-03T07:50:00.000Z";
  rechecked.sources.forEach((source) => {
    source.retrievedAt = "2026-11-03T07:49:00.000Z";
  });
  assert.equal(
    observationDigest(attachReview(snapshot(), rechecked)),
    observationDigest(initial),
  );
  rechecked.developments[0].impacts[0].interpretation =
    "A changed editorial interpretation should be a new saved edition.";
  assert.notEqual(
    observationDigest(attachReview(snapshot(), rechecked)),
    observationDigest(initial),
  );
  assert.equal(
    reviewedSignals(packet, cutoff)[0].source.retrievedAt,
    packet.sources[1].retrievedAt,
  );
});
