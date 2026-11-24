import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectFedRetailMoney,
  parseFedRetailBalances,
  selectFedRetailRelease,
  validateFedRetailMoney,
} from "../lib/consensus/fed-retail-money.ts";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { buildH6Cohort, h6Intervals, selectReservedPrices } from "../scripts/research-h6-retail-iwm.ts";
import { readH6RetailStudy } from "../scripts/read-h6-retail-study.ts";

const release = "2026-10-27",
  readAt = "2026-11-24T14:30:00.000Z";
const index = JSON.stringify([
  {
    yearValue: "2026",
    Months: [
      { MonthValue: "202610", Dates: ["20261027"] },
      { MonthValue: "202611", Dates: ["20261124"] },
    ],
  },
]);
const rows = ["Aug. 2026", "Sept. 2026"];
function table(which: number, title: string, headers: string[], cells: string[][]) {
  const tag = "t" + which + "tg1",
    group = tag + "a2";
  const def = headers
    .map((h, i) => '<th id="' + tag + "b" + (i + 1) + '" headers="' + group + '">' + h + "</th>")
    .join("");
  const body = cells
    .map((values, i) => {
      const row = tag + "r" + i;
      return (
        '<tr><th id="' +
        row +
        '">' +
        rows[i] +
        "</th>" +
        values
          .map((v, j) => '<td headers="' + group + " " + tag + "b" + (j + 1) + " " + row + '">' + v + "</td>")
          .join("") +
        "</tr>"
      );
    })
    .join("");
  return (
    "<span>" +
    title +
    '</span><table id="' +
    tag +
    '"><thead><tr><th id="' +
    group +
    '">' +
    (which === 1 ? "Seasonally adjusted" : "M2 1") +
    "</th></tr><tr>" +
    def +
    "</tr></thead><tbody>" +
    body +
    "</tbody></table>"
  );
}
function fixture() {
  return (
    "<div>Release Date: October 27, 2026</div>" +
    table(
      1,
      "Money Stock Measures. Billions of dollars unless otherwise noted.",
      ["M1 1", "M2 2"],
      [
        ["1,000.0", "1,350.0"],
        ["1,010.0", "1,370.0"],
      ],
    ) +
    table(
      2,
      "Seasonally Adjusted Components of M1 and M2, unless otherwise noted. Billions of dollars.",
      [
        "M1 2",
        "Small- <br>denomination time deposits 6",
        "Retail money <br>market funds",
        "Less: Total IRA and Keogh account balances (NSA) 7",
      ],
      [
        ["1,000.0", "200.0", "250.0", "100.0"],
        ["1,010.0", "210.0", "255.0", "105.0 e"],
      ],
    )
  );
}
const mock =
  (page = fixture()) =>
  async (address: string) =>
    new Response(address.endsWith("releaseDates.json") ? index : page);
