import test from "node:test";
import assert from "node:assert/strict";
import {
  isWidgetKind,
  providerSymbol,
  tradingViewDocument,
} from "../lib/tradingview-config.ts";

test("widget documents reject script injection and unknown providers", () => {
  for (const symbol of [
    "<script>alert(1)</script>",
    'SPY" onload="alert(1)',
    "NASDAQ:QQQ",
    "../secret",
  ]) {
    assert.throws(() => tradingViewDocument("chart", symbol, "dark", "symbol"));
  }
  assert.equal(isWidgetKind("__proto__"), false);
  assert.equal(isWidgetKind("constructor"), false);
  assert.equal(providerSymbol("BRK.B"), "NYSE:BRK.B");
});

test("current hosted intervals follow the selected horizon without exposing raw market values", () => {
  for (const [horizon, interval] of [
    ["daily", "D"],
    ["weekly", "W"],
    ["monthly", "M"],
  ] as const) {
    const chart = tradingViewDocument(
      "chart",
      "QQQ",
      "light",
      "symbol",
      horizon,
    );
    const technical = tradingViewDocument(
      "technical",
      "QQQ",
      "light",
      "symbol",
      horizon,
    );
    assert.match(chart, new RegExp(`"interval":"${interval}"`));
    assert.match(technical, new RegExp(`"interval":"1${interval}"`));
    assert.match(chart, /"symbol":"NASDAQ:QQQ"/);
    assert.match(technical, /"colorTheme":"light"/);
    assert.match(technical, /"isTransparent":false/);
    assert.ok(!chart.includes("postMessage"));
  }
  assert.throws(() =>
    tradingViewDocument("chart", "SPY", "dark", "symbol", "intraday" as never),
  );
});

test("isolated widgets retain provider configuration and separate ETF market headlines from stock-specific news", () => {
  const extract = (html: string) =>
    JSON.parse(html.match(/async>(.*?)<\/script>/)![1]);
  const chart = extract(tradingViewDocument("chart", "SPY", "light", "symbol"));
  assert.equal(chart.symbol, "AMEX:SPY");
  assert.equal(chart.theme, "light");
  assert.equal(chart.allow_symbol_change, false);
  const market = extract(tradingViewDocument("news", "SPY", "dark", "market"));
  assert.equal(market.feedMode, "market");
  assert.equal(market.market, "stock");
  assert.equal(market.symbol, undefined);
  const stock = extract(tradingViewDocument("news", "AAPL", "dark", "symbol"));
  assert.equal(stock.feedMode, "symbol");
  assert.equal(stock.symbol, "NASDAQ:AAPL");
  assert.equal(stock.market, undefined);
});
