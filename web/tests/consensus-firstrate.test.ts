import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import {
  firstRateCaptureDates, firstRatePriceEvidence, FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS, latestFirstRateSession, reconcileFirstRateRows,
} from "../lib/consensus/firstrate.ts";

const price = (day: string, open: number, close: number) => ({ ...exchangeSession(day)!, open, close });

test("FirstRate can review a completed core session immediately and never uses the open session", () => {
  for (const [now, expected] of [
    ["2026-11-19T13:00:00.000Z", "2026-11-18"],
    ["2026-11-19T20:59:59.999Z", "2026-11-18"],
    ["2026-11-19T21:00:00.000Z", "2026-11-19"],
    ["2026-11-20T03:00:00.000Z", "2026-11-19"],
    ["2026-11-26T22:30:00.000Z", "2026-11-25"],
    ["2026-11-27T17:59:59.999Z", "2026-11-25"],
    ["2026-11-27T18:00:00.000Z", "2026-11-27"],
    ["2026-11-29T22:30:00.000Z", "2026-11-27"],
    ["2026-07-02T20:00:00.000Z", "2026-07-02"],
  ]) assert.equal(latestFirstRateSession(now), expected, now);
  assert.throws(() => latestFirstRateSession("2026-01-01T22:00:00.000Z"), /No reviewed/);
  assert.throws(() => latestFirstRateSession("2027-11-29T14:00:00.000Z"), /no reviewed coverage/);
  assert.equal(latestFirstRateSession("2027-11-29T22:00:00.000Z"), "2027-11-29");
});

test("a post-close refresh gives a lagging fund a bounded opportunity to catch up", () => {
  const afterClose = "2026-11-19T21:01:00.000Z";
  assert.deepEqual(firstRateCaptureDates(afterClose, ["2026-11-18", "2026-11-17"]), ["2026-11-18", "2026-11-19"]);
  assert.deepEqual(firstRateCaptureDates(afterClose, ["2026-11-19", "2026-11-17"]), ["2026-11-18", "2026-11-19"]);
  assert.deepEqual(firstRateCaptureDates(afterClose, ["2026-11-18", "2026-11-19"]), ["2026-11-19"]);
  assert.deepEqual(firstRateCaptureDates("2026-11-19T13:00:00.000Z", ["2026-11-17"]), ["2026-11-18"]);
  assert.deepEqual(firstRateCaptureDates("2027-11-29T22:00:00.000Z", ["2027-11-24"]), ["2027-11-29"]);
  assert.deepEqual(firstRateCaptureDates("2027-11-30T22:00:00.000Z", ["2027-11-24"]), ["2027-11-29", "2027-11-30"]);
});

test("a stale evening price file does not pin issuer evidence for tomorrow's retry", () => {
  const code = `
import contextlib, importlib.util, io, json, pathlib, sys, tempfile
from unittest.mock import patch
scripts = pathlib.Path("scripts").resolve()
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("first_rate_inputs", scripts/"collect-firstrate-inputs.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def stale(folder, name, *args):
    assert name.startswith("sample-"), "issuer captured before any finalized file"
    raise ValueError("sample still ends on previous date")
with tempfile.TemporaryDirectory() as tmp, patch.object(module, "ROOT", pathlib.Path(tmp)), patch.object(module, "capture", stale):
    sys.argv = ["collect", "2026-11-19", "--independent-samples"]
    with contextlib.redirect_stdout(io.StringIO()) as output:
        assert module.main() == 0
    result = json.loads(output.getvalue())
    assert result["issuers"] == [] and len(result["sampleFailures"]) == 4
`;
  execFileSync("python3", ["-B", "-c", code]);
});

