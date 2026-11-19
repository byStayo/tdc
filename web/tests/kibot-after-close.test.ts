import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { ctaReferenceUrl } from "../lib/consensus/cta-reference.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { ETF_CASH_SOURCES } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { digest, publishSnapshot } from "../lib/consensus/history.ts";
import { completedRegularSession, evaluatePrivateAfterClose, reviewedFund, type CloseProof, type SessionFundProof } from "../lib/consensus/kibot-after-close.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { summarizePrivateSessions, verifiedPrivateSession, verifyPreviousResearchSessions } from "../lib/consensus/kibot-verified-session.ts";
import { nasdaqDaily, retainedSessionWitnesses, STOCKLAKE_HISTORY } from "../lib/consensus/kibot-session-witnesses.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const clock = (day: string) => exchangeSession(day)!;
const first = "2026-11-16", target = "2026-11-17";
function edition(day: string): Snapshot {
  const at = day + "T13:00:00.000Z";
  const signal = missingSignals(at)[0];
  return { id: at.replace(/[:.]/g, "-"), issuedAt: at, cutoff: at, schemaVersion: 1, origin: "prospective",
    engineVersion: "consensus-rules-1.1.0", signals: [{ ...signal, status: "available",
      series: [{ date: "2026-11-12", value: +day.slice(-2) }], scores: { daily: .2, weekly: .1, monthly: -.1 },
      source: { ...signal.source, observedAt: "2026-11-12", sha256: "1".repeat(64) } }],
    catalysts: [], sourcesAttempted: 1, collectionErrors: [] };
}
function fund(day: string, previous: string, exDate = false): SessionFundProof {
  const capturedAt = day + "T22:00:00.000Z", stamp = { capturedAt, sha256: "a".repeat(64) };
  const bars = [previous, day].map(d => ({ ...clock(d), open: 100, close: 101 }));
  return { symbol: "QQQ", asTraded: bars, selectedBars: structuredClone(bars), sources: {
    kibot: { ...stamp, source: KIBOT_PRICE_CITATION, basis: "as-traded regular-session first and last trade" },
    secondary: { ...stamp, source: STOCKLAKE_HISTORY, basis: "provider daily OHLCV; venue, eligible trade and adjustment method unspecified" },
    issuer: { ...stamp, source: ETF_CASH_SOURCES.QQQ, targetExDates: exDate ? [{ session: day, amount: .03 }] : [] },
  } };
}
const now = "2026-11-18T03:00:00.000Z";

test("requires the completed full regular session, independent direction, prices, issuer, and real source clocks", () => {
  assert.throws(() => completedRegularSession("2026-11-27", "2026-11-28T22:00:00.000Z"), /full exchange/);
  assert.throws(() => completedRegularSession(target, clock(target).closeAt), /completed/);
  assert.throws(() => completedRegularSession("2026-11-15", now), /full exchange/);
  const row = fund(target, first, true);
  function rejects(change: (v: SessionFundProof) => void, reason: RegExp) {
    const copy = structuredClone(row); change(copy);
    assert.throws(() => reviewedFund(copy, "QQQ", target, first, edition(target), now), reason);
  }
  rejects(v => { v.asTraded[1].close = 99.999; v.selectedBars[1].close = 100.001; }, /directions disagree/);
  rejects(v => { v.selectedBars[1].open += .04; }, /prices or directions/);
  rejects(v => { v.selectedBars[1].close += .2; }, /prices or directions/);
  rejects(v => { v.selectedBars[0].close -= .02; }, /cash basis/);
  rejects(v => { v.asTraded[0] = v.asTraded[1]; }, /session clock/);
  rejects(v => { v.asTraded[1].openAt = v.asTraded[0].openAt; }, /session clock/);
  rejects(v => { v.sources.issuer.capturedAt = clock(target).openAt; }, /post-close/);
  rejects(v => { v.sources.kibot.capturedAt = "2026-11-18T05:00:00.000Z"; }, /post-close/);
  rejects(v => { v.sources.issuer.source = ETF_CASH_SOURCES.DIA; }, /official issuer/);
  rejects(v => { v.sources.secondary!.source = KIBOT_PRICE_CITATION; }, /secondary/);
  const result = reviewedFund(row, "QQQ", target, first, edition(target), now);
  assert.equal(result.returnPct, (101 / 100 - 1) * 100);
  assert.equal(result.key, edition(target).id + ":QQQ:daily");
  assert.equal(result.directionCorrect, null);
  assert.ok(!("adjustment" in result) && !("entry" in result));
});

