import test from "node:test";
import assert from "node:assert/strict";
import { addTicRelease, currentTicRelease, latestTicReleaseLink, parseTicRelease, validateTicRelease } from "../lib/consensus/tic-release.ts";
import { collectCapital } from "../lib/consensus/capital.ts";

const names = [
  "Gross U.S. Sales of Domestic U.S. Securities", "Gross U.S. Purchases of Domestic U.S. Securities",
  "Domestic Securities, net U.S. sales (line 1 less line 2) /1", "Private, net /2",
  "Treasury Bonds &amp; Notes, net", "Gov't Agency Bonds, net", "Corporate Bonds, net", "Equities, net",
  "Official, net /3", "Treasury Bonds &amp; Notes, net", "Gov't Agency Bonds, net", "Corporate Bonds, net", "Equities, net",
];
const values = [150, 100, 50, 38, 14, 4, 8, 12, 12, -1, 3, 4, 6];
const row = (cells: (number | string)[]) => "<tr>" + cells.map(c => "<td>" + c + "</td>").join("") + "</tr>";
const table = "<table>" + row(["TIC Monthly Reports on Cross-Border Financial Flows"]) +
  row(["(Billions of dollars, not seasonally adjusted)"]) + row(["12 Months Through"]) +
  row(["2024", "2025", "Sep-25", "Sep-26", "Jun", "Jul", "Aug", "Sep"]) +
  names.map((name, i) => row([i + 1, "", name, 901, 902, 903, 904, 905, 906, 907, values[i]])).join("") + "</table>";
const original = "<time datetime=2026-11-18T21:00:00Z>November 18, 2026</time>" +
  "<p>The U.S. Department of the Treasury today released Treasury International Capital (TIC) data for September 2026.</p>" + table;

test("TIC original uses the current-month column, signs and Washington release clock", () => {
  const result = parseTicRelease(original);
  assert.equal(result.observationMonth, "2026-09");
  assert.equal(result.releasedAt, "2026-11-18T21:00:00.000Z");
  assert.deepEqual([result.grossForeignPurchases, result.grossForeignSales, result.netAll,
    result.netTreasuryPrivate, result.netTreasuryOfficial], [150, 100, 50, 14, -1]);
  for (const wrong of [
    original.replace("Sep-26", "Sep-25"), original.replace("Official, net", "Private, net"),
    original.replace("<td>-1</td>", "<td>7</td>"), original.replace("Billions", "Millions"),
    original.replace("<td>Sep</td>", "<td>Oct</td>"),
    original.replace("2026-11-18T21:00:00Z", "2026-11-19T21:00:00Z"),
  ]) assert.throws(() => parseTicRelease(wrong));
});
test("Treasury discovery follows the named domestic monthly release", () => {
  const good = '<a href=/news/press-releases/sb0693/>Treasury International Capital Data for September</a>';
  assert.equal(latestTicReleaseLink('<a href=/other>Press releases</a>' + good), "https://home.treasury.gov/news/press-releases/sb0693");
  assert.throws(() => latestTicReleaseLink(good.replace("href=/", "href=https://other.example/")));
});

test("the independently dated original enriches only the matching rolling Treasury balance", async () => {
  const now = "2026-11-18T22:05:00.000Z";
  const read = async (url: string) => ({
    retrievedAt: now, sha256: "a".repeat(64),
    text: url.includes("?title=") ? '<a href="/news/press-releases/sb0693">Treasury International Capital Data for September</a>' :
      url.includes("/news/press-releases/") ? original : "Millions of dollars\ncountry\tcountry_code\tdate\tfor_lt_treas_net\tfor_lt_treas_pos\tfor_lt_treas_valchg\nGrand Total\t99996\t2026-09\t13008\t50000\t400",
  });
  const evidence = await currentTicRelease(read);
  const sources = await collectCapital(read);
  const enriched = sources.find(s => s.ticRelease)!;
  assert.equal(sources.length, 6);
  assert.equal(enriched.id, "tic-for_lt_treas");
  assert.equal(enriched.source.releasedAt, null);
  assert.equal(enriched.ticRelease?.releasedAt, "2026-11-18T21:00:00.000Z");
  assert.deepEqual(enriched.metrics.slice(-2).map(m => m.value), [14, -1]);
  validateTicRelease(enriched, now);
  for (const wrong of [
    { ...enriched, id: "tic-for_lt_agcy" },
    { ...enriched, scores: { ...enriched.scores, daily: 1 } },
    { ...enriched, ticRelease: { ...evidence, unreviewedField: true } },
    { ...enriched, ticRelease: { ...evidence, releasedAt: "2026-11-18T08:00:00.000Z" } },
  ]) assert.throws(() => validateTicRelease(wrong, now));
  const older = { ...enriched, ticRelease: undefined, metrics: enriched.metrics.slice(0, -2),
    series: [{ date: "2026-09-30", value: 15 }] };
  assert.equal(addTicRelease(older, evidence), older);
  assert.throws(() => validateTicRelease(enriched, "2026-11-18T21:59:00.000Z"));
});
