import assert from "node:assert/strict";
import test from "node:test";
import { parseSentiSenseEod } from "../lib/consensus/sentisense-eod.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const dates = ["2026-10-30", "2026-11-02"];
const today = "2026-11-03";
function bar(day: string) {
  return { timestamp: Date.parse(newYorkTimestamp(day.replaceAll("-", "") + "T000000")!),
    date: "a misleading display date", open: 100, high: 102, low: 99, close: 101,
    volume: 1000, session: null, adjusted: true };
}

test("SentiSense chart uses New York dates across DST and drops the current date before parsing prices", () => {
  const current = { timestamp: bar(today).timestamp, date: "current partial placeholder" };
  const parsed = parseSentiSenseEod([...dates.map(bar), current], dates, today);
  assert.deepEqual(parsed.bars, dates.map(session => ({ session, open: 100, close: 101 })));
  assert.equal(parsed.ignoredToday, true);
});

test("SentiSense chart rejects duplicate, skipped, future, stale and inconsistent bar evidence", () => {
  const [first, second] = dates.map(bar);
  for (const sample of [
    [first], [first, first, second], [first, second, bar("2026-11-04")],
    [first, { ...second, timestamp: second.timestamp / 1000 }],
    [first, { ...second, timestamp: second.timestamp + 3_600_000 }],
    [first, { ...second, close: 103 }],
    [first, { ...second, adjusted: false }],
    [first, bar("2026-11-01"), second],
  ]) assert.throws(() => parseSentiSenseEod(sample, dates, today), /SentiSense/);
});
