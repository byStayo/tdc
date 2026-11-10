import test from "node:test";
import assert from "node:assert/strict";
import { BOC_SURVEY_INDEX, collectBocSurvey } from "../lib/consensus/boc-survey.ts";

const release = "https://www.bankofcanada.ca/2026/11/market-participants-survey-third-quarter-of-2026/";
const now = "2026-11-10T14:00:00.000Z";
const index = '<a href="' + release + '">Current</a><a href="https://other.example/2026/12/market-participants-survey-fourth-quarter-of-2026/">External</a>';
const report = '<meta name="publication_date" content="2026-11-09"/><p>Results of the third quarter 2026 survey conducted from September&nbsp;23 to October&nbsp;1, 2026.</p>' +
  '<table><caption>2.1 What is your forecast for the Bank of Canada’s policy interest rate?</caption>' +
  '<thead><tr><th></th><th>Policy interest rate (%)</th></tr><tr><th></th><th>25th percentile of responses</th><th>Median of responses</th><th>75th percentile of responses</th><th>Number of responses</th></tr></thead>' +
  '<tbody><tr><th>2026</th><td></td><td></td><td></td><td></td></tr><tr><th>October</th><td>2.25</td><td>2.25</td><td>2.25</td><td>25</td></tr>' +
  '<tr><th>December</th><td>2.25</td><td>2.50</td><td>2.50</td><td>25</td></tr></tbody></table>';
const doc = (text: string) => ({ text, retrievedAt: now, sha256: "a".repeat(64) });

test("collects the survey separately from current policy and never assigns a vote", async () => {
  const sources: string[] = [];
  const signal = await collectBocSurvey(async url => { sources.push(url); return doc(url === BOC_SURVEY_INDEX ? index : report); }, now);
  assert.deepEqual(sources, [BOC_SURVEY_INDEX, release]);
  assert.equal(signal.status, "available");
  assert.equal(signal.source.observedAt, "2026-10-01");
  assert.equal(signal.source.releasedAt, "2026-11-09");
  assert.deepEqual(signal.instruments, ["MARKET"]);
  assert.deepEqual(signal.scores, {daily: null, weekly: null, monthly: null});
  assert.deepEqual(signal.series, [{date: "2026-10-01",value:2.5}]);
  assert.match(signal.summary, /December 2026.*2\.50%.*25/);
});
test("rejects future releases, reordered headers, and inconsistent quantiles", async () => {
  for (const invalid of [
    report.replace("2026-11-09", "2026-11-11"),
    report.replace("Median of responses", "Mean of responses"),
    report.replace("<td>2.25</td><td>2.50</td>", "<td>3.25</td><td>2.50</td>"),
  ]) {
    const signal = await collectBocSurvey(async url => doc(url === BOC_SURVEY_INDEX ? index : invalid), now);
    assert.equal(signal.status, "unavailable");
    assert.deepEqual(signal.metrics, []);
  }
});
