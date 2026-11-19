import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { xPostText } from "../lib/consensus/x-post-text.ts";
import { collectX, collectXPublic } from "../scripts/collect-following-feeds.ts";
import { runXResearch } from "../scripts/research-x-posts.ts";

const cutoff = "2026-11-19T13:00:00.000Z";
const created = "2026-11-19T12:00:00.000Z";
const preview = "$SPY bullish. …";
const privateMarker = "private-fixture-paragraph";

test("X text selection rejects malformed Unicode or non-string note text and bounds ordinary text", () => {
  assert.equal(xPostText({ text: preview, note_tweet: { text: "$SPY bullish.\uD800" } }), null);
  assert.equal(xPostText({ text: preview, note_tweet: { text: 42 } }), null);
  assert.equal(xPostText({ text: preview.padEnd(12_001) }), null);
});

function post(index: number, text: string, fields: Record<string, unknown> = {}) {
  return { id: "997012345678" + index, author_id: "998012345678" + index, lang: "en", created_at: created, text, ...fields };
}

function longPostRows() {
  const originals = Array.from({ length: 10 }, (_, index) => {
    const lead = "$SPY: will rise. " + privateMarker + " ";
    const tail = index === 9 ? ". Nasdaq-100 will fall unless the outlook changes." : ". I expect the Nasdaq-100 to fall.";
    const padding = index === 0 ? "🪐".repeat(25_000 - lead.length - tail.length) : "a".repeat(13_000);
    return post(index, preview, { note_tweet: { text: lead + padding + tail } });
  });
  const invalid = [null, [], {}, { text: "  " }, { text: "$TLT bullish.".padEnd(25_001, "a") }];
  return [
    ...originals, originals[0], post(20, "$IWM bearish."),
    ...invalid.map((note_tweet, index) => post(30 + index, "$TLT bullish.", { note_tweet })),
    post(40, "$TLT bullish.", { note_tweet: { text: "$TLT bullish." }, referenced_tweets: [{ type: "quoted" }] }),
    post(41, "$TLT bullish.", { note_tweet: { text: "$TLT bullish." }, withheld: {} }),
  ];
}

function apiPage(rows: ReturnType<typeof longPostRows>, url: URL, protectedAuthor?: string) {
  const hasNotes = url.searchParams.get("tweet.fields")?.split(",").includes("note_tweet");
  return Response.json({
    data: rows.map(row => {
      if (hasNotes) return row;
      const copy: Record<string, unknown> = { ...row };
      delete copy.note_tweet;
      return copy;
    }),
    includes: { users: rows.map(row => ({ id: row.author_id, protected: row.author_id === protectedAuthor })) },
    meta: { result_count: rows.length },
  });
}

const daily = {
  timeline: () => collectX({ userId: "123", apiKey: "fixture-key", apiSecret: "fixture-secret",
    accessToken: "fixture-token", accessSecret: "fixture-secret" }, cutoff),
  "public search": () => collectXPublic({ bearerToken: "fixture-token" }, cutoff),
};

for (const [mode, collect] of Object.entries(daily)) {
  test(`daily X ${mode} reads the late ticker and caveat from complete posts`, async t => {
    const hidden = post(42, "$TLT bullish.", { note_tweet: { text: "$TLT bullish." } });
    const rows = [...longPostRows(), hidden];
    const fields: string[][] = [];
    t.mock.method(globalThis, "fetch", async (input: string) => {
      const url = new URL(input);
      fields.push(url.searchParams.get("tweet.fields")!.split(","));
      return apiPage(rows, url, hidden.author_id);
    });
    const result = await collect();
    const reading = (instrument: string) => result.readings.find(item => item.instrument === instrument);
    assert.deepEqual(reading("QQQ"), { instrument: "QQQ", participants: 10,
      counts: { upward: 0, downward: 9, mixed: 0, unclassified: 1 } });
    assert.deepEqual(reading("SPY")?.counts, { upward: 9, downward: 0, mixed: 0, unclassified: 1 });
    assert.deepEqual(reading("IWM"), { instrument: "IWM", participants: 1, counts: null });
    assert.equal(reading("TLT")?.participants, 0);
    assert.equal(result.classifier, "x-explicit-stances-v3");
    assert.equal(result.textMethod, "x-api-note-tweet-v1");
    assert.deepEqual(fields.map(field => field.includes("note_tweet")), Array(mode === "timeline" ? 1 : 5).fill(true));
    assert.doesNotMatch(JSON.stringify(result), /fixture-|998012345678|997012345678|\$QQQ bearish/);
  });
}

