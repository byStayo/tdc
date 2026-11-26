import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { strToU8, zipSync } from "fflate";
import { observationDigest } from "../lib/consensus/history.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { latestSessionRanges, loadDailySessionRanges, prepareFirstRateRanges, replayFirstRateRange } from "../lib/consensus/firstrate-ranges.ts";
import { RANGE_ATTRIBUTION, RANGE_POLICY, RANGE_POLICY_V2, RANGE_SOURCE, sessionRangeSource, validateSessionRanges,
  visibleSessionRanges, type MarketHistoryRanges, type SessionRange } from "../lib/consensus/regular-session-range.ts";

const fri = "2026-11-20", mon = "2026-11-23";
const cutoff = "2026-11-24T09:30:00.000Z";
const privateDir = ".consensus/private-firstrate", funds = ["SPY", "QQQ", "IWM", "DIA"] as const;
type Fund = typeof funds[number];
const docs = "Two weeks of split-adjusted sample data. Timestamps run from the start of the period. " +
  "Timezone is US Eastern Time. Times with zero volume are omitted. https://firstratedata.com/about/license";
const header = "timestamp,open,high,low,close,volume\n";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "firstrate-range-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
type Options = { omitMinute?: number; omitFive?: number; badFiveField?: number; duplicate?: boolean; docs?: string;
  capturedAt?: string; vintageAt?: string; actualDay?: string; receiptUrl?: string };
async function capture(root: string, fund: Fund, day: string, options: Options = {}) {
  const dated = options.actualDay ?? day;
  const stamp = (offset: number) => {
    const time = 570 + offset;
    return dated + " " + String(Math.floor(time / 60)).padStart(2, "0") + ":" + String(time % 60).padStart(2, "0") + ":00";
  };
  const minute: string[] = [], five: string[] = [];
  minute.push(stamp(-1) + ",500,600,410,550,999");
  for (let i = 0; i < 390; i++) {
    if (i !== options.omitMinute) minute.push(stamp(i) + ",100.50,110,90,105,10");
    if (i === 15 && options.duplicate) minute.push(minute.at(-1)!);
    if (i % 5 === 0 && i !== options.omitFive) {
      const fewer = options.omitMinute !== undefined && i <= options.omitMinute && options.omitMinute < i + 5;
      const values = [100.5, 110, 90, 105, fewer ? 40 : 50];
      if (i === 35 && options.badFiveField !== undefined) values[options.badFiveField] += 1;
      five.push(stamp(i) + "," + values.join(","));
    }
  }
  minute.push(stamp(390) + ",2,1400,1,1200,900");
  const body = zipSync({ "_readme_documentation.txt": strToU8(options.docs ?? docs),
    [fund + "_1day_sample.csv"]: strToU8(header + dated + ",100,999,1,93,9000\n"),
    [fund + "_1min_sample.csv"]: strToU8(header + minute.join("\n")),
    [fund + "_5min_sample.csv"]: strToU8(header + five.join("\n")) });
  const dir = join(root, privateDir, "captures", day);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "sample-" + fund);
  await writeFile(path + ".bin", body, { mode: 0o600 });
  const url = options.receiptUrl ?? "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_" + fund + ".zip";
  await writeFile(path + ".json", JSON.stringify({ url, sha256: createHash("sha256").update(body).digest("hex"),
    lastModified: new Date(options.vintageAt ?? day + "T22:00:00.000Z").toUTCString(),
    capturedAt: options.capturedAt ?? day + "T23:00:00.000Z" }), { mode: 0o600 });
  return path;
}
function hourly(fund: SessionRange["fund"], session: string, closeFifth: number): SessionRange {
  return { fund, session, closeFifth, observedAt: exchangeSession(session)!.closeAt,
    verifiedAt: session + "T23:30:00.000Z", receiptSha256: "b".repeat(64) };
}
function legacy(rows: SessionRange[]): MarketHistoryRanges {
  return { method: RANGE_POLICY, url: RANGE_SOURCE, attribution: RANGE_ATTRIBUTION, rows };
}

test("four complete native grids support private persistent reviews; generated output has only dated fifths and row sources", async t => {
  const root = await fixture(t);
  for (const f of funds) await capture(root, f, mon, f === "DIA" ? { omitMinute: 181 } : {});
  const approved = await prepareFirstRateRanges(root, () => cutoff);
  assert.deepEqual(approved.map(r => [r.session, r.verifiedBuckets, r.activeMinutes]),
    [[mon, 78, 390], [mon, 78, 390], [mon, 78, 390], [mon, 78, 389]]);
  const proof = join(root, privateDir, "regular-ranges-v1/DIA", mon + ".json");
  assert.equal((await stat(proof)).mode & 0o777, 0o600);
  const first = await readFile(proof);
  const loaded = await loadDailySessionRanges(root, cutoff);
  assert.equal(loaded?.method, RANGE_POLICY_V2);
  assert.deepEqual(loaded!.rows.map(r => [r.fund, r.closeFifth, r.verifiedAt]), funds.map(f => [f, 4, cutoff]));
  assert.ok(loaded!.rows.every(r => r.source === "firstrate" && r.observedAt === exchangeSession(mon)!.closeAt));
  assert.deepEqual(Object.keys(loaded!.rows[0]).sort(),
    ["closeFifth", "fund", "observedAt", "receiptSha256", "session", "source", "verifiedAt"]);
  assert.equal(await loadDailySessionRanges(root, "2026-11-24T09:29:59.999Z"), undefined);
  await prepareFirstRateRanges(root, () => "2026-11-24T12:00:00.000Z");
  assert.deepEqual(await readFile(proof), first);
  assert.equal(await loadDailySessionRanges(root, "2026-11-28T21:00:00.001Z"), undefined);
  await assert.rejects(stat(join(root, privateDir, "approved.json")), { code: "ENOENT" });
});

