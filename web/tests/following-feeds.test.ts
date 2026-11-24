import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePublicationLock } from "../lib/publication-lock.ts";
import { collectFollowingDigest, collectXPublic } from "../scripts/collect-following-feeds.ts";

const cutoff = "2026-11-11T13:00:00.000Z";
const created = "2026-11-11T12:00:00.000Z";
const symbols = ["SPY", "QQQ", "IWM", "DIA", "TLT"];

test("X public search gives each ETF a bounded query and suppresses repeated and protected authors", async t => {
  const calls = t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    const query = url.searchParams.get("query")!;
    const symbol = symbols.find(item => query.includes("$" + item))!;
    const second = url.searchParams.has("next_token");
    assert.equal(url.pathname, "/2/tweets/search/recent");
    assert.equal(url.searchParams.get("start_time"), "2026-11-10T13:00:00.000Z");
    assert.equal(url.searchParams.get("end_time"), cutoff);
    assert.equal(url.searchParams.get("max_results"), "20");
    const authors = symbol === "TLT" ? ["1", "1", "2"] : Array.from({ length: 10 }, (_, index) => String(index + 10));
    return Response.json({
      data: authors.map(author_id => ({ author_id, text: "$" + symbol + " bullish", created_at: created, lang: "en" })),
      includes: { users: [...new Set(authors)].map(id => ({ id, protected: id === "2" })) },
      meta: { result_count: authors.length, next_token: second ? "NEXT2" : "NEXT1" },
    });
  });

  const result = await collectXPublic({ bearerToken: "fixture-token" }, cutoff);
  assert.equal(calls.mock.callCount(), 6);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.queries.map(query => query.pages), [1, 1, 1, 1, 2]);
  assert.deepEqual(result.readings.find(item => item.instrument === "TLT"), { instrument: "TLT", participants: 1, counts: null });
  assert.equal(result.readings.find(item => item.instrument === "SPY")?.counts?.upward, 10);
  assert.doesNotMatch(JSON.stringify(result), /fixture-token|author_id|\$SPY bullish|NEXT1/);
});

test("X public search stops on exhausted credits", async t => {
  const calls = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 402 }));
  await assert.rejects(collectXPublic({ bearerToken: "fixture-token" }, cutoff), /Source HTTP 402/);
  assert.equal(calls.mock.callCount(), 1);
});

test("X diagnostic partitions count each market participant's latest qualifying post once and suppress small reason cells", async t => {
  let guarded = 10;
  const calls = t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input), query = url.searchParams.get("query")!;
    if (query.includes("$QQQ")) assert.match(query, /"Nasdaq-100"/);
    const rows = Array.from({ length: 20 }, (_, i) => ({ author_id: String(i + 123450000),
      text: i < guarded ? "$SPY will rise?" : "$SPY volume update.", created_at: created, lang: "en" }));
    if (query.includes("$TLT")) rows[0] = { ...rows[0], text: "$SPY: will rise.", created_at: "2026-11-11T11:59:59.000Z" };
    return Response.json({ data: rows, includes: { users: rows.map(r => ({ id: r.author_id, protected: false })) }, meta: { result_count: rows.length } });
  });
  const first = await collectXPublic({ bearerToken: "fixture-token" }, cutoff);
  assert.equal(first.read, 100);
  assert.equal(first.readings[0].participants, 20);
  assert.deepEqual(first.diagnostics, { state: "all_unclassified", marketAbstentionReasons: {
    guardedContext: 10, noSingleSubject: 0, noAttachedDirection: 10 } });
  guarded = 19;
  const rare = await collectXPublic({ bearerToken: "fixture-token" }, cutoff);
  assert.deepEqual(rare.diagnostics, { state: "all_unclassified", marketAbstentionReasons: null });
  assert.equal(calls.mock.callCount(), 10);
  assert.doesNotMatch(JSON.stringify([first, rare]), /fixture-token|123450000|volume update|author_id|will rise/);
});

test("X separates an empty query, a failing page and rejected full text without exposing a small group", async t => {
  let mode = "empty";
  t.mock.method(globalThis, "fetch", async () => {
    if (mode === "empty") return Response.json({ meta: { result_count: 0 } });
    if (mode === "invalidPage") return Response.json({ data: [], meta: { result_count: 20 } });
    const rows = Array.from({ length: mode === "small" ? 2 : 10 }, (_, i) => ({ author_id: String(44000 + i),
      text: "$SPY: will rise.", note_tweet: { text: null }, lang: "en", created_at: created }));
    if (mode === "missingAuthors") return Response.json({ data: rows, meta: { result_count: rows.length } });
    return Response.json({ data: rows, includes: { users: rows.map(row => ({ id: row.author_id, protected: false })) },
      meta: { result_count: rows.length } });
  });
  for (const [input, state] of [["empty", "empty_sample"], ["invalidPage", "incomplete_source"], ["missingAuthors", "incomplete_source"],
    ["small", "no_eligible_market_participants"], ["badText", "unusable_text_observed"]]) {
    mode = input;
    const report = await collectXPublic({ bearerToken: "fixture-token" }, cutoff);
    assert.deepEqual(report.diagnostics, { state, marketAbstentionReasons: null });
    assert.equal(report.readings[0].participants, 0);
  }
});

