import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, calculateIndicators, macd, realizedVolatility, rsi, sma, williamsAD } from '../lib/indicators.ts';
import { barsForRange, isRange, isSymbol, mergeCompletedBars, parseBar, parseNews, parseOptions, quoteFromBars, safeUrl, tradingDate } from '../lib/market-normalization.ts';
import type { Bar } from '../lib/contracts.ts';

const bar = (time: string, close = 100): Bar => ({ time, open: close, high: close + 2, low: close - 2, close, volume: 0 });
const almost = (actual: number | null, expected: number, tolerance = 1e-8) => { assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} did not match ${expected}`); };

test('ticker validation rejects paths, credentials, query strings and oversized symbols', () => {
  for (const valid of ['SPY', 'AAPL', 'BRK.B', 'BRK-B']) assert.equal(isSymbol(valid), true);
  for (const invalid of ['', 'spy', '../SPY', 'SPY?apiKey=secret', 'https://example.com', 'A..B', 'A/B', 'A'.repeat(16), 'SPY\n']) assert.equal(isSymbol(invalid), false);
  assert.equal(isRange('1Y'), true); assert.equal(isRange('5Y'), false);
});

test('bars retain measured zero volume and reject missing or impossible OHLC', () => {
  const raw = { t: 1793653200000, o: 100, h: 102, l: 98, c: 101, v: 0 };
  assert.equal(parseBar(raw)?.volume, 0);
  assert.equal(parseBar({ ...raw, v: undefined }), null);
  assert.equal(parseBar({ ...raw, c: 103 }), null);
  assert.equal(parseBar({ ...raw, c: NaN }), null);
  assert.equal(parseBar({ ...raw, l: -1 }), null);
});

test('previous session replaces same-day midnight bar and excludes partial next session across DST', () => {
  const previous = bar('2026-11-02T21:00:00Z', 102);
  const history = [bar('2026-10-30T04:00:00Z', 100), bar('2026-11-02T05:00:00Z', 101), bar('2026-11-03T05:00:00Z', 104)];
  const merged = mergeCompletedBars(history, previous, new Date('2026-11-03T15:00:00Z'));
  assert.equal(tradingDate(history[0].time), '2026-10-30'); assert.equal(tradingDate(previous.time), '2026-11-02');
  assert.deepEqual(merged.map(x => x.close), [100, 102]); assert.equal(merged[1].time, previous.time);
  const quote = quoteFromBars('SPY', 'S&P 500 ETF', merged)!;
  assert.equal(quote.change, 2); almost(quote.changePercent, 2); assert.equal(quote.asOf, previous.time);
  assert.equal('time' in quote, false);
  assert.equal(quoteFromBars('SPY', 'SPY', [previous])?.change, null);
});

test('missing previous endpoint drops the current-day potentially incomplete bar', () => {
  const merged = mergeCompletedBars([bar('2026-11-02T05:00:00Z'), bar('2026-11-03T05:00:00Z')], null, new Date('2026-11-03T15:00:00Z'));
  assert.equal(merged.length, 1); assert.equal(tradingDate(merged[0].time), '2026-11-02');
});

test('month-end chart ranges clamp to the previous calendar month', () => {
  const rows = [bar('2026-02-27T21:00:00Z'), bar('2026-02-28T21:00:00Z'), bar('2026-03-01T21:00:00Z')];
  assert.equal(barsForRange(rows, '1M', new Date('2026-03-31T21:00:00Z')).length, 2);
});

test('RSI requires sufficient history, preserves a genuine zero, and uses Wilder smoothing', () => {
  assert.equal(rsi(Array(14).fill(100)), null); assert.equal(rsi(Array(15).fill(100)), 50);
  assert.equal(rsi(Array.from({ length: 15 }, (_, i) => 100 - i)), 0);
  assert.equal(rsi(Array.from({ length: 15 }, (_, i) => 100 + i)), 100);
  almost(rsi([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]), 70.46413502109705);
});

test('moving averages and MACD do not invent a warm-up history', () => {
  assert.equal(sma(Array(199).fill(100), 200), null); assert.equal(sma(Array(200).fill(100), 200), 100);
  assert.deepEqual(macd(Array(25).fill(100)), { line: null, signal: null, histogram: null });
  assert.deepEqual(macd(Array(26).fill(100)), { line: 0, signal: null, histogram: null });
  assert.deepEqual(macd(Array(34).fill(100)), { line: 0, signal: 0, histogram: 0 });
  almost(macd(Array.from({ length: 60 }, (_, i) => 100 + i)).line, 7);
  assert.ok(calculateIndicators([]).every(item => item.value === null));
});

test('ATR incorporates gaps and volatility uses observed log returns', () => {
  const bars = Array.from({ length: 15 }, (_, i) => bar(new Date(Date.UTC(2026, 0, i + 1, 21)).toISOString()));
  assert.equal(atr(bars.slice(0, 14)), null); assert.equal(atr(bars), 4);
  bars[14] = bar(bars[14].time, 110); almost(atr(bars), 64 / 14);
  assert.equal(realizedVolatility(Array(20).fill(100)), null); assert.equal(realizedVolatility(Array(21).fill(100)), 0);
  assert.equal(williamsAD(bars), null);
  assert.equal(williamsAD(Array.from({ length: 21 }, (_, i) => bar(new Date(Date.UTC(2026, 0, i + 1)).toISOString()))), 0);
});

test('options use explicit contract type and preserve unavailable fields separately from zero', () => {
  const contracts = parseOptions([{ details: { ticker: 'O:C260120P00050000', contract_type: 'put', strike_price: 50, expiration_date: '2026-01-20' }, day: { volume: 0, close: 0 }, open_interest: 0, greeks: { delta: -0.5, gamma: 0 } }]);
  assert.equal(contracts[0].type, 'put'); assert.equal(contracts[0].volume, 0); assert.equal(contracts[0].price, 0); assert.equal(contracts[0].iv, null); assert.equal(contracts[0].openInterest, 0);
  assert.deepEqual(parseOptions([{ details: { ticker: 'O:C260120P00050000', strike_price: 50, expiration_date: '2026-01-20' } }]), []);
});

test('news sentiment is ticker-specific and unsafe links never reach the client', () => {
  const article = { id: 'one', title: 'A report', article_url: 'https://example.com/report', published_utc: '2026-11-02T12:00:00Z', publisher: { name: 'Example' }, insights: [{ ticker: 'QQQ', sentiment: 'positive' }, { ticker: 'SPY', sentiment: 'negative', sentiment_reasoning: 'Attributed source text' }] };
  assert.equal(parseNews([article], 'SPY')[0].sentiment, 'negative'); assert.equal(parseNews([article], 'IWM')[0].sentiment, null);
  assert.deepEqual(parseNews([{ ...article, article_url: 'javascript:alert(1)' }], 'SPY'), []);
  assert.equal(safeUrl('https://secret:password@example.com'), null);
});
