import { strict as assert } from "node:assert";
import test from "node:test";
import { extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import {
  selectTailBars,
  tailTargetCalendar,
  validatedReturn,
} from "../scripts/research-tail-risk-spy.ts";

test("the tail-fund experiment excludes earlier SPY labels on both sides and uses the third preceding session", () => {
  const priorUsed = "2019-11-13";
  const { rows, removed } = tailTargetCalendar(new Set([priorUsed]));
  const full = extendedResearchSessions("2017-12-20", "2019-12-31");
  for (const row of rows) {
    assert.notEqual(row.day, priorUsed);
    assert.notEqual(row.prior, priorUsed);
    assert.equal(full[full.indexOf(row.day) - 3], row.prior);
  }
  assert(
    removed.targetPreviouslyExamined === 1 &&
      removed.sourcePreviouslyExamined === 1,
  );
  assert(!rows.some((r) => [r.day, r.prior].includes("2019-11-29")));
  assert(!rows.some((r) => [r.day, r.prior].includes("2018-12-05")));
});

test("native checks skip protected price fields but reject duplicate, mislabeled or malformed selected rows", () => {
  const dates = ["2019-01-02", "2019-01-03"];
  const omit = "01/02/2019,DO_NOT_PARSE";
  const wanted = "01/03/2019,4,5,3,4.5,15";
  const fetch = (body: string) =>
    selectTailBars(body, dates, new Set([dates[1]]));
  assert.equal(fetch(omit + "\n" + wanted)[0].close, 4.5);
  assert.deepEqual(fetch(omit), []);
  assert.throws(() => fetch(wanted + "\n" + wanted), /duplicated/);
  assert.throws(() => fetch("01/04/2019,4,5,3,4.5,15"), /outside/);
  assert.throws(() => fetch("01/03/2019,4,1,3,4.5,15"), /Invalid Kibot/);
});

test("same-session adjustments must agree on the economic return and direction", () => {
  assert.equal(
    validatedReturn({ open: 10, close: 12 }, { open: 5, close: 6 }),
    Math.log(1.2),
  );
  assert.equal(
    validatedReturn({ open: 10, close: 12 }, { open: 5, close: 6.1 }),
    undefined,
  );
  assert.equal(
    validatedReturn({ open: 5, close: 5.00001 }, { open: 5, close: 4.99999 }),
    undefined,
  );
  assert.equal(validatedReturn({ open: 5, close: 5 }, undefined), undefined);
});