async function syntheticSources(root: string, sourceDir: string, day: string, previous: string, exDate: boolean) {
  const issued = edition(day);
  await publishSnapshot(root, issued);
  const archive = await readFile(join(root, "public/consensus", issued.id + ".json"));
  const index = await readFile(join(root, "public/consensus/index.json"));
  const stamp = await recordPreopenReceipt(root, day, issued.id, archive, index, day + "T13:15:00.000Z");
  const row = fund(day, previous, exDate);
  const dir = join(sourceDir, "sources", day);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const capturedAt = row.sources.kibot.capturedAt, usDay = day.slice(5, 7) + "/" + day.slice(-2) + "/" + day.slice(0, 4);
  const csv = usDay + ",100,102,99,101,2500\n";
  row.sources.kibot.sha256 = hash(csv);
  await durableJSON(join(dir, "QQQ-kibot.json"), { source: KIBOT_PRICE_CITATION, symbol: "QQQ", first: day, through: day,
    unadjusted: true, capturedAt, csv, sha256: hash(csv) });
  const history = { symbol: "QQQ", count: 1, history: [{ date: day, open: 100, high: 102, low: 99, close: 101, volume: 2500 }] };
  const body = JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(history) }] } });
  row.sources.secondary!.sha256 = hash(body);
  await durableJSON(join(dir, "stocklake-QQQ.json"), { provider: "stocklake", status: 200, capturedAt,
    url: STOCKLAKE_HISTORY, rawText: body, sha256: hash(body) });
  const cash = [{ exDate: "2026-09-21", distributionAmountPerUnit: .75143 }];
  if (exDate) cash.push({ exDate: day, distributionAmountPerUnit: .03 });
  const bytes = Buffer.from(JSON.stringify({ cusip: "46090E103", currencyCode: "USD", distributions: cash }));
  row.sources.issuer.sha256 = hash(bytes);
  await writeFile(join(dir, "issuer-QQQ.bin"), bytes, { mode: 0o600 });
  await durableJSON(join(dir, "issuer-QQQ.json"), { url: ETF_CASH_SOURCES.QQQ, sha256: hash(bytes), capturedAt });
  const proof: CloseProof = { schemaVersion: 1, purpose: "owner-private-after-close-ETF-proof", day, previous, edition: issued.id,
    market: clock(day), pin: { session: day, edition: issued.id, byteSha256: stamp.archiveSha256, publiclyObservedAt: stamp.observedAt,
      source: "pre-open" }, sources: { QQQ: row } };
  return { proof, dir, archive };
}
async function store(sourceDir: string, proof: CloseProof) {
  const path = join(sourceDir, proof.day + "-" + digest(proof) + ".json");
  await durableJSON(path, proof);
  return path;
}

