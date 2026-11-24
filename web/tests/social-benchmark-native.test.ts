import assert from "node:assert/strict";
import test from "node:test";
import { instagramCaptionText } from "../lib/consensus/instagram-post-text.ts";
import { collectInstagram } from "../scripts/collect-following-feeds.ts";
import { evaluateSocialCorpus } from "../scripts/validate-social-private.ts";

const collectedAt = "2026-11-19T12:00:00.000Z";
const assessedAt = "2026-11-19T13:00:00.000Z";
const expiresAt = "2026-11-20T12:00:00.000Z";
const symbols = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
const corpus = (items: unknown[]) => ({ schemaVersion: 1, collectedAt, expiresAt, items });

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
  const benchmark = evaluateSocialCorpus(corpus(symbols.flatMap(instrument =>
    handles.map((_, index) => ({
      instrument, platform: "instagram", text: caption(instrument, index),
      expected: index < 4 ? "upward" : index === 9 ? "unclassified" : "downward",
    })),
  )), assessedAt);
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
  const result = evaluateSocialCorpus(corpus(rows), assessedAt);
  assert.equal(result.inputPolicy, "native-text-v2");
  assert.deepEqual(result.results[0].expectedByPredicted, [[0, 0, 0, 0], [0, 9, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]);
  for (const invalid of [rows[0].text + "!", "$QQQ will rise.\uD800"]) {
    assert.throws(() => evaluateSocialCorpus(corpus([{ ...rows[0], text: invalid }]), assessedAt), /platform text/);
  }
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
