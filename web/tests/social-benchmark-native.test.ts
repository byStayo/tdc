import assert from "node:assert/strict";
import test from "node:test";
import { privateIdentifier } from "../lib/consensus/bluesky.ts";
import { instagramCaptionText } from "../lib/consensus/instagram-post-text.ts";
import { socialAnnotationTemplate } from "../lib/consensus/social-annotation-source.ts";
import { collectInstagram } from "../scripts/collect-following-feeds.ts";
import { evaluateSocialCorpus } from "../scripts/validate-social-private.ts";

const collectedAt = "2026-11-19T12:00:00.000Z";
const assessedAt = "2026-11-19T13:00:00.000Z";
const expiresAt = "2026-11-20T12:00:00.000Z";
const symbols = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
const corpus = (items: unknown[]) => ({ schemaVersion: 1, collectedAt, expiresAt, items });

type Labelled = { instrument: string; expected: string; text: string };
function verifyNative(source: string, batches: unknown[], labels: Labelled[]) {
  const raw = { source, schemaVersion: 1, from: "2026-11-18T12:00:00.000Z", through: "2026-11-19T11:59:59.000Z", collectedAt, expiresAt, batches };
  const template = socialAnnotationTemplate(raw, assessedAt);
  for (const row of template.items) {
    row.expected = labels.find(label => row.instrument === label.instrument && row.text === label.text)?.expected ?? null;
  }
  return { template, raw, result: evaluateSocialCorpus(template, assessedAt, raw) };
}
const created = "2026-11-19T11:30:00.000Z";

test("Instagram's private benchmark and daily digest read the same native hashtags for every fund", async t => {
  const handles = Array.from({ length: 10 }, (_, index) => "fixture" + index);
  function caption(symbol: string, index: number) {
    const tag = "#" + (index % 2 ? symbol.toLowerCase() : symbol);
    if (index === 9) return tag + " will rise if the benchmark changes.";
    return "Fixture " + index + ". " + tag + (index < 4 ? " is bullish." : " will fall.");
  }
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const fields = new URL(input).searchParams.get("fields")!;
    const handle = /username\((fixture\d+)\)/.exec(fields)![1];
    const index = handles.indexOf(handle);
    return Response.json({
      business_discovery: {
        id: String(1000 + index), username: handle,
        media: { data: symbols.map(symbol => ({ caption: caption(symbol, index), timestamp: collectedAt })) },
      },
    });
  });
  const digest = await collectInstagram({ graphVersion: "v24.0", accountId: "123", token: "fixture", handles }, assessedAt);
  const labels = symbols.flatMap(instrument => handles.map((_, index) => ({
    instrument, text: caption(instrument, index), expected: index < 4 ? "upward" : index === 9 ? "unclassified" : "downward",
  })));
  const batches = labels.map((item, i) => {
    const index = i % handles.length;
    return { instrument: item.instrument, page: { requestedUsername: handles[index], business_discovery: {
      id: String(1000 + index), username: handles[index], media: { data: [{ id: String(90000+i), timestamp: created, caption: item.text }] },
    } } };
  });
  const { result: benchmark } = verifyNative("instagram-business-discovery", batches, labels);
  assert.equal(digest.status, "ok");
  assert.equal(benchmark.results.length, 5);
  for (const symbol of symbols) {
    assert.deepEqual(digest.readings.find(row => row.instrument === symbol)?.counts,
      { upward: 4, downward: 5, mixed: 0, unclassified: 1 });
    const group = benchmark.results.find(row => row.group === "instagram/" + symbol)!;
    assert.deepEqual(group.expectedByPredicted, [[4, 0, 0, 0], [0, 5, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]);
  }
  assert.doesNotMatch(JSON.stringify(benchmark), /#SPY|Fixture|fixture/);
});

