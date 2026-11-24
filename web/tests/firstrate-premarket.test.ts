import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { strToU8, zipSync } from "fflate";
import * as firstRate from "../lib/consensus/firstrate.ts";
import { firstRatePremarketSignal } from "../lib/consensus/firstrate-premarket.ts";
import { calculateConsensus, effectiveStatus } from "../lib/consensus/engine.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import { HORIZONS, type Signal } from "../lib/consensus/types.ts";

const day = "2026-11-18";
const capturedAt = "2026-11-19T10:00:00.000Z", approvedAt = "2026-11-19T10:15:00.000Z";
const vintage = "Wed, 18 Nov 2026 23:00:00 GMT";
const root = new URL("../scripts/", import.meta.url);
const symbols = ["SPY", "QQQ", "IWM", "DIA"] as const;
const docs = "Two weeks of split-adjusted sample data. Timestamps run from the start of the period. " +
  "Timezone is US Eastern Time. Times with zero volume are omitted. https://firstratedata.com/about/license";
const rows = ["03:59:00,320,330,310,325,550", "04:00:00,113.2589,122,110,112,7",
  "06:30:00,130,140,124,132,41", "09:29:00,115,119,113,117.1472,5", "09:30:00,400,411,385,402,1"];

async function fixture(t: TestContext, modifications: Partial<Record<typeof symbols[number], string[]>> = {},
  fiveMinuteRows?: Partial<Record<typeof symbols[number], string[]>>) {
  const directory = await mkdtemp(join(tmpdir(), "premarket-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts"), privateDir = join(directory, ".consensus/private-firstrate");
  const captures = join(privateDir, "captures", day);
  await mkdir(scripts);
  await mkdir(captures, { recursive: true, mode: 0o700 });
  for (const filename of ["collect-firstrate-inputs.py", "issuer_corporate_actions.py"])
    await copyFile(new URL(filename, root), join(scripts, filename));
  const symbolsApproved = [];
  for (const symbol of symbols) {
    const data = ["timestamp,open,high,low,close,volume", ...(modifications[symbol] ?? rows).map(row => day + " " + row)].join("\n");
    const five = fiveMinuteRows?.[symbol];
    const bytes = zipSync({ "_readme_documentation.txt": strToU8(docs), [symbol + "_1min_sample.csv"]: strToU8(data),
      ...(five && { [symbol + "_5min_sample.csv"]: strToU8(["timestamp,open,high,low,close,volume", ...five.map(row => day + " " + row)].join("\n")),
        [symbol + "_1day_sample.csv"]: strToU8("timestamp,open,high,low,close,volume\n" + day + ",100,110,90,103,90000") }) });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const url = "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_" + symbol + ".zip";
    await writeFile(join(captures, "sample-" + symbol + ".bin"), bytes, { mode: 0o600 });
    await writeFile(join(captures, "sample-" + symbol + ".json"), JSON.stringify({ url, sha256, lastModified: vintage, capturedAt }), { mode: 0o600 });
    symbolsApproved.push({ symbol, rows: [{ ...exchangeSession(day)!, open: 999, close: 995 }], withheld: [],
      proof: { source: { symbol, basis: "split-adjusted", url, sha256, modifiedAt: new Date(vintage).toISOString(), capturedAt },
        comparison: ["a".repeat(64)], splitComparison: ["b".repeat(64)], listingReferences: [] } });
  }
  // Early approvals used the envelope's through date without a per-symbol reviewedThrough field.
  const approval = { schemaVersion: 1, source: firstRate.FIRST_RATE_SOURCE, from: day, through: day, approvedAt, symbols: symbolsApproved };
  const path = join(privateDir, "approved.json");
  await writeFile(path, JSON.stringify({ approval, sha256: digest(approval) }), { mode: 0o600 });
  return { directory, captures, approval, path };
}

function checkSnapshot(signals: Signal[], cutoff: string) {
  validateSnapshot({ schemaVersion: 1, origin: "prospective", id: cutoff.replace(/[:.]/g, "-"), cutoff,
    issuedAt: cutoff, engineVersion: "consensus-rules-2.0.0", catalysts: [], signals, sourcesAttempted: 1, collectionErrors: [] });
}

const nativeBuckets = [rows[1], rows[2], rows[3].replace("09:29", "09:25")];
test("cross-interval approvals qualify each prior premarket without regular settlement and pin the first review", async t => {
  const spyMinutes = [rows[0], rows[1], "04:01:00,112,126,101,115.1234,19", ...rows.slice(2)];
  const { directory, path, captures } = await fixture(t, { SPY: spyMinutes }, {
    SPY: ["04:00:00,113.2589,126,101,115.1234,26", ...nativeBuckets.slice(1)],
    QQQ: nativeBuckets, IWM: [nativeBuckets[0], nativeBuckets[1].replace(",41", ",40"), nativeBuckets[2]],
  });
  await rm(path);
  const prepared = await firstRate.prepareFirstRatePremarket(directory, () => approvedAt);
  assert.equal(prepared.session, day);
  assert.deepEqual(prepared.funds.map(f => f.status), ["available", "available", "unavailable", "unavailable"]);
  assert.deepEqual(prepared.funds.slice(0, 2).map(f => f.verifiedBuckets), [3, 3]);
  assert.deepEqual(await firstRate.loadFirstRatePremarket(directory, capturedAt), []);
  const signals = await firstRate.loadFirstRatePremarket(directory, approvedAt);
  assert.deepEqual(signals.map(s => s.instruments[0]), ["SPY", "QQQ"]);
  assert.ok(signals.every(s => s.source.approvedAt === approvedAt && s.scores.daily === null));
  const later = await firstRate.prepareFirstRatePremarket(directory, () => "2026-11-19T11:00:00.000Z");
  assert.equal(later.funds[0].approvedAt, approvedAt);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await writeFile(join(captures, "sample-QQQ.bin"), "replaced archive");
  assert.deepEqual((await firstRate.loadFirstRatePremarket(directory, approvedAt)).map(s => s.instruments[0]), ["SPY"]);
});

test("a first premarket check after the next opening cannot create an earlier approval", async t => {
  const { directory, path } = await fixture(t, {}, { SPY: nativeBuckets });
  await rm(path);
  const prepared = await firstRate.prepareFirstRatePremarket(directory, () => "2026-11-19T14:30:00.000Z");
  assert.equal(prepared.funds[0].status, "expired");
  const seal = join(directory, ".consensus/private-firstrate/premarket-reviewed", day, "SPY.json");
  await assert.rejects(readFile(seal), { code: "ENOENT" });
  assert.deepEqual(await firstRate.loadFirstRatePremarket(directory, approvedAt), []);
});

test("approved sparse premarket samples join each ETF's premarket family only for the next session", async t => {
  const { directory, path } = await fixture(t);
  const before = await readFile(path);
  const signals = await firstRate.loadFirstRatePremarket(directory, approvedAt);
  assert.deepEqual(signals.map(s => s.instruments[0]), symbols);
  for (const s of signals) {
    assert.deepEqual(s.metrics.map(m => [m.value, m.unit, m.date]), [[3.4, "%", day], [3, "minutes", day]]);
    assert.equal(s.source.observedAt, "2026-11-18T14:29:59.999Z");
    assert.equal(s.source.retrievedAt, capturedAt);
    assert.equal(s.source.vintageAt, new Date(vintage).toISOString());
    assert.equal(s.source.approvedAt, approvedAt);
    assert.doesNotMatch(JSON.stringify(s), /113\.2589|117\.1472|private-firstrate|frd001/);
  }
  const all = firstRate.replaceFirstRatePremarket(missingSignals(approvedAt), signals, approvedAt);
  checkSnapshot(all, approvedAt);
  assert.equal(all.find(s => s.id === "premarket-bars")?.status, "unavailable");
  assert.deepEqual(all.find(s => s.id === "previous-premarket-bars")?.instruments, ["TLT"]);
  const market = all.find(s => s.id === "firstrate-premarket-equity-breadth")!;
  assert.deepEqual(market.metrics.map(m => m.value), [3.4, 4, 0, 0]);
  assert.deepEqual(market.instruments, ["MARKET"]);
  for (const symbol of [...symbols, "TLT", "MARKET"] as const) for (const horizon of HORIZONS) {
    const family = calculateConsensus(all, symbol, horizon, approvedAt).families.find(f => f.id === "premarket")!;
    assert.equal(family.available, symbol === "TLT" ? 0 : 1);
    assert.equal(family.score, null);
  }
  assert.deepEqual(await firstRate.loadFirstRatePremarket(directory, "2026-11-19T10:14:59.999Z"), []);
  assert.equal(effectiveStatus(signals[0], "2026-11-19T14:29:59.999Z"), "available");
  assert.equal(effectiveStatus(signals[0], "2026-11-19T14:30:00.000Z"), "stale");
  const later = await firstRate.loadFirstRatePremarket(directory, "2026-11-20T13:00:00.000Z");
  assert.ok(later.length === 4 && later.every(s => s.status === "stale"));
  assert.deepEqual(await readFile(path), before);
});

test("four matched equity windows support one market observation with a reproducible median and no vote", () => {
  const changes = [-3, 0, 1.1, 2.3];
  const etfs = symbols.map((symbol, i) => firstRatePremarketSignal({ symbol, session: day, changePct: changes[i], activeMinutes: 330,
    retrievedAt: capturedAt, vintageAt: new Date(vintage).toISOString(), sha256: String(i + 1).repeat(64) }, approvedAt, approvedAt));
  const make = (readings: Signal[]) => firstRate.replaceFirstRatePremarket(missingSignals(approvedAt), readings, approvedAt);
  const all = make(etfs);
  const breadth = all.find(s => s.id === "firstrate-premarket-equity-breadth")!;
  assert.deepEqual(breadth.metrics.map(m => m.value), [0.55, 2, 1, 1]);
  checkSnapshot(all, approvedAt);
  assert.deepEqual(breadth.directionalInstruments, []);
  assert.deepEqual(breadth.scores, { daily: null, weekly: null, monthly: null });
  assert.ok(!make(etfs.slice(1)).some(s => s.id === breadth.id));
  assert.throws(() => checkSnapshot(all.filter(s => s.id !== etfs[0].id), approvedAt), /premarket breadth/);
  const changed = structuredClone(all);
  changed.find(s => s.id === breadth.id)!.metrics[0].value = 0;
  assert.throws(() => checkSnapshot(changed, approvedAt), /premarket breadth/);
  const expired = firstRate.replaceFirstRatePremarket(all, undefined, "2026-11-19T14:30:00.000Z");
  assert.ok(!expired.some(s => s.id === breadth.id));
  checkSnapshot(expired, "2026-11-19T14:30:00.000Z");
});

test("a missing boundary, duplicate minute or invalid OHLCV withholds only the affected ETF", async t => {
  const { directory } = await fixture(t, {
    SPY: rows.filter(row => !row.startsWith("04:00")),
    QQQ: [rows[1], rows[2], rows[2], rows[3]],
    IWM: [rows[1], "06:30:00,10,9,8,10,1", rows[3]],
    DIA: [...rows.slice(0, 4), "09:30:00,arbitrary,core,fields,outside,window"],
  });
  assert.deepEqual((await firstRate.loadFirstRatePremarket(directory, approvedAt)).map(s => s.instruments[0]), ["DIA"]);
});

test("invalid bar times, missing final boundary, fractional volume and mismatched saved bytes cannot qualify", async t => {
  const { directory, captures } = await fixture(t, {
    SPY: [rows[1], "06:30:01,10,11,9,10,1", rows[3]],
    QQQ: rows.filter(row => !row.startsWith("09:29")),
    IWM: [rows[1], "06:30:00,10,11,9,10,1.2", rows[3]],
  });
  await writeFile(join(captures, "sample-DIA.bin"), "changed");
  assert.deepEqual(await firstRate.loadFirstRatePremarket(directory, approvedAt), []);
});

test("scoped editions expire saved inputs at the next open and keep a separate pending previous-session row", async t => {
  const { directory } = await fixture(t);
  const rows = await firstRate.loadFirstRatePremarket(directory, approvedAt);
  const original = firstRate.replaceFirstRatePremarket(missingSignals(approvedAt), rows, approvedAt);
  const expiry = "2026-11-19T14:30:00.000Z";
  assert.throws(() => checkSnapshot(original, expiry), /premarket/);
  const scoped = firstRate.replaceFirstRatePremarket(original, undefined, expiry);
  checkSnapshot(scoped, expiry);
  assert.deepEqual(scoped.find(s => s.id === "previous-premarket-bars")?.instruments, [...symbols, "TLT"]);
  assert.ok(scoped.filter(s => s.id.startsWith("firstrate-premarket-")).every(s => s.status === "stale"));
  for (const mutate of [
    (s: Signal) => { s.scores.daily = 0.1; },
    (s: Signal) => { s.metrics[1].value = 331; },
    (s: Signal) => { s.summary += " Raw price 113.2589"; },
    (s: Signal) => { s.source.approvedAt = "2026-11-20T13:00:00.000Z"; },
    (s: Signal) => { s.instruments = ["TLT"]; },
  ]) {
    const changed = structuredClone(rows[0]); mutate(changed);
    assert.throws(() => checkSnapshot([changed], approvedAt), /premarket/);
  }
});

test("weekend DST and the Thanksgiving closure use the actual next exchange open", () => {
  for (const [session, captured, expiry] of [
    ["2026-10-30", "2026-10-30T23:00:00.000Z", "2026-11-02T14:30:00.000Z"],
    ["2026-11-25", "2026-11-25T23:00:00.000Z", "2026-11-27T14:30:00.000Z"],
    ["2026-11-27", "2026-11-27T20:00:00.000Z", "2026-11-30T14:30:00.000Z"],
  ]) {
    const s = firstRatePremarketSignal({ symbol: "IWM", session, changePct: 0.1, activeMinutes: 2,
      retrievedAt: captured, vintageAt: captured, sha256: "a".repeat(64) }, captured, captured);
    assert.equal(effectiveStatus(s, new Date(Date.parse(expiry) - 1).toISOString()), "available");
    assert.equal(effectiveStatus(s, expiry), "stale");
  }
});

test("each symbol needs its approved date, share basis and matching capture timestamps", async t => {
  const { directory, captures, path, approval } = await fixture(t);
  const [spy, qqq] = approval.symbols;
  Object.assign(spy, { reviewedThrough: "2026-11-17" });
  qqq.proof.source.basis = "unadjusted";
  await writeFile(path, JSON.stringify({ approval, sha256: digest(approval) }));
  const receipt = join(captures, "sample-IWM.json");
  const meta = JSON.parse(await readFile(receipt, "utf8"));
  await writeFile(receipt, JSON.stringify({ ...meta, capturedAt: "2026-11-19T10:01:00.000Z" }));
  assert.deepEqual((await firstRate.loadFirstRatePremarket(directory, approvedAt)).map(s => s.instruments[0]), ["DIA"]);
});

test("a reviewed archive can support the premarket window when the regular-session price pair is withheld", async t => {
  const { directory, path, approval } = await fixture(t);
  const spy = approval.symbols[0];
  Object.assign(spy, { reviewedThrough: day, rows: [{ ...exchangeSession("2026-11-17")!, open: 10, close: 11 }],
    withheld: [{ session: day, reason: "price" }] });
  await writeFile(path, JSON.stringify({ approval, sha256: digest(approval) }));
  const before = await readFile(path);
  const signals = await firstRate.loadFirstRatePremarket(directory, approvedAt);
  assert.deepEqual(signals.map(s => s.instruments[0]), symbols);
  assert.equal(signals[0].metrics[0].value, 3.4);
  assert.deepEqual(await readFile(path), before);
});
