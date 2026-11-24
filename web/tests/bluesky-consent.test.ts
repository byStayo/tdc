import assert from "node:assert/strict";
import test from "node:test";
import { collectBlueskyConsent } from "../lib/consensus/bluesky-consent.ts";
import { privateIdentifier } from "../lib/consensus/bluesky.ts";
import { socialAnnotationTemplate } from "../lib/consensus/social-annotation-source.ts";
import { evaluateSocialCorpus } from "../scripts/validate-social-private.ts";

const capturedAt = "2026-11-24T17:00:00.000Z";
const reviewAt = "2026-11-24T18:00:00.000Z";
const expiresAt = "2026-11-24T19:00:00.000Z";
const fixtureDid = "did:plc:" + "a".repeat(24);
const originalUri = `at://${fixtureDid}/app.bsky.feed.post/3fixtureposta`;
const consentUri = `at://${fixtureDid}/app.bsky.feed.post/3fixturepostb`;
const originalCid = "bafyre" + "a".repeat(53);
const consentCid = "bafyre" + "b".repeat(53);
const grant = "For the original SPY post I am replying to, I permit The Daily Consensus to collect and show it to independent reviewers for private blind annotation and evaluation, with local storage until 2026-11-24T19:00:00Z and retention of private anonymized evaluation totals.";

function fixture() {
  const input = { schemaVersion: 1, from: "2026-11-24T15:00:00.000Z", through: "2026-11-24T16:00:00.000Z",
    entries: [{ instrument: "SPY", postUri: originalUri, consentUri }] };
  const original = { uri: originalUri, cid: originalCid, indexedAt: "2026-11-24T15:55:10.000Z",
    author: { did: fixtureDid }, record: { $type: "app.bsky.feed.post", text: "$SPY will rise. Synthetic fixture.",
      createdAt: "2026-11-24T15:55:00.000Z", langs: ["en"], reply: undefined as unknown } };
  const consent = { uri: consentUri, cid: consentCid, indexedAt: "2026-11-24T16:05:10.000Z",
    author: { did: fixtureDid }, record: { $type: "app.bsky.feed.post", text: grant, langs: ["en"],
      createdAt: "2026-11-24T16:05:00.000Z", reply: { root: { uri: originalUri, cid: originalCid },
        parent: { uri: originalUri, cid: originalCid } } } };
  return { input, original, consent };
}

function service(posts: unknown[], requests: URL[] = []): typeof fetch {
  return async (endpoint, init) => {
    const url = new URL(String(endpoint));
    requests.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    return new Response(JSON.stringify({ posts }));
  };
}

const excluded = async () => ({ actors: [], records: [] });

test("synthetic same-DID strong reply feeds the existing blind selection and deterministic recheck", async () => {
  const { input, original, consent } = fixture();
  const requests: URL[] = [];
  const saved = await collectBlueskyConsent(input, { clock: () => capturedAt, exclusions: excluded,
    fetcher: service([consent, original], requests) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].origin + requests[0].pathname, "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts");
  assert.deepEqual(new Set(requests[0].searchParams.getAll("uris")), new Set([originalUri, consentUri]));
  assert.equal(saved.approvedPosts, 1);
  assert.equal(saved.native.expiresAt, expiresAt);
  assert.match(saved.consentDigest, /^[a-f0-9]{64}$/);
  const packet = socialAnnotationTemplate(saved.native, capturedAt);
  assert.equal(packet.items.length, 1);
  assert.deepEqual(packet.items.map(x => [x.platform, x.instrument, x.expected]), [["bluesky", "SPY", null]]);
  const fields = JSON.stringify(packet);
  for (const value of [fixtureDid, originalUri, consentUri, originalCid, grant]) assert.equal(fields.includes(value), false);
  const replay = await collectBlueskyConsent(input, { clock: () => reviewAt, collectedAt: capturedAt,
    exclusions: excluded, fetcher: service([original, consent]) });
  assert.equal(replay.consentDigest, saved.consentDigest);
  assert.equal(evaluateSocialCorpus(packet, reviewAt, replay.native).suppressedGroups, 1);
  consent.cid = "bafyre" + "c".repeat(53);
  const edited = await collectBlueskyConsent(input, { clock: () => reviewAt, collectedAt: capturedAt,
    exclusions: excluded, fetcher: service([original, consent]) });
  assert.notEqual(edited.consentDigest, saved.consentDigest);
});

