import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEtfFlows, ETF_FLOW_LICENSE, ETF_FLOW_URL, validateEtfFlows } from "../lib/consensus/etf-flows.ts";
import { replayFlowPeers } from "../lib/consensus/etf-flow-peers.ts";
import { etfFlowStudy, flowEligibleForSession } from "../lib/consensus/etf-flow-study.ts";
import { digest, observationDigest } from "../lib/consensus/history.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { fixture } from "./fixtures/etf-flows.ts";

const at = "2026-11-06T22:00:00.000Z";
function aggregate() {
  const sample = fixture();
  const row = (ticker: string, category: string, usd: number) => ({
    ...sample.funds[0], ticker, category, page: "https://etfiq.com/funds/" + ticker.toLowerCase(),
    flowUsd: usd, flowPctOfStartNetAssets: usd / 100_000_000,
  });
  const funds = [row("QQQ", "Stocks", 100_000_000), row("X", "Stocks", -20_000_000),
    row("Y", "Stocks", 0), row("Z", "Stocks", 30_000_000), row("TLT", "Bonds", 0),
    row("B", "Bonds", 20_000_000), row("A", "Allocation", 20_000_000),
    { ...sample.funds[3], category: "Stocks" }];
  return { ...sample, funds, total: { funds: 7, flowUsd: 150_000_000, roundTripUsd: 0, heldFunds: 1 } };
}
function reader(problem?: "date" | "mismatch" | "duplicate" | "licence", clock = at) {
  return async (url: string) => {
    const input = aggregate(), fund = url.includes("qqq.json") ? "QQQ" : "TLT";
    const broken = fund === "QQQ" ? problem : undefined;
    const row = input.funds.find(f => f.ticker === fund)!;
    const day = { d: input.asOf, navDate: "2026-11-05", flow: broken === "mismatch" ? 0 : row.flowUsd };
    const text = JSON.stringify(url === ETF_FLOW_URL ? input : {
      schemaVersion: 3, asOf: broken === "date" ? "2026-11-05" : input.asOf, ticker: fund, category: row.category,
      cite: { ...input.cite, page: row.page, license: broken === "licence" ? "unknown" : ETF_FLOW_LICENSE },
      daily: broken === "duplicate" ? [day, day] : [day], netAssets: { excludedFromEvidence: 98765432 },
    });
    return { text, sha256: createHash("sha256").update(text).digest("hex"), retrievedAt: clock };
  };
}

