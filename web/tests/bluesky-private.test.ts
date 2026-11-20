import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, access, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrivateBluesky } from "../lib/bluesky-private.ts";
import { BlueskyWindow, privateIdentifier } from "../lib/consensus/bluesky.ts";
const actor = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const fixture = () => new BlueskyWindow("2026-11-03T20:20:00Z").finish("2026-11-03T20:22:00Z", "time_limit");
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
    await assert.rejects(runPrivateBluesky(root, { kind: "invalidate" }), /busy/);
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
    await assert.rejects(runPrivateBluesky(root, { kind: "collect" }, collect), /Unsafe/);
    await chmod(directory, 0o700);
    await writeFile(join(directory, "exclusions.json"), '{"actors":["PRIVATE_MARKER"],"records":[]}', { mode: 0o600 });
    await assert.rejects(runPrivateBluesky(root, { kind: "collect" }, collect), /Invalid private exclusions/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stages only aggregate counts and withdraws the public view on a report", async () => {
  const root = await mkdtemp(join(tmpdir(), "bluesky-staging-"));
  const start = new Date(Date.now() - 120_000).toISOString();
  const window = new BlueskyWindow(start);
  for (let n=0;n<10;n++) window.ingest(JSON.stringify({ payload: { $type:"network.bsky.jetstream.subscribeEvents#commit",did:`did:plc:${String.fromCharCode(97+n).repeat(24)}`,seq:n+1,time:start,operation:"create",collection:"app.bsky.feed.post",rkey:"record",record:{createdAt:start,langs:["en"],text:"$SPY bullish"} } }),Date.parse(start));
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
