import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { comparePloverTlt, decodePlover, ploverSource, type TltResearchControls } from "../lib/consensus/plover-price-research.ts";

const from = "2026-10-30", through = "2026-11-03", capturedAt = "2026-11-05T02:00:00.000Z";
const all = ["2026-10-30", "2026-11-02", "2026-11-03"];
const bars = all.map(date => ({ date, open: 80, close: 81, low: 79, high: 82, volume: 1000, adjusted_close: 555 }));
const format = { symbol: "TLT", start: from, end: through, count: bars.length, bars,
  provenance: { trust: "official", url: "https://databento.com/equities",
    credit: "Source: Databento (EQUS.SUMMARY, EQUS.MINI, XNAS.ITCH, XNYS.PILLAR). Market data provided by Databento.",
    note: "EQUS.SUMMARY from 1 July 2024; bars are as delivered; one-day delay." } };
function capture(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { source: ploverSource("TLT", from, through), capturedAt, sha256: createHash("sha256").update(bytes).digest("hex"), body: bytes.toString("base64") };
}
const pair = (d: string) => ({ session: d, open: 80, close: 81, sha256: "1".repeat(64) });
const controls: TltResearchControls = { scope: "private-source-qualification", from, through, issuer: "2".repeat(64),
  distributions: [{ session: "2026-11-02", amount: 0.34 }], review: all.map(day => ({ day, issuerCovered: true,
    raw: pair(day), split: pair(day), listed: pair(day) })) };

test("replays native raw prices with their source identity and the full delay across daylight-saving time", () => {
  const rec = capture(format);
  const decoded = decodePlover(rec, "TLT", from, through, capturedAt);
  assert.equal(decoded[0].close, 81);
  assert.throws(() => decodePlover({ ...rec, capturedAt: "2026-11-05T01:14:59.999Z" }, "TLT", from, through, capturedAt), /delay/);
  assert.throws(() => decodePlover({ ...rec, sha256: "a".repeat(64) }, "TLT", from, through, capturedAt), /receipt/);
  assert.throws(() => decodePlover(capture({ ...format, symbol: "QQQ" }), "TLT", from, through, capturedAt), /identity/);
  assert.throws(() => decodePlover(capture({ ...format, provenance: { ...format.provenance, note: "new venue" } }), "TLT", from, through, capturedAt), /provenance/);
  assert.throws(() => decodePlover(capture({ ...format, bars: [bars[0], bars[0], bars[2]] }), "TLT", from, through, capturedAt), /dated/);
});

test("isolates independently checked windows, ex-date prior closes, and uncorroborated splits", () => {
  const review = comparePloverTlt(bars, controls, from, through);
  assert.equal(review.scope, "private-price-comparison");
  assert.deepEqual(review.cashCheckedWindows, [{ from, through, sessions: 3, exDates: ["2026-11-02"] }]);
  assert.deepEqual(comparePloverTlt(bars.slice(1), controls, from, through).cashCheckedWindows,
    [{ from: through, through, sessions: 1, exDates: [] }]);
  const differentSplit = structuredClone(controls);
  differentSplit.review[1].split!.open = 40;
  assert.equal(comparePloverTlt(bars, differentSplit, from, through).days[1].status, "split_basis");
  assert.throws(() => comparePloverTlt(bars, { ...controls, through: from }, from, through), /matching/);
});

test("requires the exact exchange auction pair on an early close", () => {
  const day = "2025-11-28", row = { ...bars[0], date: day };
  const refs: TltResearchControls = { ...controls, from: day, through: day, distributions: [],
    review: [{ day, issuerCovered: true, raw: pair(day), split: pair(day), listed: pair(day) }] };
  assert.equal(comparePloverTlt([row], refs, day, day).days[0].status, "short_session_auction_missing");
  refs.review[0].auction = { ...pair(day), open: 80.01 };
  assert.equal(comparePloverTlt([row], refs, day, day).days[0].status, "short_session_auction_difference");
  refs.review[0].auction = pair(day);
  assert.equal(comparePloverTlt([row], refs, day, day).cashCheckedWindows[0].sessions, 1);
});
