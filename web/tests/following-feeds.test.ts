import assert from "node:assert/strict";
import test from "node:test";
import { collectXPublic } from "../scripts/collect-following-feeds.ts";

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
