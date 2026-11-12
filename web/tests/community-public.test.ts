import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
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

function committedAggregate(participants: number) {
  const value = publicCommunity(sample(), Date.parse(end));
  if (participants < 10) value.readings.forEach((row) => {
    row.participants = row.instrument === "MARKET" ? participants : 0;
    row.distribution = null;
  });
  return value;
}

test("committed aggregates below ten participants fail the public validator and current-data reader", () => {
  for (const participants of [9, 0]) {
    const value = committedAggregate(participants);
    assert.throws(() => validateCommunity(value), /Insufficient community sample/);
    assert.throws(() => currentCommunity(value, Date.parse(end)), /Insufficient community sample/);
  }
});

test("the real community GET handler withholds below-gate committed data while serving a valid control", async () => {
  for (const participants of [10, 9, 0]) {
    const value = committedAggregate(participants);
    // A fresh window and positive control prevent expiration from masking a broken gate.
    const ended = Date.now() - 1_000;
    value.startedAt = new Date(ended - 120_000).toISOString();
    value.endedAt = new Date(ended).toISOString();
    value.expiresAt = new Date(ended + 86_400_000).toISOString();
    const route = new URL("../app/api/community/route.ts", import.meta.url);
    route.searchParams.set("gate-test", String(participants));
    const fixtureURL = `test-community:aggregate-${participants}`;
    // Replace only the committed JSON import. Execute the unchanged route and validator;
    // never write a synthetic aggregate into the application or its public archives.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@/lib/community-current.json")
          return { url: fixtureURL, shortCircuit: true };
        if (specifier === "@/lib/community")
          return { url: new URL("../lib/community.ts", import.meta.url).href, shortCircuit: true };
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === fixtureURL)
          return { format: "module", source: `export default ${JSON.stringify(value)};`, shortCircuit: true };
        return nextLoad(url, context);
      },
    });
    try {
      const { GET } = await import(route.href) as { GET: () => Promise<Response> };
      const response = await GET();
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Cache-Control")!, /no-store/);
      assert.equal(body.status, participants >= 10 ? "available" : "unavailable");
      assert.deepEqual(body.sample, participants >= 10 ? value : null);
    } finally {
      hooks.deregister();
    }
  }
});
