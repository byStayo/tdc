import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishSnapshot, verifyPublicationTree } from "../lib/consensus/history.ts";
import { MARKETPARQUET_AGGREGATE_FILE, MARKETPARQUET_SOURCE, validateMarketParquetAggregate } from "../lib/consensus/marketparquet-aggregate.ts";
import { FAMILIES, missingSignals } from "../lib/consensus/registry.ts";
import { HORIZONS, INSTRUMENTS, type Snapshot } from "../lib/consensus/types.ts";

function edition(hour: number): Snapshot {
  const at = `2026-11-03T${hour}:00:00.000Z`;
  const signal = missingSignals(at)[0];
  return {
    schemaVersion: 1, origin: "prospective", engineVersion: "consensus-rules-1.1.0",
    id: at.replaceAll(/[:.]/g, "-"), issuedAt: at, cutoff: at,
    signals: [{ ...signal, status: "available", series: [{ date: "2026-11-02", value: hour }],
      scores: { daily: .2, weekly: .1, monthly: -.1 },
      source: { ...signal.source, observedAt: "2026-11-02", sha256: "a".repeat(64) } }],
    catalysts: [], sourcesAttempted: 1, collectionErrors: [],
  };
}
const aggregate = (id: string) => ({
  schemaVersion: 1, source: MARKETPARQUET_SOURCE, engineVersion: "consensus-rules-2.0.0", edition: id,
  through: "2026-11-10", scoringPolicy: "last-edition-before-entry-open-v1", minimumTestLabels: 100,
  missingCompletedSessions: 0, multiSessionReviewedThrough: "2026-11-10",
  cohorts: INSTRUMENTS.filter(symbol => symbol !== "MARKET").flatMap(instrument => HORIZONS.map(horizon => ({
    instrument, horizon, resolved: 5, calls: 0, abstentions: 5, minimumSamples: 500,
    eligibility: "insufficient_data", holdout: null as null | Record<string, unknown>,
  }))),
  families: FAMILIES.map(({ id: family }) => ({ family, pairedVotes: 0, pairedObservations: 5 })),
});

test("accepts cohort and family totals and a gated holdout summary", () => {
  const report = aggregate("e1");
  report.cohorts[0].holdout = { testLabels: 100, candidateBrier: .24, baseRateBrier: .25, coinBrier: .25, passed: false };
  validateMarketParquetAggregate(report, ["e1"]);
});

test("rejects price rows, single-outcome returns, features and weights in the public aggregate", () => {
  const cases: ((report: ReturnType<typeof aggregate>) => unknown)[] = [
    report => ({ ...report, outcomes: [{ entry: 500, exit: 501, returnPct: .2 }] }),
    report => ({ ...report, bars: [{ session: "2026-11-10", open: 500, close: 501 }] }),
    report => { Object.assign(report.cohorts[0], { returnPct: .2 }); return report; },
    report => { Object.assign(report.cohorts[0], { features: [[.1, .2]] }); return report; },
    report => { report.cohorts[0].holdout = { testLabels: 100, candidateBrier: .24, baseRateBrier: .25, coinBrier: .25, passed: true, weights: [.3] }; return report; },
    report => { report.cohorts[0].holdout = { testLabels: 99, candidateBrier: .24, baseRateBrier: .25, coinBrier: .25, passed: true }; return report; },
    report => { Object.assign(report.families[0], { scores: [.5] }); return report; },
    report => ({ ...report, edition: "unissued" }),
    report => ({ ...report, source: "https://example.com/prices" }),
  ];
  for (const change of cases)
    assert.throws(() => validateMarketParquetAggregate(change(aggregate("e1")), ["e1"]), /reviewed schema/);
});

test("a staged aggregate passes the build guard, survives the next edition and fails closed when altered", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-aggregate-"));
  try {
    const first = edition(11);
    await publishSnapshot(root, first);
    const path = join(root, "public/consensus", MARKETPARQUET_AGGREGATE_FILE);
    const bytes = JSON.stringify(aggregate(first.id), null, 2) + "\n";
    await writeFile(path, bytes);
    await verifyPublicationTree(root);
    await publishSnapshot(root, edition(12));
    assert.equal(await readFile(path, "utf8"), bytes);
    await verifyPublicationTree(root);
    await writeFile(path, JSON.stringify({ ...aggregate(first.id), outcomes: [{ entry: 1, exit: 2 }] }));
    await assert.rejects(verifyPublicationTree(root), /reviewed schema/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
