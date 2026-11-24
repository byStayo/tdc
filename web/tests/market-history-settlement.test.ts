import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { ETF_CASH_SOURCES } from "../lib/consensus/corporate-adjustment.ts";
import { evaluateOutcome } from "../lib/consensus/evaluation.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { nasdaqDaily } from "../lib/consensus/kibot-session-witnesses.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { tltHourSource } from "../lib/consensus/market-history-hourly-access.ts";
import { contiguousTltWindows } from "../lib/consensus/market-history-boundaries.ts";
import { MARKET_HISTORY_SOURCE, recordTltSettlement, tltSettlementPriceEvidence, type TltSettlementReview } from "../lib/consensus/market-history-settlement.ts";
import { defaultEvaluationPrices } from "../lib/consensus/marketparquet-settlement.ts";
import { outcomeIndex } from "../lib/consensus/outcome-ledger.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const days = ["2026-10-30", "2026-11-02"], asOf = "2026-11-03T03:00:00.000Z";
const sha = (input: string) => createHash("sha256").update(input).digest("hex");
async function fixture(root: string, sessions = days, retrieved = "2026-11-03T02:00:00.000Z") {
  const dir = join(root, ".consensus/private-market-history/tlt-settlement"), witnesses = join(root, ".consensus/private-kibot/sources");
  const from = sessions[0], through = sessions.at(-1)!;
  const curve = sessions.map((_, i) => i === 0 ? { open: 100, close: 100.5 } : { open: 99.8, close: 100.3 });
  const controls: TltSettlementReview["controls"] = [];
  for (const [i, day] of sessions.entries()) {
    const us = day.slice(5, 7) + "/" + day.slice(8) + "/" + day.slice(0, 4), { open, close } = curve[i];
    const csv = [us, open, 102, 98, close, 500].join(",") + "\n", common = { first: day, through: day, symbol: "TLT",
      source: KIBOT_PRICE_CITATION, capturedAt: retrieved, sha256: sha(csv), csv };
    await durableJSON(join(witnesses, day, "TLT-kibot.json"), { ...common, unadjusted: true });
    await durableJSON(join(dir, "controls", day, "TLT-splits.json"), { ...common, unadjusted: false, splitAdjusted: true });
    const text = JSON.stringify({ status: { rCode: 200 }, data: { symbol: "TLT", tradesTable: {
      headers: { date: "Date", open: "Open", close: "Close/Last", high: "High", low: "Low" },
      rows: [{ date: us, open: String(open), close: String(close), high: "102", low: "98" }] } } });
    await durableJSON(join(witnesses, day, "TLT-daily.json"), { url: nasdaqDaily("TLT", day, day), kind: "daily", status: 200,
      symbol: "TLT", requestedAt: retrieved, capturedAt: retrieved, body: Buffer.from(text).toString("base64"), sha256: sha(text) });
    controls.push({ session: day, raw: { kind: "kibot", sha256: common.sha256, capturedAt: retrieved },
      split: { kind: "qualification", sha256: common.sha256, capturedAt: retrieved },
      listed: { kind: "kibot", sha256: sha(text), capturedAt: retrieved } });
  }
  const issuerText = JSON.stringify(Object.fromEntries([["exDate", [20260901, 20261102]], ["totalDistribution", [0.4, 0.343177]]]
    .map(([name, value]) => [name, { name, fullName: "performance.distributions.table." + name, value }])));
  const issuerFolder = join(witnesses, through, "issuer-post-close/TLT");
  await durableJSON(join(issuerFolder, "issuer-TLT.json"), { url: ETF_CASH_SOURCES.TLT, capturedAt: retrieved, sha256: sha(issuerText) });
  await writeFile(join(issuerFolder, "issuer-TLT.bin"), issuerText, { mode: 0o600 });
  async function hourly(grid: "exchange" | "Asia/Kolkata") {
    const text = sessions.map((day, i) => {
      const clock = exchangeSession(day)!;
      const timestamp = grid === "exchange" ? new Date(Date.parse(clock.closeAt) - 3_600_000).toISOString() : clock.openAt;
      return JSON.stringify({ timestamp, symbol: "TLT", symbol_id: 11418, ...curve[i], high: 102, low: 98,
        volume: 500, vwap: 100, trade_count: 10, is_gap: false, gap_fill_method: 0 });
    }).join("\n") + "\n";
    const page = { source: tltHourSource(from, through, grid), status: 200, text, sha256: sha(text),
      headers: { date: new Date(retrieved).toUTCString(), "content-type": "application/x-ndjson", "x-row-count": String(sessions.length),
        "x-feed": "consolidated", "x-bars-charged": "100", "x-bars-remaining": "20000", "x-bars-paid-remaining": "0",
        "x-data-through": through + "T22:30:00Z", "x-session": grid === "exchange" ? "exchange America/New_York 00:00" : "Asia/Kolkata 00:00" } };
    const id = digest(page); await durableJSON(join(dir, id + ".json"), page); return id;
  }
  const review: TltSettlementReview = { schema: 1, from, through, windowFrom: from, windowThrough: through, opening: await hourly("Asia/Kolkata"),
    closing: await hourly("exchange"), issuer: { kind: "kibot", session: through, sha256: sha(issuerText), capturedAt: retrieved }, controls };
  return { dir, review };
}

