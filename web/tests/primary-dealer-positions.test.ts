import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectPrimaryDealerPositions, dealerPositionReading, validatePrimaryDealerPositions } from "../lib/consensus/primary-dealer-positions.ts";

const key = "PDPOSGSC-G21";
const days = ["2026-11-04", "2026-11-11"];
const history = JSON.stringify({ pd: { timeseries: days.map((asofdate, i) =>
  ({ asofdate, keyid: key, value: String([42026, 42227][i]) })) } });
const csv = '"As Of Date","Time Series","Value (millions)"\n"2026-11-11","PDPOSGSC-G21","42227"\n"2026-11-11","PDPOSGSC-G21C","201"\n';
const at = "2026-11-24T05:25:00.000Z";
const bytes = (text: string, retrievedAt: string) => ({ text, sha256: createHash("sha256").update(text).digest("hex"), retrievedAt });

test("checks the signed 21-year position against both the weekly report and the preceding level", () => {
  const found = dealerPositionReading(history, csv, at);
  assert.deepEqual(found, [{ date: days[0], value: 42026 }, { date: days[1], value: 42227 }]);
  for (const changed of [csv.replace(',"201"', ',"200"'), csv.replace("millions", "billions"),
    csv.replace("G21C", "G21"), csv.replace(days[1], days[0]), csv.replace("42227", "*")]) {
    assert.throws(() => dealerPositionReading(history, changed, at));
  }
  assert.throws(() => dealerPositionReading(history.replace(days[0], "2026-10-21"), csv, at));
  assert.throws(() => dealerPositionReading(history.replace("42026", "42026.5"), csv, at));
  assert.throws(() => dealerPositionReading(history, csv, "2026-11-10T20:00:00.000Z"));
});

test("the first completed capture persists and a source disagreement withholds the observation", async () => {
  const folder = await mkdtemp(join(tmpdir(), "consensus-dealer-"));
  try {
    let current = at;
    const read = async (url: string) => bytes(url.endsWith(".csv") ? csv : history, current);
    const first = await collectPrimaryDealerPositions(read, folder, () => current);
    assert.equal(first.status, "available");
    assert.equal(first.source.vintageAt, at);
    assert.equal(first.source.releasedAt, null);
    assert.equal(first.metrics[0].value, 201);
    assert.deepEqual(first.instruments, ["MARKET", "TLT"]);
    assert.throws(() => validatePrimaryDealerPositions({ ...first, scores: { ...first.scores, daily: 1 } }, current));
    assert.throws(() => validatePrimaryDealerPositions({ ...first, metrics: [{ ...first.metrics[0], value: -201 }] }, current));
    current = "2026-11-24T06:10:00.000Z";
    const repeated = await collectPrimaryDealerPositions(read, folder, () => current);
    assert.equal(repeated.source.vintageAt, at);
    assert.equal(repeated.source.retrievedAt, current);
    const changed = await collectPrimaryDealerPositions(async url =>
      bytes(url.endsWith(".csv") ? csv.replace(',"201"', ',"202"') : history, current), folder, () => current);
    assert.equal(changed.status, "unavailable");
    assert.deepEqual(changed.series, []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
