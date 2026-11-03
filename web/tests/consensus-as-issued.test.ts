import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asIssuedConsensus, freezeConsensus } from "../lib/consensus/as-issued.ts";
import { calculateConsensus } from "../lib/consensus/engine.ts";
import { FAMILIES } from "../lib/consensus/registry.ts";
import { digest, publishSnapshot, validateSnapshot } from "../lib/consensus/history.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import type { HistoryEntry, Snapshot } from "../lib/consensus/types.ts";

const read = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
// Recorded against release 7efc9d6 at each original cutoff. Future engine changes
// must not update these expected historical results or the underlying snapshots.
const legacyReadings: Record<string, string> = {
  "2026-11-03T06-28-30-460Z": "2cc6fd81cca65caef7427482320862af3c1fb0248028f096f865d13b8cd56500",
  "2026-11-03T06-49-15-231Z": "68b5d1332dfb225a46256b241782295fe2fd11436caad85514b2bdc1ee47cfc6",
  "2026-11-03T07-11-18-623Z": "0f029aff6d197a7e8c54f1608d864361f0594cecfbd665f230f9f4b451227fc1",
  "2026-11-03T07-38-08-394Z": "06d39dbb72e1410dbea441008f1ecbbde04dcf52a2b04cc54f95a97e7fefc8ee",
  "2026-11-03T07-53-00-486Z": "94d13d8247a19359908dd0725dc425b7c0923ca7301990d490e56579597587ac",
  "2026-11-03T08-12-07-599Z": "9dd11398b4b6ebdbab21b1d5e71580febe8fe20d5b3ba2f459cf74ee8893a22c",
  "2026-11-03T08-30-55-634Z": "ea485b4de3b864d50208b03e58b74e3a2b1086c0f9be108baf14ab00dc519643",
  "2026-11-03T08-48-02-469Z": "d47df5603c2c0bb1b9db9c99ee21133a270aee634c4689bfe574a3ee70735da9",
};

test("all eight legacy archives use their recorded rules and cutoff without changing their bytes", async () => {
  const index: HistoryEntry[] = await read("../public/consensus/index.json");
  assert.ok(index.length >= 8);
  for (const [id, expected] of Object.entries(legacyReadings)) {
    const entry = index.find((item) => item.id === id)!;
    assert.ok(entry);
    const snapshot: Snapshot = await read(`../public/consensus/${entry.id}.json`);
    const before = digest(snapshot);
    assert.equal(digest(INSTRUMENTS.flatMap((instrument) => HORIZONS.map((horizon) => asIssuedConsensus(snapshot, instrument, horizon)))), expected);
    assert.equal(digest(snapshot), before);
    assert.equal(before, entry.sha256);
  }
});

test("legacy readings resist both clock drift and later edits to active family weights", async () => {
  const snapshot: Snapshot = await read("../lib/consensus/current.json");
  const before = asIssuedConsensus(snapshot, "MARKET", "daily");
  assert.notDeepEqual(calculateConsensus(snapshot.signals, "MARKET", "daily", "2030-01-01T00:00:00.000Z"), before);
  const family = FAMILIES.find((f) => f.id === "earnings")!;
  const original = family.weight;
  try {
    family.weight = 100;
    assert.notDeepEqual(calculateConsensus(snapshot.signals, "MARKET", "daily", snapshot.cutoff), before);
    assert.deepEqual(asIssuedConsensus(snapshot, "MARKET", "daily"), before);
  } finally { family.weight = original; }
  assert.throws(() => asIssuedConsensus({ ...snapshot, engineVersion: "unknown" }, "SPY", "daily"), /Unsupported as-issued engine/);
});

test("new publications freeze all target results and reject altered or incomplete stored records", async () => {
  const snapshot: Snapshot = await read("../lib/consensus/current.json");
  const root = await mkdtemp(join(tmpdir(), "tdc-frozen-"));
  try {
    const publication = await publishSnapshot(root, snapshot);
    const saved: Snapshot = JSON.parse(await readFile(join(root, "public/consensus", `${snapshot.id}.json`), "utf8"));
    assert.equal(saved.consensus?.length, 18);
    assert.equal(digest(saved), publication.sha256);
    assert.equal(snapshot.consensus, undefined);
    validateSnapshot(saved);
    assert.strictEqual(asIssuedConsensus(saved, "SPY", "daily"), saved.consensus!.find((r) => r.instrument === "SPY" && r.horizon === "daily"));
    const altered = structuredClone(saved);
    altered.consensus![0].score = -0.99;
    assert.throws(() => validateSnapshot(altered), /recorded engine/);
    altered.consensus!.pop();
    assert.throws(() => validateSnapshot(altered, "archive"), /Incomplete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("archive validation tolerates earlier wording but candidate validation still verifies derivations", async () => {
  const snapshot: Snapshot = await read("../lib/consensus/current.json");
  const oldWording = structuredClone(snapshot);
  oldWording.signals.find((s) => s.id.startsWith("sec-holdings-"))!.methodology = "Earlier published wording retained exactly as issued.";
  assert.notEqual(digest(oldWording), digest(snapshot)); // Hash verification still detects an edit to an existing archive.
  assert.doesNotThrow(() => validateSnapshot(oldWording, "archive"));
  assert.throws(() => validateSnapshot(oldWording), /holdings and signal evidence disagree/);
  const next: Snapshot = { ...snapshot, id: "2026-11-04T12-00-00-000Z", issuedAt: "2026-11-04T12:00:00.000Z", cutoff: "2026-11-04T12:00:00.000Z" };
  assert.doesNotThrow(() => retainLastKnown(next, oldWording));
  const frozen = freezeConsensus(snapshot);
  assert.deepEqual(asIssuedConsensus(frozen, "SPY", "monthly"), asIssuedConsensus(snapshot, "SPY", "monthly"));
});
