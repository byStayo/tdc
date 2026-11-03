import test from "node:test";
import assert from "node:assert/strict";
import { BlueskyWindow } from "../lib/consensus/bluesky.ts";
import { currentCommunity, publicCommunity, validateCommunity } from "../lib/community.ts";
const start = "2026-11-03T20:20:00.000Z", end = "2026-11-03T20:22:00.000Z";
function sample() {
  const w = new BlueskyWindow(start);
  for (let n = 0; n < 10; n++) w.ingest(JSON.stringify({ payload: { $type: "network.bsky.jetstream.subscribeEvents#commit", did: `did:plc:${String.fromCharCode(97+n).repeat(24)}`, seq: n+100, time:start, operation:"create",collection:"app.bsky.feed.post",rkey:"3abc",record:{text:"$SPY bullish",createdAt:start,langs:["en"]} } }), Date.parse(start));
  return w.finish(end, "time_limit");
}
test("only anonymous allowlisted totals can be staged, without raw/private diagnostics", () => {
  const result = publicCommunity(sample(), Date.parse(end));
  assert.equal(result.readings[0].participants, 10);
  for (const bad of ["did:", "at://", "$SPY bullish", "malformedEvents", "filters", "sourceDigest"]) assert.equal(JSON.stringify(result).includes(bad), false);
  assert.throws(() => validateCommunity({ ...result, rawText: "PRIVATE_MARKER" }));
  assert.throws(() => validateCommunity({ ...result, id: "PRIVATE_MARKER" }));
});
test("withdrawn, expired and future aggregates are unavailable without returning any prior values", () => {
  const result = publicCommunity(sample(), Date.parse(end));
  assert.equal(currentCommunity(null), null);
  assert.equal(currentCommunity(result, Date.parse(result.expiresAt)), null);
  assert.equal(currentCommunity(result, Date.parse(start)), null);
  assert.deepEqual(currentCommunity(result, Date.parse(end)), result);
  assert.throws(() => publicCommunity(sample(), Date.parse(result.expiresAt)));
});
test("rejects publication of tiny, tampered, inconsistent or mislabelled distributions", () => {
  const raw = sample(), good = publicCommunity(raw, Date.parse(end));
  assert.throws(() => publicCommunity({ ...raw, status: "insufficient_sample" }, Date.parse(end)));
  assert.throws(() => publicCommunity({ ...raw, malformedEvents: 9 }, Date.parse(end)));
  for (const mutate of [
    (v: typeof good) => { v.readings[1].instrument = "TLT"; },
    (v: typeof good) => { v.readings[1].participants = 11; },
    (v: typeof good) => { v.readings[1].distribution!.upward = 9; },
    (v: typeof good) => { v.readings[2].distribution = { upward:0,downward:0,mixed:0,unclassified:0 }; },
    (v: typeof good) => { v.expiresAt = "2026-12-03T20:22:00.000Z"; },
  ]) { const bad = structuredClone(good); mutate(bad); assert.throws(() => validateCommunity(bad)); }
});
