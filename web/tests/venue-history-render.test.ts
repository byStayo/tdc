import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { createElement, type ComponentType, type ReactNode } from "react";
import ts from "typescript";
import type { ReviewPacket } from "../lib/consensus/reviewed.ts";
import type { Instrument, Snapshot } from "../lib/consensus/types.ts";

test("historical venue views retain only the dated MARKET filings and hide the entire ETF panel", async () => {
  const component = new URL("../components/OffExchangeActivity.tsx", import.meta.url);
  const css = new URL("../components/MorningBoard.module.css", import.meta.url);
  // Node's native test runner handles .ts. Compile this actual TSX component for
  // React server rendering and omit only the CSS, which the browser checks cover.
  const loader = registerHooks({
    load(url, context, next) {
      if (url === css.href)
        return { format: "module", source: "export default {};", shortCircuit: true };
      if (url !== component.href) return next(url, context);
      const { outputText } = ts.transpileModule(readFileSync(component, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    },
  });
  try {
    const { default: Panel } = await import(component.href) as {
      default: ComponentType<{ review?: ReviewPacket; instrument: Instrument; historical: boolean }>;
    };
    const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
      renderToStaticMarkup(element: ReactNode): string;
    };
    const edition: Snapshot = JSON.parse(readFileSync(
      new URL("../public/consensus/2026-11-05T18-23-42-514Z.json", import.meta.url), "utf8",
    ));
    const review = edition.review!;
    const render = (instrument: Instrument, historical: boolean) =>
      renderToStaticMarkup(createElement(Panel, { review, instrument, historical }));
    const archived = render("MARKET", true);
    for (const pair of [review.venueActivity!.nasdaqTrfShare, review.venueActivity!.bidsTouchedMillions]) {
      const filing = review.sources.find(source => source.id === pair.sourceId)!;
      assert.ok(archived.includes(filing.url));
      assert.ok(archived.includes(String(pair.current)));
    }
    assert.doesNotMatch(archived, /tapeboard\.com|otctransparency\.finra\.org/);
    assert.equal(render("SPY", true), "");
    assert.match(render("SPY", false), /tapeboard\.com\/dark-pool\/SPY/);
  } finally {
    loader.deregister();
  }
});
