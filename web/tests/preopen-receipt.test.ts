import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../lib/consensus/history.ts";
import { recordPreopenReceipt, verifyPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";

test("a dated public receipt survives repeat checks and cannot be reassigned to a later edition or session", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-public-receipt-"));
  try {
    const day = "2026-11-03";
    const issuedAt = "2026-11-03T13:00:31.020Z", edition = issuedAt.replace(/[:.]/g, "-");
    const snapshot = { id: edition, issuedAt, engineVersion: "test" };
    const entry = { id: edition, issuedAt, engineVersion: "test", sha256: digest(snapshot) };
    const index = Buffer.from(JSON.stringify([entry])), archive = Buffer.from(JSON.stringify(snapshot));
    const observed = "2026-11-03T14:29:48.155Z", bell = "2026-11-03T14:30:00.000Z";
    await assert.rejects(recordPreopenReceipt(root, day, edition, archive, index, bell), /pre-open window/);
    await assert.rejects(recordPreopenReceipt(root, "2026-11-04", edition, archive, index, observed), /another trading session/);
    await assert.rejects(recordPreopenReceipt(root, day, edition, archive, Buffer.from("[]"), observed), /selected public edition/);
    const [first, repeated] = await Promise.all([1, 2].map(() => recordPreopenReceipt(root, day, edition, archive, index, observed)));
    assert.deepEqual(first, repeated);
    const path = join(root, ".consensus", "private-preopen", day, edition + ".json");
    const bytes = await readFile(path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await recordPreopenReceipt(root, day, edition, archive, index, bell), first);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await verifyPreopenReceipt(root, day, edition, archive, bell), first);
    await assert.rejects(verifyPreopenReceipt(root, day, edition, Buffer.concat([archive, Buffer.from("\n")]), bell), /selected public edition/);
    await assert.rejects(verifyPreopenReceipt(root, day, edition, archive, issuedAt), /pre-open window/);
    await assert.rejects(verifyPreopenReceipt(root, day, "2026-11-03T14-00-00-000Z", archive, bell), /No pre-open/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