test("qualified dated originals feed the normal evaluator after replay and only derived identities leave the ledger", async t => {
  const root = await mkdtemp(join(tmpdir(), "tlt-settlement-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { review } = await fixture(root), warnings: string[] = [];
  assert.deepEqual(await defaultEvaluationPrices(root, asOf, message => warnings.push(message)), []);
  const staged = await recordTltSettlement(root, review, asOf);
  assert.deepEqual(await defaultEvaluationPrices(root, "2026-11-03T02:59:59.000Z", message => warnings.push(message)), []);
  const [evidence] = await defaultEvaluationPrices(root, asOf, message => warnings.push(message));
  assert.deepEqual(evidence, staged);
  assert.equal(evidence.instrument, "TLT");
  assert.equal(evidence.source, MARKET_HISTORY_SOURCE);
  assert.ok(Math.abs(evidence.sessions[0].open - 100 * (100.5 - 0.343177) / 100.5) < 1e-10);
  const archive: Snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-03T08-48-02-469Z.json", import.meta.url), "utf8"));
  const snapshot = { ...archive, issuedAt: "2026-10-30T12:00:00.000Z" };
  const outcome = evaluateOutcome(snapshot, evidence, "daily", asOf)!;
  assert.equal(outcome.source, MARKET_HISTORY_SOURCE);
  assert.ok(Math.abs(outcome.returnPct - 0.5) < 1e-8);
  assert.equal(evaluateOutcome(snapshot, evidence, "weekly", asOf), null);
  assert.deepEqual(Object.keys(outcomeIndex([outcome])[0]).sort(), ["engineVersion", "horizon", "instrument", "snapshotId"]);
  assert.deepEqual(warnings, []);
});

test("incomplete, mixed, stale, anonymous or changed source originals cannot enter settlement", async t => {
  const root = await mkdtemp(join(tmpdir(), "tlt-rejected-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { dir, review } = await fixture(root);
  await assert.rejects(recordTltSettlement(root, { ...review, controls: review.controls.slice(1) }, asOf), /every dated/);
  await assert.rejects(recordTltSettlement(root, { ...review, closing: review.opening }, asOf), /Invalid/);
  await assert.rejects(recordTltSettlement(root, { ...review, windowFrom: days[1], controls: review.controls.slice(1) }, asOf), /preceding session/);
  const mixed = structuredClone(review); mixed.controls[0].split = mixed.controls[0].raw;
  await assert.rejects(recordTltSettlement(root, mixed, asOf), /share-basis/);
  const recast = structuredClone(review); recast.controls[0].listed.capturedAt = asOf;
  await assert.rejects(recordTltSettlement(root, recast, asOf), /historical response/);
  await assert.rejects(tltSettlementPriceEvidence(root, review, "2026-11-02T21:01:00.000Z"));
  const original = JSON.parse(await readFile(join(dir, review.opening + ".json"), "utf8"));
  delete original.headers["x-bars-paid-remaining"];
  const altered = digest(original); await durableJSON(join(dir, altered + ".json"), original);
  await assert.rejects(recordTltSettlement(root, { ...review, opening: altered }, asOf), /free-only/);
  await recordTltSettlement(root, review, asOf);
  await rm(join(dir, "controls", days[1], "TLT-splits.json"));
  const warnings: string[] = [];
  assert.deepEqual(await defaultEvaluationPrices(root, asOf, msg => warnings.push(msg)), []);
  assert.equal(warnings.length, 1);
});

test("November's unproven early-close auction withholds the short day and crossing weekly target; both flanking windows settle", async t => {
  const root = await mkdtemp(join(tmpdir(), "tlt-short-session-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dates = exchangeSessions("2026-11-23", "2026-12-02"), asOf = "2026-12-03T04:00:00.000Z";
  const { review } = await fixture(root, dates, "2026-12-03T02:00:00.000Z");
  await assert.rejects(recordTltSettlement(root, review, asOf), /short_session_auction_missing/);
  const rows = dates.map(day => ({ day, raw: { close: 100 }, boundary: { close: 100 },
    status: day === "2026-11-27" ? "short_session_auction_missing" : "matched" }));
  const windows = contiguousTltWindows(rows, []);
  assert.deepEqual(windows.map(w => [w[0].day, w.at(-1)!.day]), [["2026-11-23", "2026-11-25"], ["2026-11-30", "2026-12-02"]]);
  for (const window of windows) {
    const windowFrom = window[0].day, windowThrough = window.at(-1)!.day;
    await recordTltSettlement(root, { ...review, windowFrom, windowThrough,
      controls: review.controls.filter(row => row.session >= windowFrom && row.session <= windowThrough) }, asOf);
  }
  const sources = await defaultEvaluationPrices(root, asOf);
  assert.equal(sources.length, 2);
  const snapshot: Snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-03T08-48-02-469Z.json", import.meta.url), "utf8"));
  const hasOutcome = (day: string, horizon: "daily" | "weekly") => sources.some(p =>
    !!evaluateOutcome({ ...snapshot, issuedAt: day + "T12:00:00.000Z" }, p, horizon, asOf));
  assert.equal(hasOutcome("2026-11-25", "daily"), true);
  assert.equal(hasOutcome("2026-11-27", "daily"), false);
  assert.equal(hasOutcome("2026-11-30", "daily"), true);
  assert.equal(hasOutcome("2026-11-23", "weekly"), false);
  const afterExDate = contiguousTltWindows(rows, [{ session: "2026-11-30", amount: 0.5 }]);
  assert.equal(afterExDate[1][0].day, "2026-12-01");
});
