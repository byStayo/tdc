import test from "node:test";
import assert from "node:assert/strict";
import { historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { hasReviewedCalendar } from "../lib/consensus/exchange-calendar.ts";
import { parseKibotDaily } from "../lib/consensus/kibot.ts";

test("keeps the exceptional market closure and early-close bounds in private research", () => {
  assert.equal(historicalResearchSession("2025-01-09"), null);
  assert.equal(historicalResearchSession("2022-06-20"), null);
  assert.equal(historicalResearchSession("2024-12-24")?.closeAt, "2024-12-24T18:00:00.000Z");
  assert.equal(historicalResearchSession("2025-11-28")?.closeAt, "2025-11-28T18:00:00.000Z");
  assert.equal(historicalResearchSession("2025-07-03")?.closeAt, "2025-07-03T17:00:00.000Z");
  assert.equal(historicalResearchSessions(2025).includes("2025-01-09"), false);
  assert.equal(hasReviewedCalendar("2025-11-28"), false);
});

test("isolates historical provider parsing from the default outcome calendar", () => {
  const bar = "11/28/2025,100,102,99,101,10000";
  assert.throws(() => parseKibotDaily(bar, ["2025-11-28"]), /no reviewed coverage/);
  const sessions = parseKibotDaily(bar, ["2025-11-28"], historicalResearchSession);
  assert.equal(sessions[0].closeAt, "2025-11-28T18:00:00.000Z");
  assert.throws(() => parseKibotDaily(bar.replace("11/28", "11/27"), ["2025-11-28"], historicalResearchSession), /outside an exchange session/);
});
