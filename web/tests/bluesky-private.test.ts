import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat, access, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrivateBluesky } from "../lib/bluesky-private.ts";
import { BlueskyWindow, privateIdentifier } from "../lib/consensus/bluesky.ts";
import { BlueskyFailure, blueskyFailureReport } from "../lib/consensus/bluesky-failure.ts";
import { runPrivateBlueskyCommand } from "../scripts/collect-bluesky-private.ts";
const actor = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const fixture = () => new BlueskyWindow("2026-11-03T20:20:00Z").finish("2026-11-03T20:22:00Z", "time_limit");
function originalPost(n: number, time: string) {
  return JSON.stringify({ payload: {
    $type: "network.bsky.jetstream.subscribeEvents#commit",
    did: `did:plc:${String.fromCharCode(97 + n).repeat(24)}`,
    seq: n + 1, time, operation: "create", collection: "app.bsky.feed.post", rkey: "record",
    record: { createdAt: time, langs: ["en"], text: "$SPY bullish" },
  } });
}
test("private storage has restricted permissions, no public write, and invalidation/exclusion remove the candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "bluesky-private-"));
  try {
    const directory = join(root, ".consensus/bluesky-private"), candidate = join(directory, "candidate.json");
    await runPrivateBluesky(root, { kind: "collect" }, async () => fixture());
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(candidate)).mode & 0o777, 0o600);
    await assert.rejects(access(join(root, "public")));
    const result = await runPrivateBluesky(root, { kind: "exclude", identifier: actor });
    assert.equal(JSON.stringify(result).includes(actor), false); await assert.rejects(access(candidate));
    const exclusions = await readFile(join(directory, "exclusions.json"), "utf8");
    assert.equal(exclusions.includes(actor), false); assert.equal(JSON.parse(exclusions).actors[0], privateIdentifier(actor));
    await runPrivateBluesky(root, { kind: "collect" }, async (options) => { assert.deepEqual(options?.exclusions?.actors, [privateIdentifier(actor)]); return fixture(); });
    await runPrivateBluesky(root, { kind: "invalidate" }); await assert.rejects(access(candidate));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("collection and report handling cannot run concurrently and resurrect an invalidated sample", async () => {
  const root = await mkdtemp(join(tmpdir(), "bluesky-race-"));
  let signalStarted: () => void = () => {}, finish: () => void = () => {};
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const hold = new Promise<void>((resolve) => { finish = resolve; });
  try {
    const running = runPrivateBluesky(root, { kind: "collect" }, async () => { signalStarted(); await hold; return fixture(); });
    await started;
    await assert.rejects(runPrivateBluesky(root, { kind: "invalidate" }), { reason: "lock_busy" });
    finish(); await running;
    await runPrivateBluesky(root, { kind: "invalidate" });
    await assert.rejects(access(join(root, ".consensus/bluesky-private/candidate.json")));
  } finally { finish(); await rm(root, { recursive: true, force: true }); }
});
test("private configuration fails closed on public permissions and malformed exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "bluesky-permissions-"));
  let calls = 0;
  const collect = async () => { calls++; return fixture(); };
  try {
    await runPrivateBluesky(root, { kind: "collect" }, collect);
    const directory = join(root, ".consensus/bluesky-private");
    await chmod(directory, 0o755);
    await assert.rejects(runPrivateBluesky(root, { kind: "collect" }, collect), { reason: "private_permissions" });
    await chmod(directory, 0o700);
    await writeFile(join(directory, "exclusions.json"), '{"actors":["PRIVATE_MARKER"],"records":[]}', { mode: 0o600 });
    await assert.rejects(runPrivateBluesky(root, { kind: "collect" }, collect), { reason: "invalid_exclusions" });
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stages only aggregate counts and withdraws the public view on a report", async () => {
  const root = await mkdtemp(join(tmpdir(), "bluesky-staging-"));
  const start = new Date(Date.now() - 120_000).toISOString();
  const window = new BlueskyWindow(start);
  for (let n = 0; n < 10; n++) window.ingest(originalPost(n, start), Date.parse(start));
  const sample = window.finish(new Date().toISOString(),"time_limit");
  try {
    await runPrivateBluesky(root,{kind:"collect"},async()=>sample);
    const result = await runPrivateBluesky(root,{kind:"publish"});
    assert.equal(result.published,false);
    const path=join(root,"lib/community-current.json"), saved=JSON.parse(await readFile(path,"utf8"));
    assert.equal(saved.readings[0].participants,10);
    assert.equal(JSON.stringify(saved).includes(actor),false);
    assert.equal(saved.methodology,undefined);
    await runPrivateBluesky(root,{kind:"exclude",identifier:actor});
    assert.equal(JSON.parse(await readFile(path,"utf8")),null);
    await assert.rejects(runPrivateBluesky(root,{kind:"publish"}));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("failed weekday command preserves the prior view and expiry; the next complete mock covers exactly 14 minutes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bluesky-cursor-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = new Date(Date.now() - 120_000).toISOString();
  const earlier = new BlueskyWindow(start);
  for (let n = 0; n < 10; n++) earlier.ingest(originalPost(n, start), Date.parse(start));
  const sample = earlier.finish(new Date().toISOString(), "time_limit");
  await runPrivateBluesky(root, { kind: "collect" }, async () => sample);
  await runPrivateBluesky(root, { kind: "publish" });
  const privatePath = join(root, ".consensus/bluesky-private/candidate.json");
  const publicPath = join(root, "lib/community-current.json");
  const priorPrivate = await readFile(privatePath, "utf8");
  const priorPublic = await readFile(publicPath, "utf8");
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "error", () => {});
  let complete = false;
  let attempts = 0;
  let closes = 0;
  class CursorSocket extends EventTarget {
    constructor(endpoint: string) {
      super();
      attempts++;
      const cursor = Number(new URL(endpoint).searchParams.get("cursor")) / 1_000;
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"));
        const first = new Date(cursor + 10).toISOString();
        this.dispatchEvent(new MessageEvent("message", { data: originalPost(0, first) }));
        if (complete) {
          this.dispatchEvent(new MessageEvent("message", { data: originalPost(1, new Date(cursor + 840_000).toISOString()) }));
        } else {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ $type: "error", message: "SYNTHETIC_PRIVATE_MARKER", uri: endpoint }) }));
        }
      });
    }
    close() { closes++; }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = CursorSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  assert.equal(await runPrivateBlueskyCommand(root, ["--recent-seconds", "840"]), 1);
  assert.equal(stdout.mock.callCount(), 0);
  assert.equal(stderr.mock.callCount(), 1);
  const [message] = stderr.mock.calls[0].arguments;
  assert.deepEqual(JSON.parse(message), {
    status: "failed", reason: "provider_rejected", message: "The Bluesky stream returned an error frame.",
  });
  assert.equal(await readFile(privatePath, "utf8"), priorPrivate);
  assert.equal(await readFile(publicPath, "utf8"), priorPublic);
  const lock = JSON.parse(await readFile(join(root, ".editorial/publish.lock"), "utf8"));
  assert.ok(Number.isFinite(Date.parse(lock.releasedAt)));
  assert.equal(attempts, 1);
  assert.equal(closes, 1);

  complete = true;
  assert.equal(await runPrivateBlueskyCommand(root, ["--recent-seconds", "840"]), 0);
  assert.equal(stderr.mock.callCount(), 1);
  assert.equal(stdout.mock.callCount(), 1);
  assert.equal(JSON.parse(stdout.mock.calls[0].arguments[0]).status, "insufficient_sample");
  const stored = await readFile(privatePath, "utf8");
  const replacement = JSON.parse(stored);
  assert.equal(replacement.stopReason, "recent_window_complete");
  assert.equal(replacement.durationSeconds, 840);
  assert.equal(Date.parse(replacement.expiresAt) - Date.parse(replacement.endedAt), 24 * 60 * 60_000);
  assert.doesNotMatch(stored, /SYNTHETIC_PRIVATE_MARKER|did:plc:|\$SPY bullish|cursor=/);
  assert.equal(await readFile(publicPath, "utf8"), priorPublic);
  assert.equal(attempts, 2);
  assert.equal(closes, 2);
});

test("the CLI exits nonzero and emits only a fixed reason on invalid input", () => {
  const cli = fileURLToPath(new URL("../scripts/collect-bluesky-private.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "--SYNTHETIC_PRIVATE_MARKER"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed", reason: "invalid_arguments", message: "Invalid bounded sample options or private operation arguments.",
  });
  assert.equal(blueskyFailureReport(new Error("SYNTHETIC_PRIVATE_MARKER")).reason, "operation_failed");
  assert.deepEqual(blueskyFailureReport(new BlueskyFailure("transport", true)), {
    status: "failed", reason: "transport", message: "The Bluesky stream connection failed.", lockReleaseFailed: true,
  });
});
