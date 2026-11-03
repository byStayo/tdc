import test from "node:test";
import assert from "node:assert/strict";
import { BlueskyWindow, marketInstruments, languageCue, privateIdentifier, collectBlueskySample } from "../lib/consensus/bluesky.ts";
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
  assert.equal(languageCue("$SPY rally and bearish breakdown"), "mixed");
  for (const text of ["not bullish", "isn’t bullish", "could rally", "if bullish", "bullish?", '“bullish”', "earnings released", "https://example.com/bullish"]) assert.equal(languageCue(text), "unclassified", text);
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
