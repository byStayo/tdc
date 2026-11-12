import test from "node:test";
import assert from "node:assert/strict";
import { collectKibotPrices, parseKibotDaily } from "../lib/consensus/kibot.ts";

const sessions = ["2026-11-06", "2026-11-09"];
const csv = "11/06/2026,100,103,99,102,12345\r\n11/09/2026,102,104,101,103,23456\r\n";
test("the adjusted daily feed reconciles every expected completed session", () => {
  const rows = parseKibotDaily(csv, sessions);
  assert.deepEqual(rows.map(({ session, openAt, closeAt }) => [session, openAt, closeAt]), [
    ["2026-11-06", "2026-11-06T14:30:00.000Z", "2026-11-06T21:00:00.000Z"],
    ["2026-11-09", "2026-11-09T14:30:00.000Z", "2026-11-09T21:00:00.000Z"],
  ]);
  assert.equal(rows[0].open, 100);
  assert.equal(rows[1].close, 103);
  assert.throws(() => parseKibotDaily(csv.split("\r\n")[0], sessions), /session/);
  assert.throws(() => parseKibotDaily(csv + "11/10/2026,102,104,101,103,23456", sessions), /session/);
  assert.throws(() => parseKibotDaily(csv.replace(",103,99,", ",0,99,"), sessions), /bar/);
  assert.throws(() => parseKibotDaily("401 Not Logged In", sessions), /response/);
});

test("the guest collector requests all five ETFs only through the prior completed trading date", async () => {
  const seen: string[] = [];
  const result = await collectKibotPrices("2026-11-06", "2026-11-10T13:00:00.000Z", async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.kibot.com");
    assert.equal(init?.redirect, "error");
    assert.equal(url.searchParams.get("startdate"), "11/06/2026");
    assert.equal(url.searchParams.get("enddate"), "11/09/2026");
    assert.equal(url.searchParams.get("interval"), "daily");
    assert.equal(url.searchParams.get("unadjusted"), "0");
    seen.push(url.searchParams.get("symbol")!);
    return new Response(csv);
  });
  assert.deepEqual(seen.sort(), ["DIA", "IWM", "QQQ", "SPY", "TLT"]);
  assert.equal(result.through, "2026-11-09");
  for (const evidence of result.evidence) {
    assert.equal(evidence.adjustment, "total-return-adjusted");
    assert.equal(new URL(evidence.source).search, "");
    assert.deepEqual(evidence.expectedSessions, sessions);
  }
});
