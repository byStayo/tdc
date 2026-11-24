import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { collectBlsPayrollNews } from "../lib/consensus/bls-payroll-news.ts";
import { ETF_CASH_SOURCES } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeCalendarVersion, exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS, firstRateTechnicalSignals } from "../lib/consensus/firstrate.ts";
import { digest } from "../lib/consensus/history.ts";
import { MARKET_HISTORY_SOURCE } from "../lib/consensus/market-history-settlement.ts";
import { collectMarketHistoryVolatility } from "../lib/consensus/market-history-volatility.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { FAMILY_FEATURE_REGISTRATION, PROSPECTIVE_FAMILY_POLICY_SHA256, PROSPECTIVE_FAMILY_RULES,
  readSealedFamilySession, readSealedRetailSession, recordProspectiveFamilyFeatures } from "../lib/consensus/prospective-family-features.ts";
import { secondaryFamilyStudies } from "../lib/consensus/secondary-family-studies.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const day = "2027-01-11", prior = "2027-01-08", issuedAt = day + "T13:01:00.000Z", edition = issuedAt.replace(/[:.]/g, "-");
const hash = "1".repeat(64), tech = PROSPECTIVE_FAMILY_RULES[0], option = PROSPECTIVE_FAMILY_RULES[4], news = PROSPECTIVE_FAMILY_RULES[5];
const at = (t: TestContext, when: string) => t.mock.timers.setTime(Date.parse(when));

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(day + "T12:30:00.000Z") });
  const root = await mkdtemp(join(tmpdir(), "as-issued-secondary-family-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function momentum(root: string) {
  const dates = exchangeSessions("2026-11-16", prior).slice(-6), approvedAt = prior + "T22:30:00.000Z";
  const approval: Parameters<typeof firstRateTechnicalSignals>[0] = {
    schemaVersion: 1, source: FIRST_RATE_SOURCE, from: dates[0], through: prior, approvedAt,
    issuers: [...FIRST_RATE_SYMBOLS, "TLT" as const].map(symbol => ({
      symbol, source: ETF_CASH_SOURCES[symbol], capturedAt: approvedAt, sha256: hash, cash: [],
    })),
    symbols: FIRST_RATE_SYMBOLS.map(symbol => ({ symbol, reviewedThrough: prior, withheld: [],
      rows: dates.map((date, i) => ({ ...exchangeSession(date)!, open: 100 + i, close: 100 + i })),
      proof: { source: { symbol, basis: "split-adjusted", capturedAt: approvedAt, modifiedAt: prior + "T22:00:00.000Z",
        url: "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_" + symbol + ".zip", sha256: hash },
        comparison: [hash], splitComparison: [hash], listingReferences: [] },
    })),
  };
  const file = join(root, ".consensus/private-firstrate/approvals", prior + "-" + digest({ ...approval, approvedAt: null }) + ".json");
  await durableJSON(file, { approval, sha256: digest(approval) }, true);
  return firstRateTechnicalSignals(approval, approvedAt).filter(signal => signal.instruments[0] !== "MARKET");
}
async function payroll(root: string) {
  const curr = "https://www.bls.gov/news.release/archives/empsit_01082027.htm", prev = "https://www.bls.gov/news.release/archives/empsit_12042026.htm";
  function original(date: string, month: string, copy: string) {
    return "<html><pre>Transmission of material in this news release is embargoed until 8:30 a.m. (ET) Friday, " +
      date + " Technical information. THE EMPLOYMENT SITUATION -- " + month + " 2026 " + copy + "</pre></html>";
  }
  const current = original("January 8, 2027", "DECEMBER", "Total nonfarm payroll employment rose by 165,000 in December. " +
    "The change in total nonfarm payroll employment for October was revised up by 53,000, from +133,000 to +186,000, and the change for November was revised up by 31,000, from +29,000 to +60,000. With these revisions, employment in October and November combined is 84,000 higher than previously reported.");
  const previous = original("December 4, 2026", "NOVEMBER", "Both total nonfarm payroll employment (+29,000) and the unemployment rate changed little. " +
    "The change in total nonfarm payroll employment for September was revised down from +21,000 to -10,000, and the change for October was revised down from +162,000 to +133,000. With these revisions, employment in September and October combined is 60,000 lower than previously reported.");
  return collectBlsPayrollNews(async url => new Response(url === curr ? current : url === prev ? previous :
    '<a href="' + new URL(curr).pathname + '">December 2026 Employment Situation</a><a href="' + new URL(prev).pathname + '">November 2026 Employment Situation</a>'),
    () => new Date().toISOString(), join(root, ".consensus/private-bls-payroll-news/current-collector"));
}
async function volatility(root: string) {
  const ids = { VIX: [5, "30-day"], VIX9D: [10, "9-day"], VIX3M: [8, "3-month"] } as const;
  const dates = exchangeSessions("2026-08-01", prior).slice(-61), end = prior + "T00:00:00Z";
  const signals = await collectMarketHistoryVolatility(async url => {
    const fromCboe = new URL(url).hostname === "cdn-api.cboe.com";
    const symbol = (fromCboe ? url.split("/").at(-1)!.split("_")[0] : url.split("/").find(s => s in ids)) as keyof typeof ids;
    if (!(symbol in ids)) return new Response(null, { status: 404 });
    const [id, term] = ids[symbol];
    if (!fromCboe && !url.includes("/bars/")) return Response.json({ ticker: symbol, dataset: "volatility/us",
      contract: { asset_class: "volatility", country: "US", exchange: "Cboe", name: "Volatility Index (S&P 500, " + term + ")", status: "active" },
      bars: { timeframes: [{ timeframe: "1d", last: end, updated: day + "T05:00:00Z" }] } });
    const rows = dates.map((date, i) => {
      const value = symbol === "VIX9D" ? 16 : symbol === "VIX3M" ? 20 : i === 60 ? 21 : 20;
      if (fromCboe) return [date.slice(5, 7) + "/" + date.slice(8) + "/" + date.slice(0, 4), value, value, value, value].join(",");
      return JSON.stringify({ symbol, symbol_id: id, timestamp: date + "T00:00:00Z", is_gap: false, gap_fill_method: 0,
        open: value, high: value, low: value, close: value, volume: 0, trade_count: 0 });
    });
    if (fromCboe) return new Response(["DATE,OPEN,HIGH,LOW,CLOSE", ...rows].join("\n"), { headers: { "content-type": "text/csv" } });
    return new Response(rows.join("\n"), { headers: { "content-type": "application/x-ndjson", "x-format": "jsonl",
      "x-data-through": end, "x-preview-limit": "100", "x-session": "UTC 00:00", "x-row-count": String(rows.length) } });
  }, join(root, ".consensus/private-volatility-indices"));
  return signals.filter(s => s.status === "available");
}
async function publish(root: string, t: TestContext, signals: Signal[]) {
  at(t, day + "T13:03:00.000Z");
  const snapshot: Snapshot = { schemaVersion: 1, origin: "prospective", id: edition, cutoff: issuedAt, issuedAt,
    engineVersion: "consensus-rules-2.0.0", signals, catalysts: [], sourcesAttempted: 3, collectionErrors: [] };
  const path = join(root, "public/consensus"), bytes = Buffer.from(JSON.stringify(snapshot));
  const index = Buffer.from(JSON.stringify([{ id: edition, issuedAt, engineVersion: snapshot.engineVersion, sha256: digest(snapshot) }]));
  await mkdir(path, { recursive: true });
  await writeFile(join(path, edition + ".json"), bytes); await writeFile(join(path, "index.json"), index);
  await writeFile(join(path, "outcomes.json"), "[]");
  await recordPreopenReceipt(root, day, edition, bytes, index, day + "T13:02:00.000Z");
  return recordProspectiveFamilyFeatures(root, day, edition);
}
const read = async (root: string, ...parts: string[]) => JSON.parse(await readFile(join(root, ...parts), "utf8"));

test("all six existing rule and ETF comparisons replay their native inputs and preregister independent future decisions", async t => {
  const root = await fixture(t);
  const [technicals, opts, bls] = await Promise.all([momentum(root), volatility(root), payroll(root)]);
  assert.equal((await publish(root, t, [...technicals, ...opts, bls])).available, 6);
  const raw = await readSealedFamilySession(root, day, edition, "core");
  const original = raw.find(r => r.id === news.id)!;
  assert.deepEqual([original.candidate, original.control, original.eventId, original.sourceHashes.length], [84, 165, "bls:payroll:2026-12", 2]);
  assert.deepEqual(await readSealedRetailSession(root, day, edition), []);
  assert.deepEqual(await readSealedFamilySession(root, day, edition, "core", { ...option, instrument: "QQQ" }), []);
  assert.deepEqual(await readSealedFamilySession(root, day, edition, "core", { ...tech, id: "unknown" } as unknown as typeof tech), []);
  // These are test registrations in a disposable synthetic installation, created after the original source and public issue.
  at(t, day + "T13:04:00.000Z");
  for (const { name, study } of secondaryFamilyStudies) {
    const p = await study.register(root);
    assert.equal(p.policy.alpha, 0.01 / 18);
    assert.equal((await read(root, study.registrationPath)).value.policy.originalPolicy, PROSPECTIVE_FAMILY_POLICY_SHA256);
    assert.deepEqual(p.policy.instruments, PROSPECTIVE_FAMILY_RULES.filter(r => r.family === name).map(r => r.instrument));
  }
  at(t, day + "T13:05:00.000Z");
  for (const { name, study } of secondaryFamilyStudies) {
    const matched = PROSPECTIVE_FAMILY_RULES.filter(r => r.family === name);
    const result = await study.enroll(root, day, edition);
    assert.equal(result.enrolled, matched.length);
    assert.deepEqual(await study.enroll(root, day, edition), result);
    for (const rule of matched) {
      const native = raw.find(r => r.id === rule.id && r.instrument === rule.instrument)!;
      const dir = join(dirname(study.registrationPath), rule.instrument, "events");
      assert.deepEqual(await readdir(join(root, dir)), [edition + ".json"]);
      const e = (await read(root, dir, edition + ".json")).value;
      assert.deepEqual([e.id, e.sourceSeal, e.capturedAt, e.candidate, e.control],
        [native.eventId, native.sourceSeal, native.recordedAt, rule.expectedSign * native.candidate, native.control]);
      assert.equal(e.phase, "train"); assert.equal(e.prediction, null);
    }
  }
  assert.equal(raw.find(row => row.id === option.id)?.candidate, 1);
  assert.deepEqual((await readSealedFamilySession(root, day, edition, "core", news))[0], original);
  at(t, day + "T21:15:00.000Z");
  const n = secondaryFamilyStudies.find(s => s.name === "news")!.study;
  assert.equal((await n.enroll(root, day, edition)).status, "outside_preopen");
  // The native TLT sign is accepted only after the pre-open source seal and the original first-pending core transaction.
  const tx = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", session = exchangeSession(day)!;
  await durableJSON(join(root, ".consensus/evaluation-transaction.json"), { schemaVersion: 1, id: tx, synthetic: true }, true);
  let labels = 0;
  const row = { snapshotId: edition, instrument: "TLT" as const, horizon: "daily" as const, issuedAt, entryAt: session.openAt,
    exitAt: session.closeAt, source: MARKET_HISTORY_SOURCE, adjustment: OUTCOME_PRICE_BASIS, calendarVersion: exchangeCalendarVersion(day, day),
    direction: () => { labels++; return 1 as const; } };
  const archive = [{ id: edition, issuedAt }];
  await n.stage(root, tx, [{ ...row, instrument: "SPY" }, { ...row, source: "manual" }], archive, []);
  assert.equal(labels, 0);
  await n.stage(root, tx, [row], archive, []);
  assert.equal(labels, 1);
  assert.equal((await read(root, dirname(n.registrationPath), "TLT", "admissions", edition + ".json")).value.source, MARKET_HISTORY_SOURCE);
});

test("re-hashing a mistaken economic event cannot change its official source or contaminate a different fund", async t => {
  const root = await fixture(t);
  const [technicals, bls] = await Promise.all([momentum(root), payroll(root)]);
  await publish(root, t, [...technicals, bls]);
  const folder = join(dirname(FAMILY_FEATURE_REGISTRATION), "sessions", day);
  const draft = await read(root, folder, edition + ".json"), seal = await read(root, folder, edition + ".seal.json");
  draft.observations.find((o: { id: string }) => o.id === news.id).data.eventId = "bls:payroll:2026-10";
  seal.preparedSha256 = digest(draft);
  await writeFile(join(root, folder, edition + ".json"), JSON.stringify(draft));
  await writeFile(join(root, folder, edition + ".seal.json"), JSON.stringify(seal));
  await assert.rejects(readSealedFamilySession(root, day, edition, "core", news), /native input/);
  assert.equal((await readSealedFamilySession(root, day, edition, "core", tech)).length, 1);

  const dir = dirname(secondaryFamilyStudies.find(s => s.name === "news")!.study.registrationPath);
  at(t, day + "T13:04:00.000Z");
  const n = secondaryFamilyStudies.find(s => s.name === "news")!.study;
  await n.register(root);
  at(t, day + "T13:05:00.000Z");
  await assert.rejects(n.enroll(root, day, edition), /native input/);
  await assert.rejects(readdir(join(root, dir, "TLT", "events")), { code: "ENOENT" });
});
