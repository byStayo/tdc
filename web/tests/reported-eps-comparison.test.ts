import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { gaapEpsPair } from "../lib/display-format.ts";
import ReportedEpsComparison from "../components/ReportedEpsComparison.ts";
import type { Metric } from "../lib/consensus/types.ts";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (element: ReactNode) => string;
};
const metric = (label: string, value: number): Metric => ({ label, value, unit: "$ / share", date: "2026-09-27" });
const render = (metrics: Metric[], frequency = "quarterly company release") =>
  renderToStaticMarkup(createElement(ReportedEpsComparison, { frequency, metrics, className: "comparison-note" }));

test("GAAP EPS pairs preserve losses, zero and two decimal places without an invented growth rate", () => {
  assert.equal(gaapEpsPair(1.17, -2.89), "GAAP EPS $1.17 vs −$2.89");
  assert.equal(gaapEpsPair(-1.17, 2.89), "GAAP EPS −$1.17 vs $2.89");
  assert.equal(gaapEpsPair(2.1, 1.85), "GAAP EPS $2.10 vs $1.85");
  assert.equal(gaapEpsPair(0, 0), "GAAP EPS $0.00 vs $0.00");
  assert.equal(gaapEpsPair(1.17), "GAAP EPS $1.17");
});

test("the rendered comparison keeps the whole signed pair in one unbreakable line", () => {
  const markup = render([metric("GAAP diluted EPS", 1.17), metric("Prior-year GAAP diluted EPS", -2.89)]);
  assert.match(markup, /<small class="comparison-note">Current vs year-earlier quarter/);
  assert.match(markup, /<span style="display:block;white-space:nowrap">GAAP EPS \$1\.17 vs −\$2\.89<\/span>/);
  assert.doesNotMatch(markup, /%/);
});

test("missing prior EPS renders only the known value and does not imply a comparison", () => {
  const markup = render([metric("GAAP diluted EPS", -0.5)]);
  assert.match(markup, /GAAP EPS −\$0\.50/);
  assert.doesNotMatch(markup, / vs |year-earlier|undefined|NaN/);
});

test("the EPS comparison does not relabel adjusted, missing or non-company data as GAAP results", () => {
  assert.equal(render([metric("Adjusted diluted EPS", 2.17)]), "");
  assert.equal(render([metric("GAAP diluted EPS", NaN)]), "");
  assert.equal(render([metric("GAAP diluted EPS", 1.17)], "management guidance"), "");
});