test("FirstRate withholds a directional disagreement and a short session while keeping verified full dates", () => {
  const raw = [price("2026-11-25", 100, 99.99), price("2026-11-27", 100, 101), price("2026-11-30", 100, 102)];
  const candidate = [{ ...raw[0], close: 100 }, raw[1], raw[2]];
  const result = reconcileFirstRateRows("DIA", candidate, raw, raw);
  assert.deepEqual(result.rows, [raw[2]]);
  assert.deepEqual(result.withheld, [
    { session: "2026-11-25", reason: "direction" },
    { session: "2026-11-27", reason: "short-session" },
  ]);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [raw[0]]), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [candidate[0]]).rows, [candidate[0], raw[2]]);
  assert.throws(() => reconcileFirstRateRows("DIA", candidate, raw, [price("2026-11-25", 50, 50), ...raw.slice(1)]), /split-basis/);

  const listing = [price("2026-11-25", 100.02, 99.99)];
  const minutes = raw.map(row => ({ ...row, minutes: 390 }));
  const repaired = reconcileFirstRateRows("DIA", candidate, raw, raw, listing, minutes);
  assert.deepEqual(repaired.rows, [raw[0], raw[2]]);
  assert.deepEqual(repaired.regularMinuteSessions, [raw[0].session]);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [], minutes), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, listing,
    [{ ...price("2026-11-25", 100, 99.98), minutes: 390 }, ...minutes.slice(1)]), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [price("2026-11-25", 100.01, 100.01)], minutes), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [price("2026-11-25", 100.05, 99.99)], minutes), result);

  const shortListing = [price("2026-11-27", 100, 101.05)];
  const shortMinutes = [{ ...raw[1], minutes: 210 }];
  const short = reconcileFirstRateRows("DIA", candidate, raw, raw, shortListing, shortMinutes);
  assert.deepEqual(short.rows, [raw[1], raw[2]]);
  assert.deepEqual(short.regularMinuteSessions, ["2026-11-27"]);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, shortListing, minutes), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [], shortMinutes), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [price("2026-11-27", 100, 101.26)], shortMinutes), result);
});

test("FirstRate cash adjustment uses the prior regular close and preserves missing calendar dates", () => {
  const rows = [
    price("2026-11-23", 100, 100),
    price("2026-11-24", 99, 100),
    price("2026-11-30", 105, 106),
  ];
  const capturedAt = "2026-12-01T12:00:00.000Z";
  const approval: Parameters<typeof firstRatePriceEvidence>[0] = {
    schemaVersion: 1,
    source: FIRST_RATE_SOURCE,
    from: "2026-11-23",
    through: "2026-11-30",
    approvedAt: capturedAt,
    issuers: ([...FIRST_RATE_SYMBOLS, "TLT"] as const).map(symbol => ({
      symbol, source: "https://example.test/issuer", sha256: "a".repeat(64), capturedAt,
      cash: [{ session: "2026-11-24", amount: 1 }],
    })),
    symbols: FIRST_RATE_SYMBOLS.map(symbol => ({
      symbol,
      rows,
      withheld: [{ session: "2026-11-27", reason: "short-session" }],
      proof: { source: { symbol, url: FIRST_RATE_SOURCE, capturedAt, modifiedAt: capturedAt,
        sha256: "a".repeat(64), basis: "split-adjusted" }, comparison: [], splitComparison: [], listingReferences: [] },
    })),
  };
  const [result] = firstRatePriceEvidence(approval);
  assert.equal(result.adjustment, "total-return-adjusted");
  assert.deepEqual(result.expectedSessions, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30"]);
  assert.deepEqual(result.sessions, [{ ...rows[0], open: 99, close: 99 }, rows[1], rows[2]]);

  const [spy, qqq] = approval.symbols;
  const retained = { ...qqq, reviewedThrough: "2026-11-24", rows: rows.slice(0, 2) };
  const partial = firstRatePriceEvidence({ ...approval, symbols: [spy, retained] });
  assert.deepEqual(partial.map(row => row.instrument), ["SPY", "QQQ"]);
  assert.deepEqual(partial[1].expectedSessions, partial[0].expectedSessions);
  assert.deepEqual(partial[1].sessions.map(row => row.session), ["2026-11-23", "2026-11-24"]);
  assert.throws(() => firstRatePriceEvidence({ ...approval, symbols: [spy, { ...retained, rows }] }),
    /invalid sessions for QQQ/);

  const shortDay = "2026-11-27";
  const early = { ...spy, rows: [...rows.slice(0, 2), price(shortDay, 104, 106), rows[2]],
    proof: { ...spy.proof, minuteRepairs: [{ session: shortDay, captureSession: "2026-11-30", minutes: 210,
      source: { ...spy.proof.source, url: "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_SPY.zip" },
      rawSha256: "b".repeat(64), splitSha256: "c".repeat(64),
      listing: { session: shortDay, source: "https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.20261127.csv",
        sha256: "d".repeat(64) } }] } };
  const [earlyEvidence] = firstRatePriceEvidence({ ...approval, symbols: [early] });
  assert.deepEqual(earlyEvidence.sessions.find(row => row.session === shortDay), price(shortDay, 104, 106));
  assert.throws(() => firstRatePriceEvidence({ ...approval, symbols: [{ ...early, proof: spy.proof }] }),
    /invalid sessions for SPY/);
});