test("two native files fix the signed peer group, null/zero handling, first clock and next eligible day", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-flow-"));
  try {
    const rows = await collectEtfFlows(reader(), () => at, root), qqq = rows.find(s => s.id === "etfiq-flow-QQQ")!;
    const tlt = rows.find(s => s.id === "etfiq-flow-TLT")!;
    validateEtfFlows(qqq, at);
    assert.deepEqual(await replayFlowPeers(root, qqq, "QQQ", at), { candidate: 1, control: 0 });
    assert.deepEqual(await replayFlowPeers(root, tlt, "TLT", at), { candidate: 0, control: 1 });
    assert.equal(qqq.etfFlowPeers!.creations, 1);
    assert.equal(qqq.etfFlowPeers!.redemptions, 1);
    assert.equal(qqq.etfFlowPeers!.flat, 1);
    assert.ok(flowEligibleForSession(qqq, "2026-11-09"));
    assert.equal(flowEligibleForSession(qqq, "2026-11-10"), false);
    const wrongNav = structuredClone(qqq); wrongNav.etfFlowPeers!.navDate = "2026-11-04";
    assert.equal(flowEligibleForSession(wrongNav, "2026-11-09"), false);
    const later = "2026-11-08T03:00:00.000Z";
    const again = (await collectEtfFlows(reader(undefined, later), () => later, root)).find(s => s.id === qqq.id)!;
    assert.deepEqual(again.etfFlowPeers, qqq.etfFlowPeers);
    assert.throws(() => validateEtfFlows(qqq, "2026-11-06T21:59:59.999Z"));
    const file = join(root, ".consensus/private-etfiq-flow-peers/v1", qqq.source.sha256!, "aggregate.json");
    const raw = await readFile(file, "utf8");
    assert.doesNotMatch(raw, /startNetAssets|sharesOutstanding|98765432/);
    const changed = JSON.parse(raw); changed.value.peers.Stocks.find(([ticker]: [string]) => ticker === "X")[1] = 1;
    await writeFile(file, JSON.stringify(changed), { mode: 0o600 });
    await assert.rejects(replayFlowPeers(root, qqq, "QQQ", at), /differ/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an inconsistent history withholds that comparison and preserves independent fund checks and original public context", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-flow-bad-"));
  try {
    for (const invalid of ["date", "mismatch", "duplicate", "licence"] as const) {
      const rows = await collectEtfFlows(reader(invalid), () => at, root);
      const qqq = rows.find(s => s.id === "etfiq-flow-QQQ")!;
      assert.equal(qqq.etfFlowPeers, undefined); assert.equal(qqq.series[0].value, 100_000_000);
      assert.ok(rows.find(s => s.id === "etfiq-flow-TLT")!.etfFlowPeers);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("material edition identity counts changed peer flows, ignoring new download clocks and file hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-flow-edition-"));
  try {
    const data = JSON.parse(await readFile(new URL("../public/consensus/2026-11-06T17-01-48-890Z.json", import.meta.url), "utf8")) as Snapshot;
    const signals = await collectEtfFlows(reader(), () => at, root);
    const before = observationDigest({ ...data, signals });
    const qqq = signals.find(s => s.id === "etfiq-flow-QQQ")!;
    Object.assign(qqq.etfFlowPeers!, {observedThrough: "2026-11-07T03:00:00.000Z", historySha256: "b".repeat(64), seal: "c".repeat(64)});
    assert.equal(observationDigest({ ...data, signals }), before);
    qqq.etfFlowPeers!.redemptions++;
    assert.notEqual(observationDigest({ ...data, signals }), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registered flow comparisons enroll once in the public pre-open verification path and require an eligible receipt", async t => {
  const root = await mkdtemp(join(tmpdir(), "tdc-forward-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = "2027-01-11", captured = "2027-01-08T22:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2027-01-07T17:00:00.000Z") });
  await etfFlowStudy.register(root);
  t.mock.timers.setTime(Date.parse(captured));
  const signals = await collectEtfFlows(async url => {
    const doc = await reader(undefined, captured)(url);
    const text = doc.text.replaceAll("2026-11-06", "2027-01-08").replaceAll("2026-11-05", "2027-01-07");
    return { text, retrievedAt: captured, sha256: createHash("sha256").update(text).digest("hex") };
  }, () => captured, root);
  const issuedAt = day + "T13:01:00.000Z", id = issuedAt.replace(/[:.]/g, "-");
  const snapshot: Snapshot = { id, issuedAt, cutoff: issuedAt, signals, catalysts: [], sourcesAttempted: 3,
    collectionErrors: [], schemaVersion: 1, engineVersion: "consensus-rules-2.0.0", origin: "prospective" };
  const archive = Buffer.from(JSON.stringify(snapshot)), index = Buffer.from(JSON.stringify([{
    id, issuedAt, engineVersion: snapshot.engineVersion, sha256: digest(snapshot),
  }]));
  const dir = join(root, "public/consensus");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id + ".json"), archive); await writeFile(join(dir, "index.json"), index);
  await writeFile(join(dir, "outcomes.json"), "[]");
  t.mock.timers.setTime(Date.parse(day + "T13:03:00.000Z"));
  await assert.rejects(etfFlowStudy.enroll(root, day, id), /receipt/);
  await recordPreopenReceipt(root, day, id, archive, index, day + "T13:02:00.000Z");
  assert.equal((await etfFlowStudy.enroll(root, day, id)).enrolled, 2);
  await etfFlowStudy.enroll(root, day, id);
  const event = JSON.parse(await readFile(join(root, ".consensus/private-etfiq-flow-study/v1/QQQ/events", id + ".json"), "utf8"));
  assert.deepEqual([event.value.phase, event.value.id, event.value.candidate, event.value.control, event.value.prediction],
    ["train", "etfiq:QQQ:2027-01-08", 1, 0, null]);
  t.mock.timers.setTime(Date.parse(day + "T14:30:00.000Z"));
  assert.equal((await etfFlowStudy.enroll(root, day, id)).status, "outside_preopen");
});
