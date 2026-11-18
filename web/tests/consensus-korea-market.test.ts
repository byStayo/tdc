import assert from "node:assert/strict";
import test from "node:test";
import { historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { ecbUsdFixes, koreaFeatures, koreaTrainingPairs, type KoreaBulletin } from "../scripts/research-korea-market.ts";

const sessions = [...historicalResearchSessions(2024), ...historicalResearchSessions(2025)];
function bulletin(id: string, observationDate: string, postingDate = observationDate): KoreaBulletin {
  return { id, postingDate, observationDate, source: "https://mofe.go.kr/example",
    sha256: "a".repeat(64), kospi: { prior: 100, close: 101 }, kosdaq: { prior: 100, close: 103 } };
}

test("Korean observation dates and posting dates lead to the first full eligible New York session", () => {
  const features = koreaFeatures([
    bulletin("friday", "2024-01-19"),
    bulletin("short", "2024-07-02"),
    bulletin("late", "2025-12-10", "2025-12-11"),
  ], sessions);
  assert.deepEqual([...features.keys()], ["2024-01-22", "2024-07-05", "2025-12-12"]);
  assert.equal(features.get("2024-01-22")?.issuedAt, "2024-01-22T13:00:00.000Z");
  assert.equal(features.get("2024-07-05")?.availableAt, "2024-07-02T15:00:00.000Z");
  assert.equal(features.get("2024-07-05")?.issuedAt, "2024-07-05T12:00:00.000Z");
  assert.equal(features.get("2025-12-12")?.observationDate, "2025-12-10");
});

test("a later reprint does not revise past features and linked observations are used once", () => {
  const first = bulletin("first", "2024-01-19");
  const revised = { ...first, id: "revision", postingDate: "2024-01-22", kosdaq: { prior: 100, close: 104 } };
  const nextCutoff = koreaFeatures([revised, first], sessions);
  assert.deepEqual([...nextCutoff.keys()], ["2024-01-22"]);
  assert.equal(nextCutoff.get("2024-01-22")?.id, first.id);
  assert.equal(koreaFeatures([first, { ...revised, postingDate: first.postingDate }], sessions).size, 0);
  const laterObservation = bulletin("later", "2024-07-03");
  assert.equal(koreaFeatures([bulletin("earlier", "2024-07-02"), laterObservation], sessions).get("2024-07-05")?.id, laterObservation.id);
});

test("IWM benchmark admits only prior ECB fixes and the exact paired outcome session", () => {
  const feature = koreaFeatures([bulletin("evidence", "2024-01-19")], sessions);
  const fixes = ecbUsdFixes("KEY,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n" + ["2024-01-18,1.10", "2024-01-19,1.11", "2024-01-22,1.77"]
    .map(row => `EXR.D.USD.EUR.SP00.A,${row},A`).join("\n"));
  const unrelated = { ...historicalResearchSession("2024-01-23")!, open: 100, close: 99 };
  assert.deepEqual(koreaTrainingPairs(feature, [unrelated], fixes, "2026-11-03T00:00:00.000Z"), []);
  const matched = { ...historicalResearchSession("2024-01-22")!, open: 100, close: 101 };
  const [pair] = koreaTrainingPairs(feature, [matched, unrelated], fixes, "2026-11-03T00:00:00.000Z");
  assert.deepEqual(pair.fxDates, ["2024-01-18", "2024-01-19"]);
  assert.equal(pair.training.labelKnownAt, matched.closeAt);
  assert.equal(pair.training.up, 1);
  assert.equal(pair.training.features[0], 10_000 * Math.log(1.11 / 1.1));
  assert.equal(pair.training.features[1], 10_000 * (Math.log(1.03) - Math.log(1.01)));
});