test("the catalog enforces the documented New York release time before selecting a dated original", () => {
  assert.equal(selectFedRetailRelease(index, "2026-11-24T17:59:59.999Z"), release);
  assert.equal(selectFedRetailRelease(index, "2026-11-24T18:00:00.000Z"), "2026-11-24");
  assert.throws(() => selectFedRetailRelease(index.replace('"20261124"', '"20261124","20261124"'), readAt));
  assert.throws(() => selectFedRetailRelease(index, "2026-07-01T18:00:00.000Z"));
});
test("both original months reconcile small deposits and gross retail balances to the separate unadjusted retirement deduction", () => {
  const s = parseFedRetailBalances(fixture(), release);
  assert.equal(s.current.retail, 2550);
  assert.equal(s.current.retirementEstimated, true);
  assert.equal(s.previous.retirementEstimated, false);
  for (const broken of [
    fixture().replace("1,370.0", "1,399.0"),
    fixture().replace("(NSA)", "(SA)"),
    fixture().replaceAll("Sept. 2026", "Oct. 2026"),
    fixture().replace("October 27", "October 26"),
    fixture().replace("t1tg1a2 t1tg1b1 t1tg1r1", "t1tg1a3 t1tg1b1 t1tg1r1"),
  ])
    assert.throws(() => parseFedRetailBalances(broken, release));
});
test("current-only context preserves first verification and distinguishes native corrections, tamper, transport and scoring", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "h6-current-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signal = await collectFedRetailMoney(mock(), () => readAt, root);
  assert.equal(signal.status, "available", signal.collectionNote);
  validateFedRetailMoney(signal, readAt);
  assert.deepEqual(
    signal.metrics.map((m) => m.value),
    [255, 5, 210, 10, 105],
  );
  assert.deepEqual(signal.directionalInstruments, []);
  const later = "2026-11-24T15:10:00.000Z";
  const replay = await collectFedRetailMoney(mock(), () => later, root);
  assert.equal(replay.fedRetailMoney!.firstVerifiedAt, readAt);
  assert.throws(() => validateFedRetailMoney({ ...signal, id: "another-source" }, later));
  assert.throws(() => validateFedRetailMoney({ ...signal, scores: { ...signal.scores, daily: 0 } }, later));
  assert.throws(() => validateFedRetailMoney({ ...signal, series: [] }, later));
  assert.throws(() => validateFedRetailMoney(signal, "2026-11-24T14:29:59.999Z"));
  const revision = fixture().replace("255.0", "256.0").replace("1,370.0", "1,371.0");
  const changed = await collectFedRetailMoney(mock(revision), () => later, root);
  assert.equal(changed.status, "unavailable");
  assert.equal(changed.failureKind, "validation");
  const path = join(root, "h6-" + release + ".json"),
    broken = JSON.parse(await readFile(path, "utf8"));
  broken.original.sha256 = "0".repeat(64);
  await writeFile(path, JSON.stringify(broken));
  const invalid = await collectFedRetailMoney(mock(), () => later, root);
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.failureKind, "validation");
  const outage = await collectFedRetailMoney(
    async () => {
      throw new Error("internal-sensitive-message");
    },
    () => later,
  );
  assert.equal(outage.failureKind, "transport");
  assert(!JSON.stringify(outage).includes("internal-sensitive-message"));
  validateFedRetailMoney(outage, later);
});
function event(month: string, period: string, release: string, prior: string) {
  return {
    month,
    period,
    release,
    previousOriginal: { day: prior, latest: "2017-01", raw: "b".repeat(64) },
    raw: "a".repeat(64),
    current: ["101", "99"] as [string, string],
    previous: ["100", "100"] as [string, string],
  };
}
test("historical target selection excludes an actual half-day and previous IWM outcomes before prices", () => {
  const a = event("2017-04", "2017-03", "2017-04-13", "2017-04-06");
  const b = event("2017-07", "2017-06", "2017-06-30", "2017-06-22");
  const c = event("2017-10", "2017-09", "2017-10-12", "2017-10-05");
  const cohort = buildH6Cohort([a, b, c], new Set(["2017-10-13"]), extendedResearchSession);
  assert.deepEqual(
    cohort.rows.map((r) => r.day),
    ["2017-04-17"],
  );
  assert.deepEqual(
    cohort.excluded.map((e) => e.reason),
    ["short_session", "previously_examined_iwm"],
  );
  assert(cohort.rows[0].features[0] < 0 && cohort.rows[0].features[1] > 0);
  assert.throws(() => buildH6Cohort([a, a], new Set(), extendedResearchSession));
});
test("the research reader verifies all venue-date prefixes while opening prices only on registered sessions", () => {
  const days = ["2017-11-14", "2017-11-15"];
  const csv = "11/14/2017,not-a-price\n11/15/2017,100,102,99,101,10";
  assert.equal(selectReservedPrices(csv, days, [days[1]], extendedResearchSession).length, 1);
  assert.throws(() => selectReservedPrices(csv, days, [days[0]], extendedResearchSession));
  assert.throws(() =>
    selectReservedPrices(csv.replace("11/14", "11/16"), days, [days[1]], extendedResearchSession),
  );
  assert.throws(() => h6Intervals([]));
});
test("staging rejects a different prospective cutoff before looking up any private records", async () => {
  await assert.rejects(readH6RetailStudy("/directory-not-opened", "2026-11-03T07:00:00.000Z"), /registered/);
});
