import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { collectBlsPayrollNews } from "../lib/consensus/bls-payroll-news.ts";
import { ETF_CASH_SOURCES } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS, firstRateTechnicalSignals } from "../lib/consensus/firstrate.ts";
import { digest } from "../lib/consensus/history.ts";
import { collectMarketHistoryVolatility } from "../lib/consensus/market-history-volatility.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import {
  FAMILY_FEATURE_REGISTRATION, PROSPECTIVE_FAMILY_POLICY_SHA256, PROSPECTIVE_FAMILY_RULES,
  readProspectiveFamilyFeatures as read, recordProspectiveFamilyFeatures as record
} from "../lib/consensus/prospective-family-features.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Signal } from "../lib/consensus/types.ts";

const day = "2026-11-24", prior = "2026-11-23", clock = day + "T13:05:00.000Z", hash = "1".repeat(64);
async function fixture(t: TestContext, now = clock) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const root = await mkdtemp(join(tmpdir(), "consensus-feature-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function tick(t: TestContext, at: string) { t.mock.timers.setTime(Date.parse(at)); }
async function publish(root: string, session: string, issue: string, witness: string, signals: Signal[], cutoff = issue) {
  const id = issue.replace(/[:.]/g, "-");
  const snapshot = {
    schemaVersion: 1, origin: "prospective", id, issuedAt: issue, cutoff, engineVersion: "consensus-rules-2.0.0", signals,
    catalysts: [], sourcesAttempted: 1, collectionErrors: []
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  await mkdir(join(root, "public/consensus"), { recursive: true });
  await writeFile(join(root, "public/consensus", id + ".json"), bytes);
  const index = Buffer.from(JSON.stringify([{ id, issuedAt: issue, engineVersion: snapshot.engineVersion, sha256: digest(snapshot) }]));
  await recordPreopenReceipt(root, session, id, bytes, index, witness);
  return id;
}
function momentum(through = prior) {
  const dates = exchangeSessions("2026-11-09", through).slice(-6);
  const approvedAt = through + "T22:30:00.000Z";
  const approval = {
    schemaVersion: 1 as const, source: FIRST_RATE_SOURCE, from: dates[0], through, approvedAt,
    issuers: [...FIRST_RATE_SYMBOLS, "TLT" as const].map(symbol => ({ symbol, source: ETF_CASH_SOURCES[symbol], sha256: hash, capturedAt: approvedAt, cash: [] })),
    symbols: FIRST_RATE_SYMBOLS.map(symbol => ({
      symbol, reviewedThrough: through, withheld: [],
      rows: dates.map((date, i) => ({ ...exchangeSession(date)!, open: 100 + i, close: 100 + i })),
      proof: {
        source: {
          symbol, basis: "split-adjusted" as const, capturedAt: approvedAt, modifiedAt: through + "T22:00:00.000Z",
          url: "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_" + symbol + ".zip", sha256: hash
        }, comparison: [hash], splitComparison: [hash], listingReferences: []
      }
    })),
  } satisfies Parameters<typeof firstRateTechnicalSignals>[0];
  const file = ".consensus/private-firstrate/approvals/" + through + "-" + digest({ ...approval, approvedAt: null }) + ".json";
  return { file, stored: { approval, sha256: digest(approval) }, signals: firstRateTechnicalSignals(approval, approvedAt).filter(s => s.instruments[0] !== "MARKET") };
}

test("after 08:00, concurrent enrollments durably pin all four adjusted comparisons to one exact public witness", async t => {
  const root = await fixture(t), f = momentum();
  const none = await read(root);
  assert.equal(none.registeredAt, null); assert.equal(PROSPECTIVE_FAMILY_RULES.length, 6);
  assert.equal(PROSPECTIVE_FAMILY_POLICY_SHA256, "0d1ba17adb95bc2f45f36d1fd5e9bfcf022db78d3e9900594b39a3d077fe3a79");
  await durableJSON(join(root, f.file), f.stored, true);
  const edition = await publish(root, day, day + "T13:02:00.000Z", day + "T13:04:00.000Z", f.signals);
  const results = await Promise.all(Array.from({ length: 4 }, () => record(root, day, edition)));
  assert.deepEqual(results, [results[0], results[0], results[0], results[0]]); assert.equal(results[0].available, 4);
  const directory = join(root, dirname(FAMILY_FEATURE_REGISTRATION), "sessions", day);
  assert.deepEqual(await readdir(directory), [edition + ".json", edition + ".seal.json"]);
  for (const p of [join(root, FAMILY_FEATURE_REGISTRATION), join(directory, edition + ".json"), join(directory, edition + ".seal.json")])
    assert.equal((await stat(p)).mode & 0o777, 0o600);
  const proof = await read(root);
  assert.deepEqual(proof.rows.map(r => [r.instrument, r.candidate, r.control, r.sourceHashes.length, r.proofs.length]),
    FIRST_RATE_SYMBOLS.map(s => [s, 5, 1, 5, 1]));
  assert.equal(proof.sessions[0].witnessedAt, day + "T13:04:00.000Z");
  assert.equal(proof.rows[0].recordedAt, clock); assert.equal(proof.rows[0].availableAt, f.stored.approval.approvedAt);
  const actual = JSON.parse(await readFile(join(directory, edition + ".json"), "utf8"));
  actual.observations[0].data.candidate++;
  await writeFile(join(directory, edition + ".json"), JSON.stringify(actual));
  await assert.rejects(read(root), /sealed public witness/);
});

test("the latest witnessed edition supersedes an earlier one even when only the earlier one had a feature registration", async t => {
  const root = await fixture(t), f = momentum();
  await durableJSON(join(root, f.file), f.stored, true);
  const first = await publish(root, day, day + "T13:01:00.000Z", day + "T13:03:00.000Z", f.signals);
  await record(root, day, first);
  tick(t, day + "T14:05:00.000Z");
  const later = await publish(root, day, day + "T14:01:00.000Z", day + "T14:02:00.000Z", f.signals);
  const waiting = await read(root); assert.equal(waiting.sessions[0].status, "missing-latest-registration");
  assert.equal(waiting.rows.length, 0); assert.equal(waiting.missing.length, 6);
  await record(root, day, later); await record(root, day, first);
  const done = await read(root); assert.equal(done.rows.length, 4);
  assert.ok(done.rows.every(r => r.edition === later)); assert.equal(done.sessions[0].receipts, 2);
  tick(t, "2026-11-25T13:05:00.000Z");
  const again = await publish(root, "2026-11-25", "2026-11-25T13:01:00.000Z", "2026-11-25T13:02:00.000Z", f.signals);
  const repeated = await record(root, "2026-11-25", again);
  assert.equal(repeated.available, 0); assert.equal(repeated.missing.filter(m => m.reason === "not-immediately-prior-session").length, 4);
  assert.equal((await read(root)).rows.length, 4); assert.equal((await read(root, day)).sessions.length, 1);
  tick(t, day + "T14:10:00.000Z");
  await assert.rejects(record(root, day, first), /later prospective session/);
});

test("a later source file cannot backfill an original miss, a changed available source fails replay, and a changed archive fails the witness", async t => {
  const root = await fixture(t), f = momentum();
  const edition = await publish(root, day, day + "T13:01:00.000Z", day + "T13:02:00.000Z", f.signals);
  const absent = await record(root, day, edition);
  assert.equal(absent.missing.filter(m => m.reason === "native-proof-missing").length, 4);
  await durableJSON(join(root, f.file), f.stored, true);
  assert.equal((await record(root, day, edition)).available, 0); assert.equal((await read(root)).rows.length, 0);
  const second = await publish(root, day, day + "T13:03:00.000Z", day + "T13:04:00.000Z", f.signals);
  assert.equal((await record(root, day, second)).available, 4);
  const changed = structuredClone(f.stored); changed.approval.symbols[0].rows[0].close = 777;
  await writeFile(join(root, f.file), JSON.stringify(changed));
  await assert.rejects(read(root), /native input/);
  await writeFile(join(root, f.file), JSON.stringify(f.stored));
  const path = join(root, "public/consensus", second + ".json");
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n")]));
  await assert.rejects(read(root), /selected public edition/);
});

test("no registration at the opening bell, on a past session, before the policy, or on a previous evening's only public witness", async t => {
  const root = await fixture(t);
  const last = "2026-11-24T03:31:00.000Z";
  const evening = await publish(root, day, last, "2026-11-24T03:32:00.000Z", [missingSignals(last)[0]]);
  await assert.rejects(record(root, day, evening), /same-day public/);
  const edition = await publish(root, day, day + "T13:01:00.000Z", day + "T13:03:00.000Z", [missingSignals(day + "T13:00:00.000Z")[0]]);
  await assert.rejects(record(root, prior, edition), /real same-day/);
  tick(t, day + "T14:30:00.000Z"); await assert.rejects(record(root, day, edition), /real same-day/);
  tick(t, "2026-11-23T13:05:00.000Z"); await assert.rejects(record(root, prior, edition), /real same-day/);
  assert.equal((await read(root)).registeredAt, null);
});

test("a checksum alone cannot qualify a fund with an unverified issuer address or absent split reconciliation", async t => {
  const root = await fixture(t), f = momentum();
  const approval = f.stored.approval;
  approval.issuers.find(i => i.symbol === "SPY")!.source = "https://example.com/issuer";
  approval.symbols[0].proof.splitComparison = [];
  const wrong = join(root, ".consensus/private-firstrate/approvals", prior + "-" + digest({ ...approval, approvedAt: null }) + ".json");
  await durableJSON(wrong, { approval, sha256: digest(approval) }, true);
  const signals = firstRateTechnicalSignals(approval, clock).filter(s => s.instruments[0] !== "MARKET");
  const id = await publish(root, day, day + "T13:01:00.000Z", day + "T13:02:00.000Z", signals);
  const result = await record(root, day, id);
  assert.equal(result.available, 0);
  assert.equal(result.missing.filter(m => m.reason === "native-proof-mismatch").length, 4);
  approval.issuers.find(i => i.symbol === "SPY")!.source = ETF_CASH_SOURCES.SPY;
  const path = join(root, ".consensus/private-firstrate/approvals", prior + "-" + digest({ ...approval, approvedAt: null }) + ".json");
  await durableJSON(path, { approval, sha256: digest(approval) }, true);
  const second = await publish(root, day, day + "T13:03:00.000Z", day + "T13:04:00.000Z",
    firstRateTechnicalSignals(approval, clock).filter(s => s.instruments[0] !== "MARKET"));
  const partial = await record(root, day, second);
  assert.equal(partial.available, 3);
  assert.ok(partial.missing.some(m => m.instrument === "SPY" && m.reason === "native-proof-mismatch"));
});

test("an unchanged overnight edition becomes eligible only after a fresh morning verification of its live archive and index", async t => {
  const root = await fixture(t, day+"T03:05:00.000Z"), f = momentum();
  await durableJSON(join(root,f.file),f.stored,true);
  const id = await publish(root,day,day+"T03:01:00.000Z",day+"T03:03:00.000Z",f.signals);
  tick(t,clock);
  await assert.rejects(record(root,day,id),/same-day public/);
  const bytes = await readFile(join(root,"public/consensus",id+".json"));
  const first = JSON.parse(await readFile(join(root,".consensus/private-preopen",day,id+".json"),"utf8"));
  await recordPreopenReceipt(root,day,id,bytes,Buffer.from(first.indexText),clock);
  const result = await record(root,day,id);
  assert.equal(result.witnessedAt,clock);
  assert.equal(result.available,4);
  assert.ok((await read(root)).rows.every(r => r.witnessedAt === clock));
  await rm(join(root,".consensus/private-preopen",day,"same-day",id+".json"));
  await assert.rejects(read(root),/lost its same-day public witness/);
});

const indexSymbols = { VIX: [5, "S&P 500, 30-day"], VIX9D: [10, "S&P 500, 9-day"], VIX3M: [8, "S&P 500, 3-month"] } as const;
function indexSource(url: string) {
  const isReference = new URL(url).hostname === "cdn-api.cboe.com";
  const name = (isReference ? url.split("/").at(-1)!.split("_")[0] : url.split("/").find(s => s in indexSymbols)) as keyof typeof indexSymbols;
  if (!(name in indexSymbols)) return Promise.resolve(new Response(null, { status: 404 }));
  const [id, label] = indexSymbols[name], end = prior + "T00:00:00Z";
  if (!isReference && !url.includes("/bars/")) return Promise.resolve(Response.json({
    ticker: name, dataset: "volatility/us",
    contract: { asset_class: "volatility", country: "US", exchange: "Cboe", name: "Volatility Index (" + label + ")", status: "active" },
    bars: { timeframes: [{ timeframe: "1d", last: end, updated: "2026-11-24T05:00:00Z" }] }
  }));
  const dates = exchangeSessions("2026-08-01", prior).slice(-61);
  const rows = dates.map((date, i) => {
    const price = name === "VIX9D" ? 16 : name === "VIX3M" ? 20 : 20 + (i === 60 ? 1 : 0);
    if (isReference) return [date.slice(5, 7) + "/" + date.slice(8) + "/" + date.slice(0, 4), price, price, price, price].join(",");
    return JSON.stringify({
      timestamp: date + "T00:00:00Z", symbol: name, symbol_id: id, is_gap: false, gap_fill_method: 0, close: price,
      open: price, high: price, low: price, volume: 0, trade_count: 0
    });
  });
  if (isReference) return Promise.resolve(new Response(["DATE,OPEN,HIGH,LOW,CLOSE", ...rows].join("\n"), { headers: { "content-type": "text/csv" } }));
  return Promise.resolve(new Response(rows.join("\n"), {
    headers: {
      "content-type": "application/x-ndjson", "x-format": "jsonl", "x-data-through": end,
      "x-preview-limit": "100", "x-session": "UTC 00:00", "x-row-count": String(rows.length)
    }
  }));
}
test("SPY compares the negative term band with VIX rank only after all 183 Cboe close checks; changed QA cannot enter", async t => {
  const root = await fixture(t, day + "T12:30:00.000Z");
  const folder = join(root, ".consensus/private-volatility-indices");
  const signals = (await collectMarketHistoryVolatility(indexSource, folder)).filter(s => s.status === "available");
  tick(t, clock);
  const edition = await publish(root, day, day + "T13:01:00.000Z", day + "T13:02:00.000Z", signals);
  assert.equal((await record(root, day, edition)).available, 1);
  const row = (await read(root)).rows[0];
  assert.deepEqual([row.instrument, row.family, row.candidate, row.control, row.sourceHashes.length, row.proofs.length], ["SPY", "options", 1, 5, 6, 3]);
  const p = join(root, row.proofs[0].file), native = JSON.parse(await readFile(p, "utf8"));
  native.comparison.rows[0][1] += 1; native.comparison.rowsHash = digest(native.comparison.rows);
  await writeFile(p, JSON.stringify(native));
  await assert.rejects(read(root), /native input/);
});

test("TLT requires the two original BLS releases and accepts each payroll event only for the first following exchange session", async t => {
  const session = "2026-12-07", at = session + "T13:05:00.000Z";
  const root = await fixture(t, session + "T12:30:00.000Z");
  const current = "https://www.bls.gov/news.release/archives/empsit_12042026.htm", previous = "https://www.bls.gov/news.release/archives/empsit_11062026.htm";
  function news(stamp: string, month: string, detail: string) {
    return "<html><pre>Transmission of material in this news release is embargoed until 8:30 a.m. (ET) Friday, " +
      stamp + " Technical information. THE EMPLOYMENT SITUATION -- " + month + " 2026 " + detail + "</pre></html>";
  }
  const a = news("December 4, 2026", "NOVEMBER", "Total nonfarm payroll employment rose by 165,000 in November. " +
    "The change in total nonfarm payroll employment for September was revised up by 53,000, from +133,000 to +186,000, and the change for October was revised up by 31,000, from +29,000 to +60,000. With these revisions, employment in September and October combined is 84,000 higher than previously reported.");
  const b = news("November 6, 2026", "OCTOBER", "Both total nonfarm payroll employment (+29,000) and the unemployment rate changed little. " +
    "The change in total nonfarm payroll employment for August was revised down from +21,000 to -10,000, and the change for September was revised down from +162,000 to +133,000. With these revisions, employment in August and September combined is 60,000 lower than previously reported.");
  const signal = await collectBlsPayrollNews(async url => new Response(url === current ? a : url === previous ? b :
    '<a href="' + new URL(current).pathname + '">November 2026 Employment Situation</a><a href="' + new URL(previous).pathname + '">October 2026 Employment Situation</a>'),
    () => new Date().toISOString(), join(root, ".consensus/private-bls-payroll-news/current-collector"));
  assert.equal(signal.status, "available", signal.collectionNote); tick(t, at);
  const id = await publish(root, session, session + "T13:01:00.000Z", session + "T13:02:00.000Z", [signal]);
  assert.equal((await record(root, session, id)).available, 1);
  const row = (await read(root)).rows[0];
  assert.deepEqual([row.instrument, row.candidate, row.control, row.sourceHashes.length, row.eventId], ["TLT", 84, 165, 2, "bls:payroll:2026-11"]);
  const p = join(root, row.proofs[0].file), original = JSON.parse(await readFile(p, "utf8"));
  const tampered = structuredClone(original); tampered.previous.gzip = tampered.current.gzip;
  await writeFile(p, JSON.stringify(tampered)); await assert.rejects(read(root), /native input/);
  await writeFile(p, JSON.stringify(original));
  tick(t, "2026-12-08T13:05:00.000Z");
  const late = await publish(root, "2026-12-08", "2026-12-08T13:01:00.000Z", "2026-12-08T13:02:00.000Z", [signal]);
  assert.ok((await record(root, "2026-12-08", late)).missing.some(m => m.reason === "outside-payroll-release-target"));
  assert.equal((await read(root)).rows.length, 1);
});