test("an X reservation preserves its own expiry while Instagram and publications keep updating", async t => {
  const project = await mkdtemp(join(tmpdir(), "consensus-following-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const calls = { x: 0, instagram: 0, feeds: 0 };
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    if (url.hostname === "api.x.com") {
      calls.x++;
      return Response.json({ meta: { result_count: 0 } });
    }
    if (url.hostname === "graph.facebook.com") {
      calls.instagram++;
      return Response.json({ business_discovery: { id: "245", username: "testfund", media: { data: [] } } });
    }
    if (!["www.tker.co", "www.apricitas.io"].includes(url.hostname)) throw Error("Unexpected host");
    calls.feeds++;
    return new Response("<rss><channel></channel></rss>");
  });
  const config = { xPublic: { bearerToken: "test-only" },
    instagram: { graphVersion: "v25.0", accountId: "242", token: "test-only", handles: ["testfund"] } };
  const file = join(project, ".editorial", "following-digest.json");
  const first = await collectFollowingDigest(project, config, false, cutoff);
  assert.equal(first.x, "ok");
  assert.deepEqual(calls, { x: 5, instagram: 1, feeds: 2 });
  const later = "2026-11-11T17:00:00.000Z";
  const second = await collectFollowingDigest(project, config, false, later);
  assert.deepEqual(calls, { x: 5, instagram: 2, feeds: 4 });
  assert.equal(second.xCutoff, cutoff);
  const data = JSON.parse(await readFile(file, "utf8"));
  assert.equal(data.cutoff, later);
  assert.equal(data.expiresAt, "2026-11-12T13:00:00.000Z");
  assert.equal(data.x.expiresAt, data.expiresAt);
  assert.equal(data.instagram.status, "ok");
  const next = "2026-11-12T13:00:01.000Z";
  const free = await collectFollowingDigest(project, config, true, next);
  assert.equal(free.x, "skipped_free_only");
  assert.equal(free.xCutoff, null);
  assert.deepEqual(calls, { x: 5, instagram: 3, feeds: 6 });
  await collectFollowingDigest(project, config, false, next);
  assert.deepEqual(calls, { x: 10, instagram: 4, feeds: 8 });
});

test("a legacy digest can be reused for its original X window and a crashed paid attempt is never retried", async t => {
  const project = await mkdtemp(join(tmpdir(), "consensus-following-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const folder = join(project, ".editorial");
  await mkdir(folder, { mode: 0o700 });
  const file = join(folder, "following-digest.json");
  const expiresAt = "2026-11-12T13:00:00.000Z";
  await writeFile(file, JSON.stringify({ schemaVersion: 1, cutoff, expiresAt,
    x: { status: "unavailable", detail: "Source HTTP 402" } }), { mode: 0o600 });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls.push(new URL(input).hostname);
    return new Response("<rss><channel></channel></rss>");
  });
  const config = { xPublic: { bearerToken: "test-only" } };
  const reused = await collectFollowingDigest(project, config, true, "2026-11-11T15:00:00.000Z");
  assert.equal(reused.xCutoff, cutoff);
  assert.equal(JSON.parse(await readFile(file, "utf8")).x.detail, "Source HTTP 402");
  const tomorrow = "2026-11-12T14:00:00.000Z";
  await writeFile(join(folder, "following-x-attempt-2026-11-12"), tomorrow + "\n", { mode: 0o600 });
  const missing = await collectFollowingDigest(project, config, false, tomorrow);
  assert.equal(missing.x, "already_attempted");
  assert.equal(missing.xCutoff, null);
  await writeFile(file, '{"schemaVersion":');
  const restored = await collectFollowingDigest(project, config, false, tomorrow);
  assert.equal(restored.x, "already_attempted");
  assert.equal(restored.newsletters.filter(feed => feed.status === "ok").length, 2);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(host => ["www.tker.co", "www.apricitas.io"].includes(host)));
});

test("weekday preparation can own the release lock while a concurrent digest cannot reserve another X read", async t => {
  const project = await mkdtemp(join(tmpdir(), "consensus-following-lock-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const releasePublication = await acquirePublicationLock(project, "fixture-preparation");
  try {
    const releaseDigest = await acquirePublicationLock(project, "fixture-digest", "following-digest.lock");
    try {
      await assert.rejects(collectFollowingDigest(project, { xPublic: { bearerToken: "test-only" } }, false, cutoff), /lock is busy/);
      await assert.rejects(readFile(join(project, ".editorial", "following-x-attempt-2026-11-11")), { code: "ENOENT" });
    } finally {
      await releaseDigest();
    }
    t.mock.method(globalThis, "fetch", async () => new Response("<rss><channel></channel></rss>"));
    const result = await collectFollowingDigest(project, {}, true, cutoff);
    assert.equal(result.newsletters.filter(feed => feed.status === "ok").length, 2);
  } finally {
    await releasePublication();
  }
});