test("the private benchmark reads an X call or guard at the end of a native long post", () => {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const prefix = "Sample " + index + ". ";
    const ending = index === 9 ? ". $QQQ will fall unless things change." : ". I expect the Nasdaq-100 to fall.";
    const padding = index === 0 ? "🪐".repeat(25_000 - prefix.length - ending.length) : "a".repeat(4000);
    const text = prefix + padding + ending;
    return { platform: "x", instrument: "QQQ", expected: index === 9 ? "unclassified" : "downward", text };
  });
  assert.ok(Buffer.byteLength(JSON.stringify(corpus(rows))) < 512_000);
  const users = rows.map((_, index) => ({ id: String(5000 + index), protected: false }));
  const page = { includes: { users }, data: rows.map((row, index) => ({ id: String(1500 + index),
    author_id: users[index].id, created_at: created, lang: "en", text: "preview", note_tweet: { text: row.text } })) };
  const { result } = verifyNative("x-v2", [{ instrument: "QQQ", page }], rows);
  assert.equal(result.inputPolicy, "native-contributors-v4");
  assert.deepEqual(result.results[0].expectedByPredicted, [[0, 0, 0, 0], [0, 9, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]);
  for (const invalid of [rows[0].text + "!", "$QQQ will rise.\uD800"]) {
    assert.throws(() => evaluateSocialCorpus(corpus([{ ...rows[0], text: invalid }]), assessedAt), /platform text/);
  }
});

test("native X replay preserves original text but rejects copies differing only in displayed entity spelling", () => {
  const payload = [
    ...Array.from({ length: 9 }, (_, i) => "Fixture " + i + ". S&#x26;P 500 will fall."),
    "&quot;$SPY will rise.&quot;",
    "S&amp;P 500 will rise.",
    "S&P 500 will rise.",
  ];
  const users = payload.map((_, i) => ({ id: String(9000 + i), protected: false }));
  const page = { includes: { users }, data: payload.map((text, i) => ({
    id: String(7000 + i), author_id: users[i].id, created_at: created, lang: "en", text,
  })) };
  const labels = payload.map((text, i) => ({
    text, instrument: "SPY", expected: i === 9 ? "unclassified" : "downward",
  }));
  const { result, template, raw } = verifyNative("x-v2", [{ instrument: "SPY", page }], labels);
  assert.equal(template.items.length, 10);
  assert.equal(result.classifiers.x, "x-explicit-stances-v4");
  assert.equal(result.results[0].rows, 10);
  assert.deepEqual(result.results[0].expectedByPredicted, [[0, 0, 0, 0], [0, 9, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]);
  const labelled = template.items.find(item => item.text.includes("&#x26;"))!;
  labelled.text = labelled.text.replace("&#x26;", "&");
  assert.throws(() => evaluateSocialCorpus(template, assessedAt, raw), /native source/);
});

test("the input change preserves the caption bounds, suppression, duplicate and expiry rules", () => {
  assert.equal(instagramCaptionText("ordinary #SPYware and #TLT1"), "ordinary #SPYware and #TLT1");
  const row = { platform: "instagram", instrument: "TLT", expected: "upward", text: "#TLT is bullish." };
  const result = evaluateSocialCorpus(corpus([row]), assessedAt);
  assert.equal(result.suppressedGroups, 1);
  assert.deepEqual(result.results, []);
  assert.throws(() => evaluateSocialCorpus(corpus([row, { ...row, text: row.text + " " }]), assessedAt), /Duplicate/);
  assert.throws(() => evaluateSocialCorpus(corpus([row]), expiresAt), /24-hour/);
  assert.throws(() => evaluateSocialCorpus(corpus([{ ...row, text: "a".repeat(12_001) }]), assessedAt), /platform text/);
  assert.throws(() => evaluateSocialCorpus(corpus([{ ...row, platform: "bluesky", text: "a".repeat(3001) }]), assessedAt), /platform text/);
});

test("ten different comments from one source account and anonymous legacy packets cannot qualify", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ instrument: "TLT", expected: "downward",
    platform: "x", text: "$TLT will fall. Fixture " + i }));
  const legacy = evaluateSocialCorpus(corpus(rows), assessedAt);
  assert.equal(legacy.contributorVerification, "unavailable-legacy");
  assert.deepEqual(legacy.results, []);
  const page = { includes: { users: [{ id: "5000", protected: false }] }, data: rows.map((r, index) => ({
    id: String(100 + index), author_id: "5000", created_at: new Date(Date.parse(created)+index*1000).toISOString(), lang: "en", text: r.text,
  })) };
  const { template, raw, result } = verifyNative("x-v2", [{ instrument: "TLT", page }], rows);
  assert.equal(template.items.length, 1);
  assert.equal(template.items[0].text, rows.at(-1)!.text);
  assert.equal(result.suppressedGroups, 1);
  assert.deepEqual(result.results, []);
  assert.throws(() => evaluateSocialCorpus(template, assessedAt), /Independent native source/);
  assert.throws(() => evaluateSocialCorpus({ ...template, items: rows }, assessedAt, raw), /cohort/);
  const altered = structuredClone(template);
  altered.items[0].text += "changed";
  assert.throws(() => evaluateSocialCorpus(altered, assessedAt, raw), /independent native source/);
  assert.throws(() => evaluateSocialCorpus({ ...template, expiresAt: "2026-11-20T10:00:00.000Z" }, assessedAt, raw), /cohort/);
  assert.throws(() => evaluateSocialCorpus(template, expiresAt, raw), /24-hour/);
});

