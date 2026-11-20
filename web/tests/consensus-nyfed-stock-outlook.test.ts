import test from "node:test";
import assert from "node:assert/strict";
import {
  collectNyFedStockOutlook,
  NYFED_SCE_ATTRIBUTION,
  NYFED_SCE_INDEX,
  validateNyFedStockOutlook,
} from "../lib/consensus/nyfed-stock-outlook.ts";

const url = "https://www.newyorkfed.org/newsevents/news/research/2026/20261109";
const now = "2026-11-18T13:00:00.000Z";
const release = '<p>Findings from the October 2026Survey are:</p><ul>' +
  '<li>The mean perceived probability that U.S. stock prices will be higher 12 months from now ' +
  'decreased by 0.2 percentage point to 40.0%.</li></ul>';
const document = (text: string) => ({ text, retrievedAt: now, sha256: "b".repeat(64) });

test("retains the survey month and original release separately with publication credit", async () => {
  const called: string[] = [];
  const signal = await collectNyFedStockOutlook(async requested => {
    called.push(requested);
    return document(requested === NYFED_SCE_INDEX ? '<a href="' + new URL(url).pathname + '">Latest release</a>' : release);
  }, now);
  assert.deepEqual(called, [NYFED_SCE_INDEX, url]);
  assert.equal(signal.status, "available");
  assert.equal(signal.source.observedAt, "2026-10-31");
  assert.equal(signal.source.releasedAt, "2026-11-09");
  assert.equal(signal.source.attribution, NYFED_SCE_ATTRIBUTION);
  assert.deepEqual(signal.series, [{ date: "2026-10-31", value: 40 }]);
  assert.equal(signal.metrics[0].value, -0.2);
  assert.deepEqual(signal.directionalInstruments, []);
  assert.throws(() => validateNyFedStockOutlook({ ...signal, scores: { ...signal.scores, daily: 0.4 } }), /admission/);
});

test("fails closed on unrelated, forward-dated or ambiguous readings", async () => {
  for (const [link, body] of [
    [url.replace("20261109", "20261119"), release],
    [url.replace("www.newyorkfed.org", "example.org"), release],
    [url, release + release],
    [url, release.replace("40.0%", "140.0%")],
    [url, release.replace("October", "November")],
  ]) {
    const signal = await collectNyFedStockOutlook(async requested =>
      document(requested === NYFED_SCE_INDEX ? '<a href="' + link + '">Latest release</a>' : body), now);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.source.observedAt, null);
    assert.deepEqual(signal.series, []);
  }
});
