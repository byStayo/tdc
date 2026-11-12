import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishCollectedSnapshot, publishSnapshot, verifyPublicationTree, digest, type PublicationStep } from "../lib/consensus/history.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

function edition(hour: number): Snapshot {
  const at = `2026-11-03T${hour}:00:00.000Z`;
  const signal = missingSignals(at)[0];
  return {
    schemaVersion: 1, origin: "prospective", engineVersion: "consensus-rules-1.1.0",
    id: at.replaceAll(/[:.]/g, "-"), issuedAt: at, cutoff: at,
    signals: [{ ...signal, status: "available", series: [{ date: "2026-11-02", value: hour }],
      scores: { daily: .2, weekly: .1, monthly: -.1 },
      source: { ...signal.source, observedAt: "2026-11-02", sha256: "a".repeat(64) } }],
    catalysts: [], sourcesAttempted: 1, collectionErrors: [],
  };
}
const read = async (root: string, path: string) => JSON.parse(await readFile(join(root, path), "utf8"));

test("the reviewed draft binds the exact input and predecessor while keeping actual issue time", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-reviewed-draft-"));
  try {
    const first = edition(11), draft = edition(12), issuedAt = edition(13).issuedAt;
    await publishSnapshot(root, first);
    await assert.rejects(publishCollectedSnapshot(root, draft, digest(first), first.id, issuedAt), /hash/);
    await assert.rejects(publishCollectedSnapshot(root, draft, digest(draft), first.id, edition(17).issuedAt), /recent/);
    const result = await publishCollectedSnapshot(root, draft, digest(draft), first.id, issuedAt);
    const { current } = await verifyPublicationTree(root);
    assert.equal(result.id, edition(13).id);
    assert.equal(current.issuedAt, issuedAt);
    assert.equal(current.cutoff, draft.cutoff);
    await assert.rejects(publishCollectedSnapshot(root, draft, digest(draft), first.id, issuedAt), /current edition changed/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const stage of ["archive", "index", "current"] as PublicationStep[]) {
  test(`an interruption after ${stage} recovers without overwriting an issued archive`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tdc-recovery-"));
    try {
      const first = edition(11), second = edition(12);
      await publishSnapshot(root, first);
      const firstBytes = await readFile(join(root, "public/consensus", `${first.id}.json`), "utf8");
      await assert.rejects(publishSnapshot(root, second, { afterStep(step) { if (step === stage) throw new Error("injected interruption"); } }), /injected interruption/);
      const secondBytes = await readFile(join(root, "public/consensus", `${second.id}.json`), "utf8");
      if (stage === "current") await verifyPublicationTree(root);
      else await assert.rejects(verifyPublicationTree(root), stage === "archive" ? /Unindexed/ : /Current edition differs/);
      const result = await publishSnapshot(root, second);
      assert.equal(result.changed, stage === "archive");
      const verified = await verifyPublicationTree(root);
      assert.equal(verified.current.id, second.id);
      assert.equal(verified.history.length, 2);
      assert.equal(digest(verified.current), result.sha256);
      assert.equal(await readFile(join(root, "public/consensus", `${first.id}.json`), "utf8"), firstBytes);
      assert.equal(await readFile(join(root, "public/consensus", `${second.id}.json`), "utf8"), secondBytes);
      if (stage === "archive") {
        const groups = await readdir(join(root, ".consensus/publication-quarantine"));
        assert.equal(groups.length, 1);
        assert.equal(await readFile(join(root, ".consensus/publication-quarantine", groups[0], `${second.id}.json`), "utf8"), secondBytes);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("first publication can recover a durable index when current does not yet exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-first-recovery-"));
  try {
    const snapshot = edition(11);
    await assert.rejects(publishSnapshot(root, snapshot, { afterStep(step) { if (step === "index") throw new Error("interrupted first issue"); } }), /interrupted/);
    assert.equal((await publishSnapshot(root, snapshot)).changed, false);
    assert.equal((await verifyPublicationTree(root)).history.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan and incomplete files fail the build guard and are preserved outside the public tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-orphan-"));
  try {
    const snapshot = edition(11);
    await publishSnapshot(root, snapshot);
    for (const name of ["2026-11-03T12-00-00-000Z.json", "current.json.interrupted.tmp"])
      await writeFile(join(root, "public/consensus", name), "incomplete bytes");
    await assert.rejects(verifyPublicationTree(root), /Unindexed publication files/);
    assert.equal((await publishSnapshot(root, snapshot)).changed, false);
    await verifyPublicationTree(root);
    const group = (await readdir(join(root, ".consensus/publication-quarantine")))[0];
    const manifest = await read(root, `.consensus/publication-quarantine/${group}/manifest.json`);
    assert.equal(manifest.files.length, 2);
    for (const record of manifest.files) assert.equal(await readFile(join(root, ".consensus/publication-quarantine", group, record.name), "utf8"), "incomplete bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery refuses altered indexed history or an unverified current pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-tamper-"));
  try {
    const snapshot = edition(11);
    await publishSnapshot(root, snapshot);
    const current = await read(root, "lib/consensus/current.json");
    await writeFile(join(root, "lib/consensus/current.json"), JSON.stringify({ ...current, collectionErrors: ["altered"] }));
    await assert.rejects(publishSnapshot(root, edition(12)), /not a verified indexed archive/);
    await writeFile(join(root, "lib/consensus/current.json"), JSON.stringify(current));
    const index = await read(root, "public/consensus/index.json");
    index[0].sha256 = "0".repeat(64);
    await writeFile(join(root, "public/consensus/index.json"), JSON.stringify(index));
    await assert.rejects(publishSnapshot(root, edition(12)), /Immutable history failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