test("Bluesky source author, post URI, selection and independent annotations all bind the score", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ instrument: "SPY", expected: "upward", text: "$SPY will rise. Fixture " + i }));
  const posts = rows.map((r, i) => {
    const did = "did:plc:" + "b".repeat(23) + "abcdefghij"[i];
    return { author: { did }, uri: "at://" + did + "/app.bsky.feed.post/t" + i, labels: [],
      record: { $type: "app.bsky.feed.post", text: r.text, createdAt: created, langs: ["en"] } };
  });
  const batches = [{ instrument: "SPY", page: { posts } }];
  const valid = verifyNative("bluesky-appview", batches, rows);
  assert.equal(valid.result.results[0].rows, 10);
  assert.equal(valid.result.results[0].directionalPrecision, 1);
  const fresh = socialAnnotationTemplate(valid.raw, assessedAt);
  assert.notEqual(fresh.items[0].ref, valid.template.items[0].ref);
  assert.deepEqual(evaluateSocialCorpus(fresh, assessedAt, valid.raw).results, []);
  assert.doesNotMatch(JSON.stringify(valid.template), /did:plc|at:\/\/|author|handle/);
  assert.doesNotMatch(JSON.stringify(valid.result), /at:\/\/|did:plc|Fixture|[a-f0-9]{32}/);
  const removed = structuredClone(posts);
  removed[0].author.did = posts[1].author.did;
  const filtered = verifyNative("bluesky-appview", [{ instrument: "SPY", page: { posts: removed } }], rows);
  assert.equal(filtered.template.items.length, 9);
  assert.deepEqual(filtered.result.results, []);
  assert.throws(() => evaluateSocialCorpus(valid.template, assessedAt, filtered.raw), /cohort/);
  for (const exclusions of [
    { actors: [privateIdentifier(posts[0].author.did)], records: [] },
    { actors: [], records: [privateIdentifier(posts[0].uri)] },
  ]) {
    assert.equal(socialAnnotationTemplate(valid.raw, assessedAt, undefined, exclusions).items.length, 9);
    assert.throws(() => evaluateSocialCorpus(valid.template, assessedAt, valid.raw, exclusions), /cohort/);
  }
  const duplicate = structuredClone(valid.template);
  duplicate.items[0] = duplicate.items[1];
  assert.throws(() => evaluateSocialCorpus(duplicate, assessedAt, valid.raw), /independent native source/);
});