test("synthetic refusals, omissions and mismatched source still yield no grant", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.consent.author.did = "did:plc:" + "b".repeat(24); },
    (f: ReturnType<typeof fixture>) => { f.consent.record.reply.parent.cid = "bafyre" + "c".repeat(53); },
    (f: ReturnType<typeof fixture>) => { f.consent.record.reply.root.uri = consentUri; },
    (f: ReturnType<typeof fixture>) => { f.original.cid = "bafyre" + "c".repeat(53); },
    (f: ReturnType<typeof fixture>) => { f.original.record.reply = f.consent.record.reply; },
    (f: ReturnType<typeof fixture>) => { f.consent.record.text = "I withdraw permission."; },
    (f: ReturnType<typeof fixture>) => { f.consent.record.text += " I also permit public model use."; },
    (f: ReturnType<typeof fixture>) => { f.consent.record.text = grant.replace("19:00", "16:06"); },
    (f: ReturnType<typeof fixture>) => { f.consent.record.text = grant.replace("2026-11-24", "2026-11-26"); },
    (f: ReturnType<typeof fixture>) => { f.consent.indexedAt = "2026-11-24T17:30:00.000Z"; },
    (f: ReturnType<typeof fixture>) => { f.original.record.createdAt = "2026-11-24T14:55:00.000Z"; },
    (f: ReturnType<typeof fixture>) => { f.original.record.text = "$QQQ will rise. Synthetic fixture."; },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.consent.author, { labels: [{ val: "!no-unauthenticated" }] }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(collectBlueskyConsent(f.input, { clock: () => reviewAt, collectedAt: capturedAt,
      exclusions: excluded, fetcher: service([f.original, f.consent]) }));
  }
  const { input, original, consent } = fixture();
  for (const posts of [[original], [consent], [original, original, consent]]) {
    await assert.rejects(collectBlueskyConsent(input, { clock: () => reviewAt, collectedAt: capturedAt,
      exclusions: excluded, fetcher: service(posts) }));
  }
});

test("empty, mismatched and excluded manifests refuse before the public API, and late exclusion blocks storage", async () => {
  const { input, original, consent } = fixture();
  const requests: URL[] = [];
  const fetcher = service([original, consent], requests);
  const block = async () => ({ actors: [], records: [privateIdentifier(consentUri)] });
  for (const bad of [{ ...input, entries: [] }, { ...input, entries: [input.entries[0], input.entries[0]] },
    { ...input, from: "2026-11-22T15:00:00.000Z" },
    { ...input, entries: [{ ...input.entries[0], consentUri: "https://example.com/post" }] }]) {
    await assert.rejects(collectBlueskyConsent(bad, { clock: () => capturedAt, exclusions: excluded, fetcher }));
  }
  await assert.rejects(collectBlueskyConsent(input, { clock: () => capturedAt, exclusions: block, fetcher }));
  await assert.rejects(collectBlueskyConsent(input, { clock: () => capturedAt, exclusions: excluded, fetcher,
    expectedManifestDigest: "0".repeat(64) }), /manifest differs/);
  assert.equal(requests.length, 0);
  let checks = 0;
  await assert.rejects(collectBlueskyConsent(input, { clock: () => capturedAt, fetcher,
    exclusions: async () => ++checks === 1 ? excluded() : block() }));
  assert.equal(requests.length, 1);
});

test("the CLI gates the consent source and removes its expired fixture packet", async (t) => {
  const { mkdtemp, lstat, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const directory = await mkdtemp(join(tmpdir(), "daily-consensus-social-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packetPath = join(directory, "packet.json");
  const script = fileURLToPath(new URL("../scripts/validate-social-private.ts", import.meta.url));
  const run = (args: string[], input?: unknown) => spawnSync(process.execPath,
    ["--experimental-strip-types", script, ...args], { input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8" });
  const { original } = fixture();
  const relative = (seconds: number) => new Date(Date.now() + seconds * 1_000).toISOString();
  const from = relative(-600), through = relative(-240), collectedAt = relative(-120);
  original.record.createdAt = relative(-500);
  const manual = run(["--prepare", packetPath], { source: "bluesky-consent-appview", schemaVersion: 1, from,
    through, collectedAt, expiresAt: relative(1_200), batches: [{ instrument: "SPY", page: { posts: [original] } }] });
  assert.equal(manual.status, 1);
  assert.equal(manual.stdout, "");
  await assert.rejects(lstat(packetPath), { code: "ENOENT" });
  await writeFile(packetPath, JSON.stringify({ schemaVersion: 2, source: "bluesky-consent-appview", from, through,
    collectedAt, expiresAt: relative(-60), consentDigest: "a".repeat(64), consentManifestDigest: "b".repeat(64),
    items: [{ text: "Synthetic fixture; this is not permission." }], }), { flag: "wx", mode: 0o600 });
  const expired = run(["--bluesky-consent", packetPath]);
  assert.equal(expired.status, 1);
  assert.equal(expired.stdout, "");
  assert.equal(expired.stderr.includes(fixtureDid), false);
  await assert.rejects(lstat(packetPath), { code: "ENOENT" });
});