test("each native OHLCV field, reviewed minute clock and every five-minute bucket must agree", async t => {
  const root = await fixture(t);
  for (const options of [
    ...[0, 1, 2, 3, 4].map(badFiveField => ({ badFiveField })),
    { omitMinute: 0 }, { omitMinute: 389 }, { omitFive: 30 }, { duplicate: true },
    { actualDay: fri }, { docs: docs.replace("Times with zero volume are omitted.", "") },
    { vintageAt: mon + "T20:59:59.000Z" }, { capturedAt: "2026-11-25T00:00:00.000Z" },
    { receiptUrl: "https://example.org/unlicensed.zip" },
  ]) {
    await capture(root, "QQQ", mon, options);
    await assert.rejects(replayFirstRateRange(root, "QQQ", mon, cutoff));
  }
  const path = await capture(root, "SPY", mon);
  await chmod(path + ".bin", 0o644);
  await assert.rejects(replayFirstRateRange(root, "SPY", mon, cutoff));
  await assert.rejects(replayFirstRateRange(root, "DIA", "2026-11-27", "2026-11-28T12:00:00.000Z"), /ordinary/);
  await assert.rejects(replayFirstRateRange(root, "IWM", "2026-11-26", "2026-11-28T12:00:00.000Z"), /ordinary/);
});

test("a corrupt Monday receipt falls back independently to Friday without refreshing Friday's clock", async t => {
  const root = await fixture(t);
  await capture(root, "SPY", fri);
  await capture(root, "DIA", fri);
  const earlier = "2026-11-20T23:40:00.000Z";
  await prepareFirstRateRanges(root, () => earlier);
  const changed = await capture(root, "SPY", mon);
  await capture(root, "DIA", mon, { badFiveField: 4 });
  const report = await prepareFirstRateRanges(root, () => cutoff);
  assert.equal(report[3].session, fri);
  assert.equal(report[3].failures.length, 1);
  assert.deepEqual((await loadDailySessionRanges(root, cutoff))!.rows.map(r => [r.fund, r.session]), [["SPY", mon], ["DIA", fri]]);
  await writeFile(changed + ".bin", "changed original");
  const warnings: string[] = [];
  assert.deepEqual((await loadDailySessionRanges(root, cutoff, message => warnings.push(message)))!.rows.map(r =>
    [r.fund, r.session, r.verifiedAt]), [["SPY", fri, earlier], ["DIA", fri, earlier]]);
  assert.ok(warnings.some(w => w.includes("SPY") && w.includes(mon)));
});

test("mixed attribution follows actual per-fund dates, hourly tie conflicts retain the original independently approved reading", async t => {
  const root = await fixture(t);
  for (const fund of funds) await capture(root, fund, mon);
  await prepareFirstRateRanges(root, () => cutoff);
  const fundRows = (await loadDailySessionRanges(root, cutoff))!.rows;
  const market = legacy([hourly("SPY", fri, 2), hourly("QQQ", mon, 1), hourly("TLT", fri, 5)]);
  const warnings: string[] = [];
  const mixed = latestSessionRanges(market, fundRows, cutoff, m => warnings.push(m))!;
  assert.deepEqual(mixed.rows.map(r => [r.fund, r.session, r.source, r.closeFifth]), [
    ["SPY", mon, "firstrate", 4], ["QQQ", mon, "market-history", 1], ["IWM", mon, "firstrate", 4],
    ["DIA", mon, "firstrate", 4], ["TLT", fri, "market-history", 5],
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(sessionRangeSource(mixed.rows[0]).url, "https://firstratedata.com/i/etf/SPY");
  assert.equal(sessionRangeSource(mixed.rows.at(-1)!).url, RANGE_SOURCE);
  assert.equal(latestSessionRanges(market, [], cutoff), market);
  assert.equal(visibleSessionRanges(mixed, "MARKET", "weekly", cutoff).length, 0);
  assert.equal(visibleSessionRanges(mixed, "TLT", "daily", "2026-11-25T21:00:00.001Z").length, 0);
  const falseTlt = { ...mixed, rows: [{ ...mixed.rows.at(-1)!, source: "firstrate" as const }] };
  assert.throws(() => validateSessionRanges(falseTlt, cutoff));
  const leaked = { ...mixed, rows: [{ ...mixed.rows[0], openingPrice: 100 }] };
  assert.throws(() => validateSessionRanges(leaked, cutoff));
});


test("v1 fingerprints stay stable; a changed v2 source or method is material and a new receipt clock alone is not", () => {
  const row = hourly("SPY", mon, 4);
  const original = { engineVersion: "fixture", signals: [], catalysts: [], regularSessionRanges: legacy([row]) } as unknown as Snapshot;
  assert.equal(observationDigest(original), "11108720165fe57b75f6222d06e554c9cb63e828574a16de1a7a946312845ada");
  const sourceDigest = (source: "firstrate" | "market-history", extra: Partial<SessionRange> = {}) =>
    observationDigest({ ...original, regularSessionRanges: { method: RANGE_POLICY_V2, rows: [{ ...row, source, ...extra }] } });
  assert.notEqual(observationDigest(original), sourceDigest("market-history"));
  assert.notEqual(sourceDigest("market-history"), sourceDigest("firstrate"));
  assert.equal(sourceDigest("firstrate"), sourceDigest("firstrate", { receiptSha256: "c".repeat(64), verifiedAt: cutoff }));
});
