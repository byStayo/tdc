import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectFollowingDigest, xSearchQueries } from "../scripts/collect-following-feeds.ts";
import { runCapturedSocialBenchmark } from "../scripts/validate-social-private.ts";
import { startNativeAnnotationCapture } from "../lib/consensus/social-annotation-capture.ts";
import { privateIdentifier } from "../lib/consensus/bluesky.ts";

const cutoff = "2026-11-24T12:59:45.000Z";
const collected = "2026-11-24T13:00:00.000Z";
const posted = "2026-11-24T12:15:00.000Z";
const expires = "2026-11-25T12:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const funds = Object.keys(xSearchQueries) as (keyof typeof xSearchQueries)[];
const count = 11;
const igId = (index: number) => String(70238711 + index);
const xId = (index: number) => String(54267122 + index);
const handle = (index: number) => "fixturepanel" + index;
async function consent(root: string, platform: "x" | "instagram") {
  const dir = join(root, platform);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const evidence = "Synthetic permission fixture for separate private annotation.";
  await writeFile(join(dir, "permission-evidence.bin"), evidence, { mode: 0o600 });
  const grant = { version: 1, platform, scope: "private-independent-language-annotation", ownerActivated: true,
    activatedAt: "2026-11-24T10:00:00.000Z", expiresAt: expires, evidenceSha256: hash(evidence),
    privateTextFor24h: true, privateAggregateEvaluation: true,
    approvedAccountHashes: platform === "instagram" ? Array.from({ length: 10 }, (_, i) => privateIdentifier(igId(i))) : [],
    ...(platform === "instagram" && { instagramAccountBindings: Array.from({ length: 10 }, (_, i) => ({
      handleHash: privateIdentifier(handle(i)), accountHash: privateIdentifier(igId(i)),
    })) }),
    excludedAccountHashes: platform === "x" ? [privateIdentifier(xId(10))] : [], excludedPostHashes: [] };
  await writeFile(join(dir, "permission.json"), JSON.stringify(grant), { mode: 0o600 });
}

