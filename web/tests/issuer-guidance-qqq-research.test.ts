import assert from "node:assert/strict";
import test from "node:test";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import {
  firstEligibleGuidanceSession,
  guidanceBlockInterval,
  matchesStatutoryQuarter,
} from "../scripts/research-issuer-guidance-qqq.ts";

const original = {
  ticker: "AMD" as const,
  cik: "0000002488",
  accessionNumber: "quarter",
  form: "10-Q",
  items: "",
  reportDate: "2025-09-27",
  filingDate: "2025-11-05",
  acceptanceDateTime: "2025-11-04T23:00:17.000Z",
};
const comparison = {
  tag: "Revenues",
  form: "10-Q",
  accn: "quarter",
  start: "2025-06-29",
  end: "2025-09-27",
  filed: "2025-11-05",
  fy: 2025,
  fp: "Q3",
  val: 12000000000,
};

test("after-hours confirmation first filed the next date waits for the following exchange session", () => {
  const earlier = {
    ...original,
    form: "8-K",
    filingDate: "2025-11-04",
    acceptanceDateTime: "2025-11-04T21:10:00.000Z",
  };
  const selected = firstEligibleGuidanceSession([earlier, original], extendedResearchSession);
  assert.equal(selected?.after, "2025-11-05");
  assert.equal(selected?.clock.openAt, "2025-11-06T14:30:00.000Z");
});

test("a shortened first eligible session is excluded without carrying the earnings to Monday", () => {
  const beforeThanksgiving = {
    ...original,
    filingDate: "2025-11-26",
    acceptanceDateTime: "2025-11-26T16:00:00.000Z",
  };
  assert.equal(firstEligibleGuidanceSession([beforeThanksgiving], extendedResearchSession), null);
  const firstEdition = { ...original, filingDate: "2026-11-02", acceptanceDateTime: "2026-11-02T16:00:00.000Z" };
  assert.equal(firstEligibleGuidanceSession([firstEdition], extendedResearchSession), null);
});

test("the exact original consolidated quarter is required even when another filing or duration shares its end date", () => {
  const originalFacts = new Map([["quarter", [comparison]]]);
  assert.equal(matchesStatutoryQuarter(12000000000, original, [original], originalFacts), true);
  for (const changed of [
    { ...comparison, val: 12000000001 },
    { ...comparison, filed: "2026-02-01" },
    { ...comparison, start: "2025-01-01" },
    { ...comparison, end: "2025-09-26" },
  ])
    assert.equal(
      matchesStatutoryQuarter(12000000000, original, [original], new Map([["quarter", [changed]]])),
      false,
    );
  assert.equal(
    matchesStatutoryQuarter(
      12000000000,
      original,
      [original],
      new Map([["quarter", [comparison, { ...comparison, val: 2 }]]]),
    ),
    false,
  );
});

test("fourth-quarter subtraction uses a matching original full-year and nine-month revenue definition", () => {
  const annual = {
    ...original,
    accessionNumber: "annual",
    form: "10-K",
    reportDate: "2025-12-27",
    filingDate: "2026-02-10",
    acceptanceDateTime: "2026-02-10T21:25:00.000Z",
  };
  const nineMonths = { ...comparison, start: "2024-12-29", val: 28000000000 };
  const whole = {
    ...nineMonths,
    form: "10-K",
    accn: "annual",
    fp: "FY",
    end: annual.reportDate,
    filed: annual.filingDate,
    val: 42000000000,
  };
  const cases = (third: typeof nineMonths) =>
    new Map([
      ["annual", [whole]],
      ["quarter", [third]],
    ]);
  assert.equal(matchesStatutoryQuarter(14000000000, annual, [original, annual], cases(nineMonths)), true);
  assert.equal(
    matchesStatutoryQuarter(
      14000000000,
      annual,
      [original, annual],
      cases({ ...nineMonths, tag: "DifferentConcept" }),
    ),
    false,
  );
  assert.equal(
    matchesStatutoryQuarter(14000000000, annual, [original, annual], cases({ ...nineMonths, fy: 2024 })),
    false,
  );
});

test("paired block uncertainty is deterministic and respects constant-per-session error differences", () => {
  assert.deepEqual(guidanceBlockInterval(Array(25).fill(0.125)), [0.125, 0.125]);
  const differences = [0.02, -0.01, 0.03, -0.02, 0.001, 0.04, -0.05];
  assert.deepEqual(guidanceBlockInterval(differences), guidanceBlockInterval(differences));
  assert.throws(() => guidanceBlockInterval([Number.NaN, 0, 0]));
});
