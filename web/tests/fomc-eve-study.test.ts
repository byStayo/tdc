import assert from "node:assert/strict";
import test from "node:test";
import { meetingEnds, pairedEves, pairedLabels } from "../scripts/research-fomc-eve.ts";

const original2017 = [
  "January 31-February 1 (Tuesday-Wednesday)", "March 14-15 (Tuesday-Wednesday)",
  "May 2-3 (Tuesday-Wednesday)", "June 13-14 (Tuesday-Wednesday)",
  "July 25-26 (Tuesday-Wednesday)", "September 19-20 (Tuesday-Wednesday)",
  "October 31-November 1 (Tuesday-Wednesday)", "December 12-13 (Tuesday-Wednesday)",
  "January 30-31, 2018 (Tuesday-Wednesday)",
];
const release = (rows: string[]) => '<p class="article__time">June 28, 2016</p><p>The Federal Open Market Committee on Tuesday announced its tentative meeting schedule for 2017:</p>' +
  rows.map(text => '<p>' + text + '</p>').join('');

test("cross-month meetings, next January and weekday checks use the original year", () => {
  const result = meetingEnds(release(original2017), 2017, "20160628a");
  assert.equal(result.length, 8);
  assert.equal(result[0], "2017-02-01");
  assert.equal(result[6], "2017-11-01");
  assert.throws(() => meetingEnds(release(original2017.slice(1)), 2017, "20160628a"));
  assert.throws(() => meetingEnds(release(original2017.map(s => s.replaceAll("Wednesday", "Thursday"))), 2017, "20160628a"));
  assert.throws(() => meetingEnds(release(original2017), 2017, "20160627a"));
});

test("the original two-year Fed release stops before the second year's decisions", () => {
  const original = [
    ["January", 28, 29], ["March", 18, 19], ["May", 6, 7], ["June", 17, 18],
    ["July", 29, 30], ["September", 16, 17], ["October", 28, 29], ["December", 9, 10],
  ];
  const rows = original.map(([month, start, end]) =>
    '<li>Tuesday, ' + month + ' ' + start + ', and Wednesday, ' + month + ' ' + end + '</li>').join("");
  const html = '<p class="article__time">August 09, 2024</p>' +
    '<p>The Federal Open Market Committee on Friday announced its tentative meeting schedule for 2025 and 2026.</p>' +
    '<p>For 2025:</p><ul>' + rows + '</ul><p>For 2026:</p>' +
    '<ul><li>Tuesday, January 27, and Wednesday, January 28</li></ul>';
  const ends = meetingEnds(html, 2025, "20240809a");
  assert.equal(ends.length, 8);
  assert.equal(ends.at(-1), "2025-12-10");
});

test("retains the originally announced March 2020 date and drops whole half-day pairs", () => {
  const rows = pairedEves(["2020-03-18", "2024-07-05", "2024-11-07"]);
  assert.deepEqual(rows.map(x => [x.eve, x.control]), [
    ["2020-03-17", "2020-03-10"], ["2024-11-06", "2024-10-30"],
  ]);
  assert.equal(rows[1].evePrior, "2024-11-05");
  assert.equal(rows[1].controlPrior, "2024-10-29");
});

test("a price-direction disagreement drops both arms of a matched event", () => {
  const [pair] = pairedEves(["2020-03-18"]);
  const dates = [pair.eve, pair.evePrior, pair.control, pair.controlPrior];
  const rows = new Map(dates.map(day => [day, { open: 10, close: 11 }]));
  const split = new Map(rows);
  assert.equal(pairedLabels([pair], rows, split).length, 2);
  split.set(pair.controlPrior, { open: 11, close: 10 });
  assert.equal(pairedLabels([pair], rows, split).length, 0);
});
