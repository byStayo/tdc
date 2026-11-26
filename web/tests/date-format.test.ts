import test from "node:test";
import assert from "node:assert/strict";
import { timestamp, dateLabel, localDateLabel } from "../lib/date-format.ts";

test("publication times render identically on servers and readers in different time zones", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      assert.equal(timestamp("2026-11-06T13:09:00Z"), "Nov 6, 8:09 AM EST", zone);
      assert.equal(localDateLabel("2026-11-07T01:00:00Z"), "Nov 6, 2026", zone);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("observation dates retain their calendar day and invalid dates remain unavailable", () => {
  assert.equal(timestamp("2026-11-06"), "Nov 6, 2026");
  assert.equal(dateLabel("2026-11-06"), "Nov 6, 2026");
  assert.equal(localDateLabel("2026-11-06"), "Nov 6, 2026");
  assert.equal(timestamp("not a date"), "Time unavailable");
  assert.equal(localDateLabel(null), "Date unavailable");
});
