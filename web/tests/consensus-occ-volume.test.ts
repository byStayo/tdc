import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  collectOccVolume, occCapturePrecedesOutcome, OCC_VOLUME_SYMBOLS,
  parseOccCustomerVolume, previousOccSession, validateOccVolumeCapture,
} from "../lib/consensus/occ-volume.ts";

const date = "2026-11-17";
const morning = "2026-11-18T12:55:00.000Z";
const header = "quantity,underlying,symbol,actype,porc,exchange,actdate";
const csv = (symbol: string) =>
  header + "\r\n" +
  `100,${symbol},${symbol},C,C,CBOE,11/17/2026,\r\n` +
  `140,${symbol},${symbol},C,P,BATS,11/17/2026,\r\n` +
  `5,${symbol},1${symbol},C,P,CBOE,11/17/2026\r\n`;
const report: typeof fetch = async (input) => {
  const symbol = new URL(String(input)).searchParams.get("symbol")!;
  return new Response(csv(symbol));
};

test("OCC capture uses only the last prior date from the reviewed New York session calendar", () => {
  assert.equal(previousOccSession(morning), date);
  assert.equal(previousOccSession("2026-11-18T23:00:00.000Z"), date);
  assert.equal(previousOccSession("2026-11-27T13:00:00.000Z"), "2026-11-25");
  assert.equal(previousOccSession("2026-11-30T13:00:00.000Z"), "2026-11-27");
  assert.equal(previousOccSession("2027-01-04T13:00:00.000Z"), "2026-12-31");
  assert.throws(() => previousOccSession("2027-11-26T13:00:00.000Z"), /reviewed exchange calendar/);
});

test("OCC volume parser checks report scope, rejects sparse responses and counts distinct customer rows", () => {
  assert.deepEqual(parseOccCustomerVolume(csv("SPY"), "SPY", date),
    { rows: 3, customerCalls: 100, customerPuts: 145 });
  for (const [bad, message] of [
    [csv("QQQ"), /wrong ETF/],
    [csv("SPY").replaceAll("11/17/2026", "11/16/2026"), /wrong ETF, date/],
    [csv("SPY").replaceAll(",C,P,", ",M,P,"), /wrong ETF, date, account/],
    [csv("SPY").replace(",11/17/2026,\r\n", ",11/17/2026,11/20/2026\r\n"), /all-expiries/],
    [csv("SPY").replace("140,SPY,SPY,C,P,BATS", "140,SPY,SPY,C,C,CBOE"), /Duplicate/],
    [csv("SPY").replace(",C,P,", ",C,C,").replace(",C,P,", ",C,C,"), /lacks complete positive/],
    [header + "\n100,SPY,SPY,C,C,CBOE,11/17/2026,", /lacks complete positive/],
    ["Report date cannot be greater than 11/16/2026", /unexpected CSV header/],
  ] as const) assert.throws(() => parseOccCustomerVolume(bad, "SPY", date), message);
});

test("OCC collector requires five complete reports and records exact-byte hashes and retrieval times", async () => {
  const requests: string[] = [];
  const checkRequest: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const symbol = url.searchParams.get("symbol")!;
    assert.equal(url.host, "marketdata.theocc.com");
    assert.equal(url.pathname, "/volume-query");
    assert.equal(url.searchParams.get("reportDate"), "20261117");
    assert.equal(url.searchParams.get("reportType"), "D");
    assert.equal(url.searchParams.get("accountType"), "C");
    assert.equal(url.searchParams.has("contractDt"), false);
    assert.equal(init?.redirect, "error");
    requests.push(symbol);
    return report(input, init);
  };
  const capture = await collectOccVolume(date, checkRequest, () => morning);
  assert.deepEqual(requests, OCC_VOLUME_SYMBOLS);
  assert.equal(capture.capturedAt, morning);
  assert.deepEqual(capture.reports.map(item => item.sha256),
    OCC_VOLUME_SYMBOLS.map(symbol => createHash("sha256").update(csv(symbol)).digest("hex")));
  assert.throws(
    () => validateOccVolumeCapture({ ...capture, reports: capture.reports.slice(0, 4) }, date),
    /Invalid OCC research capture/,
  );
  const partial: typeof fetch = async (input, init) =>
    new URL(String(input)).searchParams.get("symbol") === "TLT"
      ? new Response(null, { status: 502 })
      : report(input, init);
  await assert.rejects(collectOccVolume(date, partial, () => morning), /TLT.*HTTP 502/);
  await assert.rejects(collectOccVolume(date, async () => new Response("A".repeat(65_537)), () => morning),
    /exceeded the size limit/);
  await assert.rejects(collectOccVolume("2026-11-18", report, () => morning), /immediately preceding/);
});

test("private OCC research pairs require the exact previous session and a capture at or before the edition cutoff", async () => {
  const capture = await collectOccVolume(date, report, () => morning);
  const entryAt = "2026-11-18T14:30:00.000Z";
  assert.equal(occCapturePrecedesOutcome(capture, "2026-11-18T13:00:00.000Z", entryAt), true);
  assert.equal(occCapturePrecedesOutcome(capture, "2026-11-18T12:54:59.999Z", entryAt), false);
  assert.equal(occCapturePrecedesOutcome(capture, entryAt, entryAt), false);
  assert.equal(occCapturePrecedesOutcome(capture, "2026-11-19T13:00:00.000Z", "2026-11-19T14:30:00.000Z"), false);
});
