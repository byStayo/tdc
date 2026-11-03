import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  attachReview,
  validateReview,
  reviewedEarningsCalendar,
  type ReviewPacket,
} from "../lib/consensus/reviewed.ts";
import {
  validateSnapshot,
  observationDigest,
} from "../lib/consensus/history.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const cutoff = "2026-11-03T12:00:00.000Z";
const base: ReviewPacket = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/reviewed-developments-2026-11-03.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function packet(): ReviewPacket {
  const p = structuredClone(base);
  p.reviewedAt = "2026-11-03T08:00:00.000Z";
  p.sources.push(
    {
      id: "test-amd-schedule",
      name: "AMD schedule fixture",
      url: "https://ir.amd.com/news-events/press-releases/detail/1300/amd-to-report-fiscal-third-quarter-2026-financial-results",
      publishedAt: "2026-10-06",
      retrievedAt: "2026-11-03T08:00:00.000Z",
      sha256: "b".repeat(64),
    },
    {
      id: "test-nvidia-schedule",
      name: "NVIDIA schedule fixture",
      url: "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Sets-Conference-Call-for-Third-Quarter-Financial-Results/default.aspx",
      publishedAt: "2026-10-28",
      retrievedAt: "2026-11-03T08:00:00.000Z",
      sha256: "c".repeat(64),
      format: "retrieved_text",
    },
  );
  p.earningsSchedule = [
    {
      ticker: "AMD",
      sourceId: "test-amd-schedule",
      fiscalPeriod: "FY2026 Q3",
      reportDate: "2026-11-03",
      releaseTiming: "after_close",
      webcastAt: "2026-11-03T22:00:00.000Z",
    },
    {
      ticker: "NVDA",
      sourceId: "test-nvidia-schedule",
      fiscalPeriod: "FY2027 Q3",
      reportDate: "2026-11-17",
      releaseTiming: "approximate",
      approximateReleaseAt: "2026-11-17T21:20:00.000Z",
      webcastAt: "2026-11-17T22:00:00.000Z",
    },
  ];
  return p;
}
const snapshot = (): Snapshot => ({
  schemaVersion: 1,
  id: "2026-11-03T12-00-00-000Z",
  issuedAt: cutoff,
  cutoff,
  engineVersion: "test-v1",
  origin: "prospective",
  signals: missingSignals(cutoff),
  catalysts: [],
  sourcesAttempted: 1,
  collectionErrors: [],
});
test("issuer events keep result windows and approximate release times distinct from calls", () => {
  const r = reviewedEarningsCalendar(packet(), cutoff);
  assert.equal(r.catalysts.length, 2);
  assert.equal(r.catalysts[0].at, "2026-11-03");
  assert.match(r.catalysts[0].title, /after US close · call 5:00 PM ET/);
  assert.match(r.catalysts[1].title, /about 4:20 PM ET · call 5:00 PM ET/);
  assert.ok(r.catalysts.every((e) => e.at.length === 10));
  assert.ok(
    r.signals.every(
      (s) =>
        s.series.length === 0 &&
        Object.values(s.scores).every((v) => v === null),
    ),
  );
  assert.equal(r.signals[0].source.releasedAt, "2026-10-06");
  assert.equal(r.signals[0].source.observedAt, "2026-11-03T08:00:00.000Z");
  assert.match(r.signals[1].source.usage, /text extract/);
});
test("issuer events reject wrong company sources, duplicate issuers and invalid timing contracts", () => {
  for (const mutation of [
    (p: ReviewPacket) => {
      p.earningsSchedule![0].sourceId = "test-nvidia-schedule";
    },
    (p: ReviewPacket) => {
      p.earningsSchedule!.push(p.earningsSchedule![0]);
    },
    (p: ReviewPacket) => {
      p.earningsSchedule![1].approximateReleaseAt = undefined;
    },
    (p: ReviewPacket) => {
      p.earningsSchedule![0].approximateReleaseAt = "2026-11-03T21:00:00.000Z";
    },
    (p: ReviewPacket) => {
      p.earningsSchedule![1].webcastAt = "2026-11-17T20:00:00.000Z";
    },
    (p: ReviewPacket) => {
      p.earningsSchedule![0].webcastAt = "2026-11-04T22:00:00.000Z";
    },
    (p: ReviewPacket) => {
      p.earningsSchedule![0].reportDate = "2026-11-31";
    },
    (p: ReviewPacket) => {
      p.earningsSchedule![0].reportDate = "2026-09-30";
    },
    (p: ReviewPacket) => {
      p.sources.at(-1)!.format = "fabricated" as never;
    },
  ]) {
    const p = packet();
    mutation(p);
    assert.throws(() => validateReview(p, cutoff));
  }
});
test("expired and withdrawn issuer events are removed without rewriting their earlier edition", () => {
  const original = attachReview(snapshot(), packet());
  validateSnapshot(original);
  const serialized = JSON.stringify(original);
  const later = {
    ...original,
    id: "2026-11-04T12-00-00-000Z",
    cutoff: "2026-11-04T12:00:00.000Z",
    issuedAt: "2026-11-04T12:00:00.000Z",
  };
  const result = attachReview(later, packet());
  validateSnapshot(result);
  assert.equal(result.catalysts.length, 1);
  assert.match(result.catalysts[0].id, /nvda/);
  const p = packet();
  p.earningsSchedule = [];
  const withdrawn = attachReview(later, p);
  validateSnapshot(withdrawn);
  assert.equal(withdrawn.catalysts.length, 0);
  assert.ok(
    !withdrawn.signals.some((s) => s.id.startsWith("issuer-calendar-")),
  );
  assert.equal(JSON.stringify(original), serialized);
});
test("saved issuer events and their evidence cannot be altered independently", () => {
  const original = attachReview(snapshot(), packet());
  const changed = structuredClone(original);
  changed.catalysts[0].title = "Different release time";
  assert.throws(() => validateSnapshot(changed), /issuer calendar/);
  const orphan = structuredClone(original);
  orphan.review = undefined;
  assert.throws(() => validateSnapshot(orphan), /require their saved evidence/);
  const missing = structuredClone(original);
  missing.signals = missing.signals.filter(
    (s) => !s.id.startsWith("issuer-calendar-"),
  );
  assert.throws(() => validateSnapshot(missing), /issuer calendar/);
});
test("checking the same schedule again does not create a new factual edition", () => {
  const p = packet(),
    original = attachReview(snapshot(), p);
  p.reviewedAt = "2026-11-03T10:00:00.000Z";
  p.sources
    .filter((s) => s.id.startsWith("test-"))
    .forEach((s) => {
      s.retrievedAt = "2026-11-03T09:00:00.000Z";
      s.sha256 = "d".repeat(64);
    });
  assert.equal(
    observationDigest(original),
    observationDigest(attachReview(snapshot(), p)),
  );
  p.earningsSchedule![0].webcastAt = "2026-11-03T22:30:00.000Z";
  assert.notEqual(
    observationDigest(original),
    observationDigest(attachReview(snapshot(), p)),
  );
});