test("the offline entry replays dated bytes, preserves outcome identity on repeat, and requires the previous control on an ex-date", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-kibot-close-"));
  try {
    await symlink(new URL("../scripts", import.meta.url), join(root, "scripts"));
    const sourceDir = join(root, "inputs");
    const start = await syntheticSources(root, sourceDir, first, "2026-11-13", false);
    const finish = await syntheticSources(root, sourceDir, target, first, true);
    const file = await store(sourceDir, finish.proof);
    await rename(start.dir, start.dir + "-pending");
    assert.equal((await evaluatePrivateAfterClose(root, target, file)).qualified, 0);
    await rename(start.dir + "-pending", start.dir);
    const report = await evaluatePrivateAfterClose(root, target, file);
    assert.deepEqual([report.qualified, report.added, report.called, report.pending.length, report.allInputsCapturedOnSessionDate], [1, 1, 0, 4, 1]);
    assert.ok(!JSON.stringify(report).includes("returnPct"));
    const resultFile = join(root, ".consensus/private-kibot/after-close", target, "QQQ.json");
    assert.equal((await evaluatePrivateAfterClose(root, first, await store(sourceDir, start.proof))).qualified, 1);
    const bytes = await readFile(resultFile);
    assert.equal((await stat(resultFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(bytes.toString()).returnPct, (101 / 100 - 1) * 100);
    assert.equal((await evaluatePrivateAfterClose(root, target, file)).added, 0);
    assert.deepEqual(await readFile(resultFile), bytes);
    await assert.rejects(access(join(root, ".consensus/private-kibot/evaluation.json")));
    assert.deepEqual(await readFile(join(root, "public/consensus", finish.proof.edition + ".json")), finish.archive);
    const missing = structuredClone(finish.proof);
    missing.pin = null;
    const replay = await evaluatePrivateAfterClose(root, target, await store(sourceDir, missing));
    assert.equal(replay.qualified, 1);
    missing.pin = { ...finish.proof.pin!, source: "independently-observed-index" };
    assert.equal((await evaluatePrivateAfterClose(root, target, await store(sourceDir, missing))).qualified, 1);
    missing.preopen = { edition: finish.proof.edition, observedAt: target + "T13:20:00.000Z", archiveSha256: finish.proof.pin!.byteSha256 };
    assert.equal((await evaluatePrivateAfterClose(root, target, await store(sourceDir, missing))).qualified, 1);
    missing.preopen.archiveSha256 = "e".repeat(64);
    await assert.rejects(evaluatePrivateAfterClose(root, target, await store(sourceDir, missing)), /pre-open/);
    delete missing.preopen;
    missing.pin.publiclyObservedAt = clock(target).openAt;
    await assert.rejects(evaluatePrivateAfterClose(root, target, await store(sourceDir, missing)), /pre-open/);
    const forged = structuredClone(finish.proof);
    forged.sources.QQQ!.asTraded[1].close = 100.99;
    assert.equal((await evaluatePrivateAfterClose(root, target, await store(sourceDir, forged))).qualified, 0);
    const changed = structuredClone(finish.proof);
    changed.sources.QQQ!.sources.issuer.targetExDates = [];
    assert.equal((await evaluatePrivateAfterClose(root, target, await store(sourceDir, changed))).qualified, 0);
    const issuer = join(finish.dir, "issuer-QQQ.bin");
    await writeFile(issuer, "{}");
    assert.equal((await evaluatePrivateAfterClose(root, target, file)).qualified, 0);
    assert.deepEqual(await readFile(resultFile), bytes);
    await durableJSON(file, start.proof);
    await assert.rejects(evaluatePrivateAfterClose(root, target, file), /digest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the live receipt format replays the final CTA participant file and Nasdaq Open and Close/Last", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-kibot-witness-"));
  try {
    await symlink(new URL("../scripts", import.meta.url), join(root, "scripts"));
    const sourceDir = join(root, "inputs");
    const { proof, dir } = await syntheticSources(root, sourceDir, target, first, false);
    const qqq = proof.sources.QQQ!;
    const at = qqq.sources.kibot.capturedAt;
    const table = { headers: { date: "Date", open: "Open", close: "Close/Last", high: "High", low: "Low" },
      rows: [{ date: "11/17/2026", open: "$100", close: "$101", low: "$99", high: "$102" }] };
    const url = nasdaqDaily("QQQ", target);
    async function nasdaq() {
      const bytes = Buffer.from(JSON.stringify({ status: { rCode: 200 }, data: { symbol: "QQQ", tradesTable: table } }));
      qqq.sources.historical = { source: url, basis: "Nasdaq historical Open and Close/Last", capturedAt: at, sha256: hash(bytes) };
      await durableJSON(join(dir, "QQQ-daily.json"), { url, symbol: "QQQ", kind: "daily", status: 200,
        requestedAt: target + "T21:15:00.000Z", capturedAt: at, sha256: hash(bytes), body: bytes.toString("base64") });
    }
    await nasdaq();
    const spy = structuredClone(qqq); spy.symbol = "SPY";
    delete spy.sources.secondary; delete spy.sources.historical;
    const stamp = "2026-11-18T01:00:20.120Z", capturedAt = "2026-11-18T01:05:00.000Z";
    const header = "Msg Cat/Type,TransTime,SeqNum,Symbol,instrumentType,partiId,prevClosePriceDate,lastClosePrice,highPrice,lowPrice,openPrice,totalVolume,shortSaleRestrictionInd,primaryListingMarketPartiId,financialStausInd,numberOfParticipants";
    const lines = ["Tue Nov 17 22:03:29 EDT 2026 prod", header];
    for (const s of ["SPY", "DIA", "IWM"]) lines.push(
      `FractionalConsolidatedEODSummary,_16:15:00.00,_21,${s},Equity,AMEX,_,100,102,99,,5000, ,ARCA,0,16,`,
      `FractionalConsolidatedEODSummary,_20:00:20.12,_23,${s},Equity,AMEX,_,101,102,99,,5000, ,ARCA,0,16,`,
      `FractionalParticipantEODSummary,_20:00:20.12,_24,${s},Equity,ARCA,_,101,102,99,100,3000,,,,,+`,
    );
    const raw = Buffer.from(lines.join("\r\n") + "\r\n");
    spy.sources.listing = { source: ctaReferenceUrl(target), capturedAt, sha256: hash(raw),
      basis: "as-traded-primary-listing-participant-eod-summary", summaryAt: stamp };
    await durableJSON(join(dir, "cta.json"), { source: ctaReferenceUrl(target), capturedAt, sha256: hash(raw) });
    await writeFile(join(dir, "cta-" + hash(raw) + ".csv.gz"), gzipSync(raw), { mode: 0o600 });
    const native = JSON.parse(await readFile(join(dir, "QQQ-kibot.json"), "utf8"));
    await durableJSON(join(dir, "SPY-kibot.json"), { ...native, symbol: "SPY" });
    const issuer = Buffer.from(JSON.stringify([{ exDate: "09/18/2026", dividend: "1.888834", shortTeamCapital: "-", longTeamCapital: "-" }]));
    spy.sources.issuer = { source: ETF_CASH_SOURCES.SPY, capturedAt: at, sha256: hash(issuer), targetExDates: [] };
    await durableJSON(join(dir, "issuer-SPY.json"), { url: ETF_CASH_SOURCES.SPY, capturedAt: at, sha256: hash(issuer) });
    await writeFile(join(dir, "issuer-SPY.bin"), issuer, { mode: 0o600 });
    proof.sources.SPY = spy;
    const report = await evaluatePrivateAfterClose(root, target, await store(sourceDir, proof));
    assert.equal(report.qualified, 2, JSON.stringify(report.pending));
    table.headers.close = "NOCP";
    await nasdaq();
    const partial = await evaluatePrivateAfterClose(root, target, await store(sourceDir, proof));
    assert.equal(partial.qualified, 1); assert.ok(partial.pending.some(m => m.instrument === "QQQ"));
    spy.sources.listing.summaryAt = "2026-11-18T01:00:22.120Z";
    assert.equal((await evaluatePrivateAfterClose(root, target, await store(sourceDir, proof))).qualified, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a dated raw-source directory settles with the canonical pre-open receipt and no previous-day or parallel bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-kibot-sourcedir-"));
  try {
    await symlink(new URL("../scripts", import.meta.url), join(root, "scripts"));
    const sourceRoot = join(root, "original-captures"), ownerDir = join(sourceRoot, "sources");
    const { proof } = await syntheticSources(root, sourceRoot, target, first, false);
    const result = await evaluatePrivateAfterClose(root, target, { sources: ownerDir });
    assert.deepEqual([result.qualified, result.added, result.called], [1, 1, 0]);
    const dir = join(root, ".consensus/private-kibot/after-close", target);
    const row = JSON.parse(await readFile(join(dir, "QQQ.json"), "utf8"));
    const artifact = JSON.parse(await readFile(join(dir, target + "-" + row.proofDigest + ".json"), "utf8"));
    assert.equal(artifact.sources.QQQ.asTraded.length, 1);
    assert.equal(artifact.sources.QQQ.asTraded[0].session, target);
    assert.deepEqual(artifact.sources.QQQ.sources.issuer, proof.sources.QQQ!.sources.issuer);
    assert.ok(!artifact.pin);
    assert.equal(result.preopenObservedAt, proof.pin?.publiclyObservedAt);
    assert.equal((await evaluatePrivateAfterClose(root, target, { sources: ownerDir })).added, 0);
    const savedEdition = edition(target), at = new Date().toISOString();
    const report = await verifiedPrivateSession(root, [savedEdition], target, savedEdition.engineVersion, at);
    const settled = report.funds.filter(fund => fund.status === "resolved");
    assert.deepEqual(settled.map(fund => [fund.instrument, fund.actualDirection, fund.returnPct]), [["QQQ", "up", row.returnPct]]);
    const counted = summarizePrivateSessions([report, structuredClone(report)], first);
    assert.equal(counted.through, target); assert.equal(counted.selected, 1);
    assert.deepEqual(counted.selections, [{ session: target, edition: savedEdition.id, instrument: "QQQ", inputEligible: settled[0].inputEligible }]);
    assert.equal(counted.daily.find(fund => fund.instrument === "QQQ")?.sessions, 1);
    const qqq = report.funds.find(fund => fund.instrument === "QQQ")!;
    const conflicting = { ...report, funds: [{ ...qqq, actualDirection: "down" }] };
    assert.throws(() => summarizePrivateSessions([report, conflicting], first), /disagree/);
    const template = JSON.parse(await readFile(new URL("../public/consensus/kibot-research.json", import.meta.url), "utf8"));
    const previous = { ...template, through: target, daily: counted.daily };
    const identity = { aggregateSha256: digest(previous), identitiesSha256: digest(counted.identities), identities: counted.identities };
    verifyPreviousResearchSessions(previous, identity, [report], counted);
    for (const [replacement, requiredReceipt, reason] of [
      ["2026-11-18", null, /previously published/], [first, identity, /previously counted/],
    ] as const) {
      const different = [{ ...report, session: replacement }];
      assert.throws(() => verifyPreviousResearchSessions(previous, requiredReceipt, different, summarizePrivateSessions(different, target)), reason);
    }
    const filename = join(dir, "QQQ.json");
    await durableJSON(filename, { ...row, returnPct: -3 });
    await assert.rejects(verifiedPrivateSession(root, [savedEdition], target, savedEdition.engineVersion, at), /reviewed prices/);
    await durableJSON(filename, { ...row, retrospective: true });
    const historical = await verifiedPrivateSession(root, [savedEdition], target, savedEdition.engineVersion, at);
    assert.equal(summarizePrivateSessions([historical], first).selected, 0);
    await durableJSON(filename, row);
    await rename(join(root, ".consensus/private-preopen", target), join(root, ".consensus/private-preopen", "unavailable"));
    await assert.rejects(verifiedPrivateSession(root, [savedEdition], target, savedEdition.engineVersion, at), /No pre-open/);
    await assert.rejects(evaluatePrivateAfterClose(root, target, { sources: ownerDir }), /No pre-open/);
    await assert.rejects(evaluatePrivateAfterClose(root, target, await store(sourceRoot, proof)), /No pre-open/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an ex-date return records the actual arrival time of the independent prior-close evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-kibot-exdate-clock-"));
  try {
    await symlink(new URL("../scripts", import.meta.url), join(root, "scripts"));
    const sourceRoot = join(root, "captures");
    const before = await syntheticSources(root, sourceRoot, first, "2026-11-13", false);
    await syntheticSources(root, sourceRoot, target, first, true);
    const file = join(before.dir, "QQQ-kibot.json"), original = JSON.parse(await readFile(file, "utf8"));
    const late = "2026-11-18T05:17:20.000Z";
    await durableJSON(file, { ...original, capturedAt: late });
    const state = await evaluatePrivateAfterClose(root, target, { sources: join(sourceRoot, "sources") });
    assert.equal(state.qualified, 1); assert.equal(state.allInputsCapturedOnSessionDate, 0);
    const record = JSON.parse(await readFile(join(root, ".consensus/private-kibot/after-close", target, "QQQ.json"), "utf8"));
    assert.equal(record.observedAt, late);
    assert.equal(record.cashBoundary.native.capturedAt, late);
    assert.equal(record.cashBoundary.native.sha256, original.sha256);
    const at = new Date().toISOString(), issued = edition(target);
    const read = () => verifiedPrivateSession(root, [issued], target, issued.engineVersion, at);
    assert.equal((await read()).funds.filter(fund => fund.status === "resolved").length, 1);
    const outcomeDir = join(root, ".consensus/private-kibot/after-close", target), filename = join(outcomeDir, "QQQ.json");
    const altered = structuredClone(record);
    altered.cashBoundary.native.sha256 = "b".repeat(64);
    await durableJSON(filename, altered);
    await assert.rejects(read(), /reviewed prices/);
    // Older external proofs did not always contain prior-session hashes. Recover them independently from the original files.
    const legacy = JSON.parse(await readFile(join(outcomeDir, target + "-" + record.proofDigest + ".json"), "utf8"));
    delete legacy.sources.QQQ.cashBoundary;
    await durableJSON(join(outcomeDir, target + "-" + digest(legacy) + ".json"), legacy, true);
    await durableJSON(filename, { ...record, proofDigest: digest(legacy) });
    await symlink(join(sourceRoot, "sources"), join(root, ".consensus/private-kibot/sources"));
    assert.equal((await read()).funds.filter(fund => fund.status === "resolved").length, 1);
    await durableJSON(filename, { ...altered, proofDigest: digest(legacy) });
    await assert.rejects(read(), /reviewed prices/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the exact-date collector saves the independent witness while Kibot is late and reuses each successful capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-kibot-capture-"));
  try {
    await symlink(new URL("../scripts", import.meta.url), join(root, "scripts"));
    const sourceRoot = join(root, "captures");
    const { dir } = await syntheticSources(root, sourceRoot, target, first, false);
    await rename(join(dir, "stocklake-QQQ.json"), join(root, "retired-test-stocklake.json"));
    await rename(join(dir, "QQQ-kibot.json"), join(root, "retired-test-native.json"));
    let native = 0, nasdaq = 0;
    const read = retainedSessionWitnesses(root, join(sourceRoot, "sources"), target, true, async input => {
      const url = new URL(String(input));
      if (url.origin === "https://api.kibot.com") {
        assert.equal(url.searchParams.get("symbol"), "QQQ");
        assert.equal(url.searchParams.get("unadjusted"), "1");
        assert.equal(url.searchParams.get("startdate"), "11/17/2026"); assert.equal(url.searchParams.get("enddate"), "11/17/2026");
        native++;
        return new Response(native === 1 ? "No data found for the specified period" : "11/17/2026,100,102,99,101,2500\n");
      }
      assert.equal(url.href, nasdaqDaily("QQQ", target)); nasdaq++;
      return Response.json({ status: { rCode: 200 }, data: { symbol: "QQQ", tradesTable: {
        headers: { date: "Date", open: "Open", close: "Close/Last", low: "Low", high: "High" },
        rows: [{ date: "11/17/2026", open: "$100", close: "$101", low: "$99", high: "$102" }],
      } } });
    });
    await assert.rejects(read("QQQ"), /no completed sessions/);
    await access(join(dir, "QQQ-daily.json"));
    await assert.rejects(access(join(dir, "QQQ-kibot.json")));
    const complete = await read("QQQ");
    assert.equal(complete.asTraded[0].session, target); assert.deepEqual(complete.asTraded, complete.selectedBars);
    assert.deepEqual(await read("QQQ"), complete);
    assert.deepEqual([native, nasdaq], [2, 1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a published Nasdaq historical pair retains its field definition", () => {
  const row = fund(target, first);
  row.sources.historical = { ...row.sources.secondary!, source: nasdaqDaily("QQQ", target), basis: "Nasdaq historical Open and Close/Last" };
  const selected = reviewedFund(row, "QQQ", target, first, edition(target), now);
  assert.equal(selected.sources.independent.basis, "Nasdaq historical Open and Close/Last");
  row.sources.historical.source = nasdaqDaily("TLT", target);
  assert.throws(() => reviewedFund(row, "QQQ", target, first, edition(target), now), /Nasdaq/);
});