test("granted daily provider reads yield private blind packets without another request, and withdrawals prevent reuse", async t => {
  const parent = await mkdtemp(join(tmpdir(), "daily-social-capture-"));
  try {
    const project = join(parent, "project"), outside = join(parent, "outside");
    await mkdir(join(project, ".editorial"), { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await Promise.all([consent(outside, "x"), consent(outside, "instagram")]);
    let xCalls = 0, igCalls = 0, asksForMediaIds = 0;
    t.mock.method(globalThis, "fetch", async (url: string) => {
      const target = new URL(url);
      if (target.host === "api.x.com") {
        xCalls++;
        const [instrument] = Object.entries(xSearchQueries).find(([, terms]) => target.searchParams.get("query")!.startsWith(terms))!;
        const data = Array.from({ length: count }, (_, i) => ({
          id: String(900000001 + 20*funds.indexOf(instrument as keyof typeof xSearchQueries) + i), author_id: xId(i), lang: "en", created_at: posted,
          text: "truncated", note_tweet: { text: "Synthetic post " + i + ". $" + instrument + " will fall." },
        }));
        return Response.json({ meta: { result_count: count }, data, includes: { users: data.map(x => ({ id: x.author_id, protected: false })) } });
      }
      if (target.host === "graph.facebook.com") {
        igCalls++;
        const fields = target.searchParams.get("fields")!, name = /username\((fixturepanel\d+)\)/.exec(fields)![1];
        const index = Number(name.slice("fixturepanel".length));
        if (fields.includes("media.limit(10){id,caption,timestamp}")) asksForMediaIds++;
        return Response.json({ business_discovery: { id: igId(index), username: name,
          media: { data: funds.map((symbol, n) => ({ id: String(730000000+10*index+n), timestamp: posted,
            caption: "Native fixture " + index + ". #" + symbol + " will rise." })) } } });
      }
      return new Response("<rss><channel></channel></rss>");
    });
    const config = { xPublic: { bearerToken: "test-only" }, instagram: { graphVersion: "v24.0", token: "test-only",
      accountId: "8087782", handles: Array.from({ length: count }, (_, i) => handle(i)) } };
    const bridge = { folder: outside, clock: () => collected };
    const first = await collectFollowingDigest(project, config, false, cutoff, bridge);
    assert.deepEqual([xCalls, igCalls, asksForMediaIds], [5, 11, 10]);
    assert.deepEqual(first.annotations, { x: "ready_for_independent_labels", instagram: "ready_for_independent_labels" });
    const digest = await readFile(join(project, ".editorial/following-digest.json"), "utf8");
    assert.doesNotMatch(digest, /Synthetic post|Native fixture|test-only|fixturepanel|ready_for_independent_labels/);
    for (const platform of ["x", "instagram"] as const) {
      const dir = join(outside, platform), packetPath = join(dir, "packet.json");
      const packet = JSON.parse(await readFile(packetPath, "utf8"));
      const proof = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
      assert.equal(proof.sourcePages.length, platform === "x" ? 5 : 10);
      assert.equal(packet.expiresAt, expires);
      assert.equal((await stat(packetPath)).mode & 0o777, 0o600);
      assert.doesNotMatch(JSON.stringify(proof), /Synthetic post|Native fixture|fixturepanel|test-only|54267122|70238711|900000001/);
      assert.ok(packet.items.every((item: {expected: unknown}) => item.expected === null));
      const blank = await runCapturedSocialBenchmark(outside, platform, false, () => collected);
      assert.ok("results" in blank && blank.results.length === 0);
      for (const item of packet.items) item.expected = platform === "x" ? "downward" : "upward";
      await writeFile(packetPath, JSON.stringify(packet));
      const result = await runCapturedSocialBenchmark(outside, platform, false, () => collected);
      assert.ok("results" in result);
      assert.equal(result.contributorVerification, "verified-at-provider-collection");
      assert.equal(result.results.filter(group => group.group !== platform + "/MARKET").length, 5);
      assert.ok(result.results.every(group => group.rows === 10 && group.directionalPrecision === 1));
      assert.doesNotMatch(JSON.stringify(result), /Synthetic post|Native fixture|fixturepanel|[a-f0-9]{64}/);
      packet.items[0].text += "changed";
      await writeFile(packetPath, JSON.stringify(packet));
      await assert.rejects(runCapturedSocialBenchmark(outside, platform, false, () => collected), /verified source/);
    }
    const second = await collectFollowingDigest(project, config, true, cutoff, bridge);
    assert.deepEqual(second.annotations, { x: "awaiting_annotation", instagram: "awaiting_annotation" });
    assert.deepEqual([xCalls, igCalls, asksForMediaIds], [5, 22, 10]);
    assert.deepEqual(await runCapturedSocialBenchmark(outside, "instagram", true, () => collected), { status: "withdrawn" });
    assert.deepEqual((await readdir(join(outside, "instagram"))).sort(), [".editorial", "permission-evidence.bin", "permission.json", "withdrawn.json"]);
    const blocked = await startNativeAnnotationCapture(outside, "instagram", cutoff, () => collected);
    assert.equal(blocked.observe, undefined);
    assert.equal(await blocked.finish(true), "not_authorized");
    await assert.rejects(runCapturedSocialBenchmark(outside, "x", false, () => expires), /expired or withdrawn/);
    assert.deepEqual((await readdir(join(outside, "x"))).sort(), [".editorial", "permission-evidence.bin", "permission.json"]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("no independent grant, incomplete page and excessive source size fail closed without a text file", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-social-capture-"));
  try {
    const missing = await startNativeAnnotationCapture(root, "instagram", cutoff, () => collected);
    assert.equal(await missing.finish(true), "not_authorized");
    await consent(root, "x");
    const init = () => startNativeAnnotationCapture(root, "x", cutoff, () => collected);
    let capture = await init();
    capture.observe!("SPY", { errors: [{ detail: "synthetic" }], data: [], meta: { result_count: 0 } });
    assert.equal(await capture.finish(true), "source_incomplete");
    capture = await init();
    capture.observe!("SPY", { ignored: "a".repeat(4_000_001) });
    assert.equal(await capture.finish(true), "source_incomplete");
    capture = await init();
    assert.equal(await capture.finish(false), "source_incomplete");
    await writeFile(join(root, "x/permission-evidence.bin"), "amended without approval");
    assert.equal(await (await init()).finish(true), "not_authorized");
    assert.deepEqual((await readdir(join(root, "x"))).sort(), [".editorial", "permission-evidence.bin", "permission.json"]);
    await chmod(join(root, "x"), 0o755);
    await assert.rejects(init, /directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent source reads preserve the first sealed packet and a withdrawal during capture prevents a later write", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-social-capture-"));
  try {
    await consent(root, "instagram");
    const begin = () => startNativeAnnotationCapture(root, "instagram", cutoff, () => collected);
    const response = { requestedUsername: handle(0), business_discovery: { id: igId(0), username: handle(0),
      media: { data: [{ id: "9900231", timestamp: posted, caption: "$SPY will rise." }] } } };
    const rebound = await begin();
    rebound.observe!(null, { ...response, business_discovery: { ...response.business_discovery, id: igId(1) } });
    assert.equal(await rebound.finish(true), "source_incomplete");
    const damaged = await begin();
    damaged.observe!(null, { ...response, business_discovery: { ...response.business_discovery,
      media: { data: [{ timestamp: posted, caption: "$SPY will rise." }] } } });
    assert.equal(await damaged.finish(true), "source_incomplete");
    const early = await begin(), later = await begin(), inFlight = await begin();
    for (const sampler of [early, later, inFlight]) sampler.observe!(null, response);
    assert.equal(await early.finish(true), "ready_for_independent_labels");
    const original = await readFile(join(root, "instagram/packet.json"));
    assert.equal(await later.finish(true), "awaiting_annotation");
    assert.deepEqual(await readFile(join(root, "instagram/packet.json")), original);
    const orphan = join(root, "instagram/packet.json.08c390a5-cfc5-4d98-8b71-68dda6cb545c.tmp");
    await writeFile(orphan, "private synthetic interrupted write", { mode: 0o600 });
    await runCapturedSocialBenchmark(root, "instagram", true, () => collected);
    assert.equal(await inFlight.finish(true), "not_authorized");
    assert.deepEqual((await readdir(join(root, "instagram"))).sort(),
      [".editorial", "permission-evidence.bin", "permission.json", "withdrawn.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
