import test from "node:test";
import assert from "node:assert/strict";
import { BlueskyWindow, marketInstruments, marketStances, privateIdentifier, collectBlueskySample } from "../lib/consensus/bluesky.ts";
const languageCue = (text: string, instrument: keyof ReturnType<typeof marketStances> = "MARKET") => marketStances(text)[instrument] ?? "unclassified";
const start = "2026-11-03T20:20:00.000Z";
const now = Date.parse(start) + 1000;
const did = (n = 0) => `did:plc:${String.fromCharCode(97 + n).repeat(24)}`;
function frame(n: number, text = "$SPY bullish breakout", extras: Record<string, unknown> = {}) {
  return JSON.stringify({ $type: "message", payload: { $type: "network.bsky.jetstream.subscribeEvents#commit", did: did(n), seq: n + 100, time: new Date(now).toISOString(), operation: "create", collection: "app.bsky.feed.post", rkey: "3abc", record: { createdAt: new Date(now).toISOString(), langs: ["en"], text }, ...extras } });
}
function finish(window: BlueskyWindow) { return window.finish("2026-11-03T20:22:00.000Z", "time_limit"); }
function ten() { const w = new BlueskyWindow(start); for (let n = 0; n < 10; n++) w.ingest(frame(n), now); return w; }

test("requires explicit market names/cashtags, not ordinary spy, URL or currency mentions", () => {
  assert.deepEqual(marketInstruments("a spy said bullish, $100 via https://example.com/$QQQ"), []);
  assert.deepEqual(marketInstruments("S&P 500 and $TLT, $QQQQ"), ["MARKET", "SPY", "TLT"]);
  assert.deepEqual(marketInstruments("Nasdaq 100 / Russell 2000 / Dow Jones"), ["MARKET", "QQQ", "IWM", "DIA"]);
  assert.deepEqual(marketInstruments("$SPX $NDX $RUT $DJI"), ["MARKET", "SPY", "QQQ", "IWM", "DIA"]);
  assert.deepEqual(marketInstruments("$NVDA and Treasury yields"), ["MARKET"]);
  assert.deepEqual(marketInstruments("#stockmarket"), ["MARKET"]);
  assert.deepEqual(marketInstruments("Wall Street Journal"), []);
});
test("cue categories preserve ambiguity instead of calling unknown neutral", () => {
  assert.equal(languageCue("$SPY bullish breakout"), "upward");
  assert.equal(languageCue("$SPY bearish sell-off"), "downward");
  assert.equal(languageCue("$SPY bullish and bearish"), "mixed");
  for (const text of ["not bullish", "isn’t bullish", "could rally", "if bullish", "bullish?", '“bullish”', "earnings released", "https://example.com/bullish"]) assert.equal(languageCue(text), "unclassified", text);
});
test("scopes forward-looking language to its named market and abstains on ambiguous context", () => {
  const post = "I expect $SPY to rise, but $TLT will fall tomorrow.";
  assert.equal(languageCue(post, "SPY"), "upward");
  assert.equal(languageCue(post, "TLT"), "downward");
  assert.equal(languageCue(post, "QQQ"), "unclassified");
  assert.equal(languageCue(post, "MARKET"), "mixed");
  for (const text of [
    "$SPY rallied yesterday", "$SPY bullish yesterday", "$SPY and $TLT bullish and bearish",
    "$SPY bearish? $TLT bullish?", "$SPY no longer bullish", "$SPY will rise /s",
    "$SPY falls after weak earnings", "$SPY volume rises", "Treasury yields will rise",
    "$SPY bears say $TLT will fall", "$SPY ticker mentioned; $TLT bearish",
    "If CPI falls, $SPY will rise", "Used $SPY to gain exposure", "$SPY breakout yesterday",
  ]) assert.equal(languageCue(text, "SPY"), "unclassified", text);
  assert.equal(languageCue("Treasury yields will rise", "MARKET"), "unclassified");
  assert.equal(languageCue("Bullish on $QQQ.", "QQQ"), "upward");
  assert.equal(languageCue("U.S. equities will fall.", "MARKET"), "downward");
});
test("aggregates separate ETF stances without copying a post-wide cue into either ETF", () => {
  const w = new BlueskyWindow(start);
  for (let n = 0; n < 10; n++) w.ingest(frame(n, "$SPY bullish but $TLT bearish"), now);
  const s = finish(w);
  assert.equal(s.method, "bluesky-market-stance-v2");
  assert.equal(s.readings[0].distribution?.mixed, 10);
  assert.equal(s.readings[1].distribution?.upward, 10);
  assert.equal(s.readings[5].distribution?.downward, 10);
});
test("X ticker headings and first-person calls classify while questions and conditional setups abstain", () => {
  const examples = [
    ["SPY", "$SPY — bullish. Thoughts?", "upward"],
    ["QQQ", "Bearish bias for $QQQ", "downward"],
    ["IWM", "Going long $IWM", "upward"],
    ["DIA", "$DIA bias: bearish", "downward"],
    ["TLT", "I expect $TLT higher", "upward"],
    ["TLT", "$TLT 🔴 bearish", "downward"],
  ] as const;
  for (const [instrument, text, expected] of examples)
    assert.equal(marketStances(text, "x")[instrument], expected, text);
  for (const text of ["$SPY — bullish?", "$SPY bullish above 600", "If rates rise, $SPY bearish",
    "She said $SPY bearish", "Tired of bullish $SPY takes", "$SPY rallied yesterday", "$SPY and $TLT bearish"])
    assert.equal(marketStances(text, "x").SPY ?? "unclassified", "unclassified", text);
  assert.equal(marketStances("$SPY — bullish").SPY ?? "unclassified", "unclassified");
  assert.equal(marketStances("$SPY — bullish but $TLT — bearish", "x").MARKET, "mixed");
});
test("suppresses small samples and never pools counts between instrument views", () => {
  const w = new BlueskyWindow(start);
  for (let n = 0; n < 10; n++) w.ingest(frame(n, n < 9 ? "$SPY bullish" : "$TLT bearish"), now);
  const s = finish(w);
  assert.equal(s.status, "sampled");
  assert.deepEqual(s.readings[0].distribution, { upward: 9, downward: 1, mixed: 0, unclassified: 0 });
  assert.equal(s.readings[1].participants, 9); assert.equal(s.readings[1].distribution, null);
  assert.equal(s.readings[5].participants, 1); assert.equal(s.readings[5].distribution, null);
  assert.equal(s.readings[2].participants, 0); assert.equal(s.readings[2].distribution, null);
});
test("one latest qualifying record per account limits repeated posts and duplicate delivery", () => {
  const w = ten();
  w.ingest(frame(0, "$SPY bearish", { seq: 200, rkey: "next" }), now);
  w.ingest(frame(0, "$SPY bearish", { seq: 200, rkey: "next" }), now);
  const s = finish(w);
  assert.equal(s.readings[0].participants, 10);
  assert.deepEqual(s.readings[0].distribution, { upward: 9, downward: 1, mixed: 0, unclassified: 0 });
});
test("edits, deletion tombstones and stale replay cannot preserve or resurrect old cues", () => {
  const w = ten();
  w.ingest(frame(0, "not a market post", { seq: 200, operation: "update" }), now);
  w.ingest(frame(0), now);
  w.ingest(frame(1, "", { seq: 201, operation: "delete", record: undefined }), now);
  w.ingest(frame(1), now);
  const s = finish(w);
  assert.equal(s.readings[0].participants, 8); assert.equal(s.readings[0].distribution, null);
  assert.equal(s.deletionEvents, 1);
});
test("account removal and owner exclusions suppress contributions", () => {
  const w = new BlueskyWindow(start, { actors: [privateIdentifier(did(0))], records: [privateIdentifier(`at://${did(1)}/app.bsky.feed.post/3abc`)] });
  for (let n = 0; n < 10; n++) w.ingest(frame(n), now);
  w.ingest(JSON.stringify({ payload: { $type: "network.bsky.jetstream.subscribeEvents#account", did: did(2), seq: 300, account: { active: false } } }), now);
  w.ingest(frame(2, "$SPY bullish", { seq: 301, rkey: "next" }), now);
  const s = finish(w);
  assert.equal(s.readings[0].participants, 7); assert.equal(s.accountRemovals, 1);
});
test("filters stale/foreign-language/unlabelled-language/reply/quote/self-labelled content", () => {
  const w = new BlueskyWindow(start);
  const original = { text: "$SPY bullish", createdAt: new Date(now).toISOString(), langs: ["en"] };
  const records = [
    { ...original, langs: ["fr"] }, { ...original, langs: undefined },
    { ...original, reply: {} }, { ...original, embed: { $type: "app.bsky.embed.recordWithMedia" } },
    { ...original, labels: { values: [{ val: "!no-unauthenticated" }] } },
    { ...original, createdAt: "2026-11-02T20:20:00Z" },
    { ...original, createdAt: "2026-11-04T20:20:00Z" },
  ];
  records.forEach((record, n) => w.ingest(frame(n, "", { record }), now));
  w.ingest(frame(10, "$SPY bullish", { time: "2026-11-02T20:20:00Z" }), now);
  const s = finish(w); assert.equal(s.matchedRecords, 0); assert.equal(s.status, "insufficient_sample");
});
test("saved output contains only aggregates and digest, no source text/accounts/URIs", () => {
  const w = ten(); const s = finish(w); const json = JSON.stringify(s);
  assert.equal(s.readings[1].distribution?.upward, 10);
  for (const sensitive of [did(0), "$SPY bullish breakout", "at://", "3abc", privateIdentifier(did(0))]) assert.equal(json.includes(sensitive), false);
  assert.match(s.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(s.expiresAt, "2026-11-04T20:22:00.000Z");
});
test("malformed frames are counted without including payloads in errors or output", () => {
  const w = new BlueskyWindow(start);
  w.ingest("PRIVATE_MARKER", now); w.ingest('{"payload":{"text":"PRIVATE_MARKER"}}', now);
  const s = finish(w); assert.equal(s.malformedEvents, 2); assert.equal(JSON.stringify(s).includes("PRIVATE_MARKER"), false);
});
test("bounds are checked before opening a network connection", async () => {
  for (const options of [{ seconds: 0 }, { seconds: 901 }, { maxEvents: 100001 }, { maxBytes: 10 }]) await assert.rejects(() => collectBlueskySample(options), /Invalid bounded/);
});

test("recent-cursor windows retain old in-window posts, apply tombstones and reject older content", () => {
  const w = new BlueskyWindow(start, undefined, true);
  const received = now + 12 * 60_000;
  for (let n = 0; n < 10; n++) w.ingest(frame(n), received);
  w.ingest(frame(10, "$QQQ bearish", { time: "2026-11-03T20:18:00.000Z" }), received);
  w.ingest(frame(1, "", { seq: 200, operation: "delete", record: undefined }), received);
  w.ingest(frame(1), received);
  const sample = finish(w);
  assert.equal(sample.readings[0].participants, 9);
  assert.equal(sample.readings[2].participants, 0);
  assert.equal(sample.deletionEvents, 1);
});
test("recent cursor and wall-clock sampling have distinct bounded modes", async () => {
  for (const options of [{ recentSeconds: 841 }, { recentSeconds: 59 }, { seconds: 180, recentSeconds: 840 }])
    await assert.rejects(() => collectBlueskySample(options), /Invalid bounded/);
});

test("recent cursor verifies both boundaries before returning a sample", async (t) => {
  let scenario: "complete" | "truncated" | "ignored-cursor" = "complete";
  class CursorSocket extends EventTarget {
    constructor(endpoint: string) {
      super();
      const cursor = Number(new URL(endpoint).searchParams.get("cursor")) / 1_000;
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"));
        const emit = (time: number, account: number) => {
          const stamp = new Date(time).toISOString();
          this.dispatchEvent(new MessageEvent("message", { data: frame(account, "$SPY bullish", {
            time: stamp, record: { createdAt: stamp, langs: ["en"], text: "$SPY bullish" },
          }) }));
        };
        emit(cursor + (scenario === "ignored-cursor" ? 59_000 : 10), 0);
        if (scenario === "complete") emit(cursor + 60_000, 1);
        else this.dispatchEvent(new Event("close"));
      });
    }
    close() {}
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = CursorSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const sample = await collectBlueskySample({ recentSeconds: 60 });
  assert.equal(sample.stopReason, "recent_window_complete");
  assert.equal(sample.durationSeconds, 60);
  assert.equal(sample.readings[0].participants, 1);
  scenario = "truncated";
  await assert.rejects(() => collectBlueskySample({ recentSeconds: 60 }), /unavailable/);
  scenario = "ignored-cursor";
  await assert.rejects(() => collectBlueskySample({ recentSeconds: 60 }), /unavailable/);
});