async function researchOptions(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "x-posts-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { bearer: "fixture-token", directory, now: Date.parse(cutoff) + 30_000 };
}

test("X research stores full-text original and reply cohorts with distinct sampling provenance", async t => {
  const options = await researchOptions(t);
  const fields: string[][] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    const replies = url.searchParams.get("query")!.includes(" is:reply ");
    fields.push(url.searchParams.get("tweet.fields")!.split(","));
    // Repeated originals across two searches must only enter one cohort.
    const sample = fields.length <= 2 || replies ? longPostRows() : [];
    const rows = replies ? sample.map(row => ({ ...row, id: row.id + "1",
      referenced_tweets: [{ type: "replied_to" }, ...("referenced_tweets" in row ? [{ type: "quoted" }] : [])] })) : sample;
    return apiPage(rows, url);
  });

  const originals = await runXResearch(options);
  const qqq = originals.cohorts.find(row => row.instrument === "QQQ");
  assert.equal(qqq?.current_down, 9);
  assert.equal(qqq?.baseline_down, 0);
  assert.equal(originals.uniquePosts, 11);
  const replies = await runXResearch({ ...options, replies: true });
  assert.equal(replies.totalUniquePosts, 22);
  assert.equal(replies.cohorts.find(row => row.cohort === "replies" && row.instrument === "QQQ")?.current_down, 9);
  assert.ok(fields.every(field => field.includes("note_tweet")));
  assert.deepEqual([originals.textMethod, replies.textMethod], ["x-api-note-tweet-v1", "x-api-note-tweet-v1"]);

  const db = new DatabaseSync(originals.database, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT classifier, text_method FROM run").all().map(row => ({ ...row })), [
      { classifier: "x-explicit-stances-v3", text_method: "x-api-note-tweet-v1" },
      { classifier: "x-explicit-stances-v3", text_method: "x-api-note-tweet-v1" },
    ]);
    const rows = db.prepare("SELECT * FROM cohorts ORDER BY cohort, instrument").all();
    assert.deepEqual(rows.filter(row => row.instrument === "SPY").map(row =>
      [row.cohort, row.posts, row.participants, row.current_up, row.current_unclassified]),
    [["replies", 10, 10, 9, 1], ["upward_keywords", 10, 10, 9, 1]]);
    assert.deepEqual(rows.filter(row => row.instrument === "IWM").map(row =>
      [row.cohort, row.participants, row.current_down, row.current_unclassified]),
    [["replies", 1, null, null], ["upward_keywords", 1, null, null]]);
    assert.equal(rows.some(row => row.instrument === "TLT"), false);
  } finally {
    db.close();
  }
  const calls = fields.length;
  await assert.rejects(runXResearch({ ...options, replies: true }), /No eligible partial/);
  assert.equal(fields.length, calls);
  const privateOutput = JSON.stringify([originals, replies]) + (await readFile(originals.database)).toString("latin1");
  assert.doesNotMatch(privateOutput, /private-fixture-paragraph|fixture-token|997012345678|998012345678|\$SPY bullish/);
});

for (const [originalMethod, schemaChange] of [
  ["legacy preview-only run", "ALTER TABLE run DROP COLUMN text_method"],
  ["previous v2 classifier", "UPDATE run SET classifier = 'x-explicit-stances-v2'"],
]) {
  test(`X research rejects a reply supplement for a ${originalMethod} before requesting data or changing the database`, async t => {
    const options = await researchOptions(t);
    const calls = t.mock.method(globalThis, "fetch", async () => Response.json({ meta: { result_count: 0 } }));
    const original = await runXResearch(options);
    const db = new DatabaseSync(original.database);
    try {
      db.exec(schemaChange);
    } finally {
      db.close();
    }
    const before = await readFile(original.database);
    const priorCalls = calls.mock.callCount();
    await assert.rejects(runXResearch({ ...options, replies: true }), /text method or classifier/i);
    assert.equal(calls.mock.callCount(), priorCalls);
    assert.deepEqual(await readFile(original.database), before);
  });
}