test("cross-posts, conflicting identities, hidden accounts and author-supplied identities cannot inflate coverage", () => {
  const users = [{ id: "100", protected: false }, { id: "101", protected: false }, { id: "102", protected: true }];
  const rows = [
    { id: "801", author_id: "100", text: "$TLT will rise" }, { id: "802", author_id: "101", text: "$TLT  will rise" },
    { id: "803", author_id: "102", text: "$TLT will fall" }, { id: "804", author_id: "0100", text: "$TLT will fall again" },
  ].map(row => ({ ...row, created_at: created, lang: "en" }));
  const batches=[{ instrument: "TLT", page: { includes: { users }, data: rows } }];
  const { template, result }=verifyNative("x-v2", batches, []);
  assert.deepEqual(template.items, []);
  assert.equal(result.suppressedGroups, 1);
  rows[1].id = rows[0].id;
  assert.throws(() => verifyNative("x-v2", batches, []), /Conflicting native post/);
  const page = { includes: { users: [{ id: "100", protected: false }] }, data: [] };
  assert.throws(() => verifyNative("x-v2", [{ instrument: "TLT", page }, { instrument: "SPY",
    page: { ...page, includes: { users: [{ id: "100", protected: true }] } },
  }], []), /native visibility/);
});

test("the ordinary CLI creates a temporary private blind packet, replays originals and logs aggregates only", async () => {
  const { mkdtemp, readFile, rm, stat, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const folder = await mkdtemp(join(tmpdir(), "daily-consensus-social-"));
  try {
    const path = join(folder, "private.json"), script = fileURLToPath(new URL("../scripts/validate-social-private.ts", import.meta.url));
    const clock = Date.now();
    const at = (offset: number) => new Date(clock + offset).toISOString();
    const authors = Array.from({ length: 11 }, (_, i) => ({ id: String(4029 + i), protected: false }));
    const source = { schemaVersion: 1, source: "x-v2", from: at(-7200000), through: at(-3600000), collectedAt: at(-10000), expiresAt: at(3600000),
      batches: [{ instrument: "TLT", page: { meta: { result_count: 11 }, includes: { users: authors }, data: authors.map((a, i) => ({
        id: String(1700 + i), author_id: a.id, created_at: at(-5700000), lang: "en", text: "Private phrase " + i + ". $TLT will fall.",
      })) } }] };
    const cmd = (args: string[], input = source) =>
      spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { input: JSON.stringify(input), encoding: "utf8" });
    const first = cmd(["--prepare", path]);
    assert.equal(first.status, 0);
    assert.doesNotMatch(first.stdout, /Private phrase|4029|1700|[0-9a-f]{32}/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(cmd(["--prepare", path]).status, 1);
    const packet = JSON.parse(await readFile(path, "utf8"));
    assert.doesNotMatch(JSON.stringify(Object.keys(packet.items[0])), /username|author|account/);
    assert.ok(packet.items.every((item: {expected: unknown}) => item.expected === null));
    assert.deepEqual(JSON.parse(cmd([path]).stdout).results, []);
    for (const row of packet.items.slice(0, 10)) row.expected = "downward";
    await writeFile(path, JSON.stringify(packet));
    const evaluated = cmd([path]);
    assert.equal(evaluated.status, 0);
    const [group] = JSON.parse(evaluated.stdout).results;
    assert.deepEqual([group.rows, group.selectedContributors, group.unlabelled, group.directionalPrecision], [10, 11, 1, 1]);
    assert.doesNotMatch(evaluated.stdout, /Private phrase|4029|1700|[0-9a-f]{32}/);
    const changed = structuredClone(source);
    changed.batches[0].page.data[0].text += "changed";
    const refused = cmd([path], changed);
    assert.equal(refused.status, 1);
    assert.doesNotMatch(refused.stderr, /Private phrase|4029|1700|[0-9a-f]{32}/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
