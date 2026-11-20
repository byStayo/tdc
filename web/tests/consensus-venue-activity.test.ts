import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { validateVenueActivity, type VenueActivity } from "../lib/consensus/venue-activity.ts";
import type { ReviewedSource } from "../lib/consensus/reviewed.ts";

// Synthetic tests use EDGAR document identities and no FINRA weekly observations.
const sources: ReviewedSource[] = [
  { id: "nasdaq-fixture", name: "Nasdaq test filing", url: "https://www.sec.gov/Archives/edgar/data/1120193/000112019326000020/ndaq-20260930.htm", publishedAt: "2026-10-22", retrievedAt: "2026-11-03T12:00:00.000Z", sha256: "a".repeat(64) },
  { id: "cboe-fixture", name: "Cboe test filing", url: "https://www.sec.gov/Archives/edgar/data/1374310/000162828026068432/cboe-20261030xex991.htm", publishedAt: "2026-10-30", retrievedAt: "2026-11-03T12:00:00.000Z", sha256: "b".repeat(64) },
];
const activity: VenueActivity = {
  periodEnd: "2026-09-30", priorPeriodEnd: "2025-09-30",
  nasdaqTrfShare: { sourceId: "nasdaq-fixture", current: 35, previous: 34 },
  bidsTouchedMillions: { sourceId: "cboe-fixture", current: 180, previous: 0 },
};

test("quarterly venue measures require comparable periods, their own SEC filing and the correct units", () => {
  assert.doesNotThrow(() => validateVenueActivity(activity, sources));
  for (const changed of [
    { ...activity, priorPeriodEnd: "2026-06-30" },
    { ...activity, periodEnd: "2026-09-29", priorPeriodEnd: "2025-09-29" },
    { ...activity, nasdaqTrfShare: { ...activity.nasdaqTrfShare, sourceId: "cboe-fixture" } },
    { ...activity, nasdaqTrfShare: { ...activity.nasdaqTrfShare, current: 101 } },
    { ...activity, bidsTouchedMillions: { ...activity.bidsTouchedMillions, previous: -1 } },
    { ...activity, bidsTouchedMillions: { ...activity.bidsTouchedMillions, current: NaN } },
    { ...activity, weeklyRows: [] },
  ]) assert.throws(() => validateVenueActivity(changed, sources));
  assert.throws(() => validateVenueActivity(activity, [{ ...sources[0], url: sources[0].url.replace("20260930.htm", "20260630.htm") }, sources[1]]));
  assert.throws(() => validateVenueActivity(activity, [sources[0], { ...sources[1], publishedAt: "2026-08-31" }]));
  assert.throws(() => validateVenueActivity(activity, [sources[0], { ...sources[1], url: sources[1].url.replace("20261030", "20260731") }]));
});

test("venue facts change the edition digest while a later check of the same facts does not", () => {
  const previous: Snapshot = JSON.parse(readFileSync(new URL("../public/consensus/2026-11-05T14-28-10-883Z.json", import.meta.url), "utf8"));
  assert.equal(previous.review?.venueActivity, undefined);
  const candidate = structuredClone(previous);
  candidate.review!.sources.push(...sources);
  candidate.review!.venueActivity = structuredClone(activity);
  validateSnapshot(candidate);
  const first = observationDigest(candidate);
  assert.notEqual(first, observationDigest(previous));
  candidate.review!.sources.at(-1)!.retrievedAt = "2026-11-04T12:00:00.000Z";
  assert.equal(observationDigest(candidate), first);
  candidate.review!.venueActivity!.nasdaqTrfShare.current = 36;
  assert.notEqual(observationDigest(candidate), first);
  assert.deepEqual(candidate.consensus, previous.consensus);
});

test("Nasdaq filing dates must fall within the reporting window for the stated quarter", () => {
  for (const publishedAt of ["2026-09-29", "2027-01-15"]) {
    assert.throws(
      () => validateVenueActivity(activity, [{ ...sources[0], publishedAt }, sources[1]]),
      /outside the quarter's reporting window/,
    );
  }
});
