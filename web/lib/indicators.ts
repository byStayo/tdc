import type { Bar, Indicator } from './contracts';

const mean = (values: number[]): number => values.reduce((sum, n) => sum + n, 0) / values.length;
export function sma(values: number[], period: number): number | null { return values.length >= period ? mean(values.slice(-period)) : null; }
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((close, i) => close - values[i]);
  let gain = mean(changes.slice(0, period).map(n => Math.max(n, 0)));
  let loss = mean(changes.slice(0, period).map(n => Math.max(-n, 0)));
  for (const change of changes.slice(period)) { gain = (gain * (period - 1) + Math.max(change, 0)) / period; loss = (loss * (period - 1) + Math.max(-change, 0)) / period; }
  return loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
}
function emaSeries(values: number[], period: number): (number | null)[] {
  let value: number | null = null; const alpha = 2 / (period + 1);
  return values.map((current, index) => {
    if (index < period - 1) return null;
    value = value === null ? mean(values.slice(0, period)) : current * alpha + value * (1 - alpha); return value;
  });
}
export function macd(values: number[]): { line: number | null; signal: number | null; histogram: number | null } {
  const fast = emaSeries(values, 12), slow = emaSeries(values, 26);
  const series = slow.flatMap((value, index) => value !== null && fast[index] !== null ? [fast[index]! - value] : []);
  const line = series.at(-1) ?? null, signal = emaSeries(series, 9).at(-1) ?? null;
  return { line, signal, histogram: line !== null && signal !== null ? line - signal : null };
}
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null;
  const ranges = bars.slice(1).map((bar, index) => Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index].close), Math.abs(bar.low - bars[index].close)));
  let value = mean(ranges.slice(0, period));
  for (const range of ranges.slice(period)) value = (value * (period - 1) + range) / period;
  return value;
}
export function realizedVolatility(values: number[], period = 20): number | null {
  if (values.length <= period || values.some(n => n <= 0)) return null;
  const recent = values.slice(-(period + 1)); const returns = recent.slice(1).map((n, i) => Math.log(n / recent[i]));
  const average = mean(returns); const variance = returns.reduce((sum, n) => sum + (n - average) ** 2, 0) / (period - 1);
  return Math.sqrt(variance * 252) * 100;
}
export function williamsAD(bars: Bar[], period = 20): number | null {
  if (bars.length <= period) return null;
  const recent = bars.slice(-(period + 1));
  return recent.slice(1).reduce((sum, bar, i) => { const previous = recent[i].close; return sum + (bar.close > previous ? bar.close - Math.min(bar.low, previous) : bar.close < previous ? bar.close - Math.max(bar.high, previous) : 0); }, 0);
}

export function calculateIndicators(bars: Bar[]): Indicator[] {
  const closes = bars.map(bar => bar.close), last = closes.at(-1), strength = rsi(closes), momentum = macd(closes);
  const observations: Indicator[] = [20, 50, 200].map(period => {
    const value = sma(closes, period);
    return { id: `sma-${period}`, name: `${period}-session moving average`, value, unit: 'USD', interpretation: value === null || last === undefined ? `Requires ${period} completed sessions.` : `Latest close is ${last > value ? 'above' : last < value ? 'below' : 'at'} this average.`, methodology: `Arithmetic mean of the last ${period} split-adjusted completed-session closing prices. Descriptive context, not a price forecast.` };
  });
  return [...observations,
    { id: 'rsi-14', name: 'Relative strength index · 14', value: strength, unit: '/ 100', interpretation: strength === null ? 'Requires 15 completed sessions.' : strength >= 70 ? 'Above the conventional 70 threshold; this alone does not predict a reversal.' : strength <= 30 ? 'Below the conventional 30 threshold; this alone does not predict a reversal.' : 'Between the conventional 30 and 70 thresholds.', methodology: 'Wilder smoothing of 14-session average gains and losses. Flat prices yield 50; one-sided losses yield 0 and one-sided gains yield 100.' },
    { id: 'macd', name: 'MACD · 12 / 26', value: momentum.line, unit: 'USD', interpretation: momentum.line === null ? 'Requires 26 completed sessions.' : momentum.line >= 0 ? 'The 12-session EMA is at or above the 26-session EMA.' : 'The 12-session EMA is below the 26-session EMA.', methodology: '12-session EMA minus 26-session EMA. Each EMA starts from its first full-period simple average.' },
    { id: 'macd-signal', name: 'MACD signal · 9', value: momentum.signal, unit: 'USD', interpretation: momentum.signal === null ? 'Requires 34 completed sessions.' : 'Smoothed MACD reference line.', methodology: 'Nine-observation EMA of the MACD line, initialized with a nine-observation simple average.' },
    { id: 'macd-histogram', name: 'MACD histogram', value: momentum.histogram, unit: 'USD', interpretation: momentum.histogram === null ? 'Requires 34 completed sessions.' : momentum.histogram >= 0 ? 'MACD is at or above its signal line.' : 'MACD is below its signal line.', methodology: 'MACD line minus its nine-observation signal line.' },
    { id: 'range-high-20', name: '20-session range high', value: bars.length >= 20 ? Math.max(...bars.slice(-20).map(bar => bar.high)) : null, unit: 'USD', interpretation: bars.length >= 20 ? 'Highest observed daily high in this window; not an inferred resistance guarantee.' : 'Requires 20 completed sessions.', methodology: 'Maximum split-adjusted high among the last 20 completed daily bars.' },
    { id: 'range-low-20', name: '20-session range low', value: bars.length >= 20 ? Math.min(...bars.slice(-20).map(bar => bar.low)) : null, unit: 'USD', interpretation: bars.length >= 20 ? 'Lowest observed daily low in this window; not an inferred support guarantee.' : 'Requires 20 completed sessions.', methodology: 'Minimum split-adjusted low among the last 20 completed daily bars.' },
    { id: 'atr-14', name: 'Average true range · 14', value: atr(bars), unit: 'USD', interpretation: bars.length > 14 ? 'Describes recent daily range, including overnight gaps.' : 'Requires 15 completed sessions.', methodology: 'Wilder-smoothed 14-session average of max(high-low, abs(high-previous close), abs(low-previous close)).' },
    { id: 'realized-volatility-20', name: '20-session realized volatility', value: realizedVolatility(closes), unit: '% annualized', interpretation: bars.length > 20 ? 'Historical variability of returns; distinct from options-implied volatility.' : 'Requires 21 completed sessions.', methodology: 'Sample standard deviation (n-1) of the last 20 log close-to-close returns, multiplied by sqrt(252) and 100.' },
    { id: 'williams-ad-20', name: 'Williams A/D · 20 sessions', value: williamsAD(bars), unit: 'price units', interpretation: bars.length > 20 ? 'Price-based accumulation/distribution balance; does not identify investor flows.' : 'Requires 21 completed sessions.', methodology: 'Sum over 20 sessions: when close rises, close-min(low, previous close); when it falls, close-max(high, previous close); otherwise zero. This measure does not use volume.' },
  ];
}
