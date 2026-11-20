import type { Bar, NewsItem, OptionContract, Quote } from './contracts';

export const RANGES = ['1M', '3M', '6M', '1Y'] as const;
export type Range = typeof RANGES[number];
export const isRange = (value: string): value is Range => RANGES.includes(value as Range);
export const isSymbol = (value: string): boolean => /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/.test(value);
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const nonnegative = (value: unknown): number | null => { const n = finite(value); return n !== null && n >= 0 ? n : null; };
export const text = (value: unknown, max = 1000): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function safeUrl(value: unknown): string | null {
  try { const u = new URL(text(value, 4000)); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = new Date(value); return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
const marketDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function tradingDate(time: string): string { return marketDate.format(new Date(time)); }

export function parseBar(value: unknown): Bar | null {
  const r = record(value); const time = timestamp(r.t);
  const open = finite(r.o), high = finite(r.h), low = finite(r.l), close = finite(r.c), volume = nonnegative(r.v);
  if (!time || open === null || high === null || low === null || close === null || volume === null || low <= 0 || high < low || open < low || open > high || close < low || close > high) return null;
  return { time, open, high, low, close, volume };
}

/** A previous-day bar is the completed-session authority. Never mix it with a partial current day. */
export function mergeCompletedBars(history: Bar[], previous: Bar | null, now = new Date()): Bar[] {
  const cutoff = previous ? tradingDate(previous.time) : tradingDate(now.toISOString());
  const days = new Map<string, Bar>();
  for (const bar of history) {
    const day = tradingDate(bar.time);
    if (previous ? day <= cutoff : day < cutoff) days.set(day, bar);
  }
  if (previous) days.set(tradingDate(previous.time), previous);
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bar]) => bar);
}

export function quoteFromBars(symbol: string, name: string, bars: Bar[]): Quote | null {
  const current = bars.at(-1); if (!current) return null;
  const previous = bars.at(-2); const change = previous ? current.close - previous.close : null;
  const { time, ...prices } = current;
  return { symbol, name, ...prices, asOf: time, change, changePercent: previous && previous.close > 0 ? (current.close / previous.close - 1) * 100 : null };
}

export function barsForRange(bars: Bar[], range: Range, now = new Date()): Bar[] {
  const cutoff = new Date(now), originalDay = cutoff.getUTCDate();
  cutoff.setUTCDate(1); cutoff.setUTCMonth(cutoff.getUTCMonth() - ({ '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range]));
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate(); cutoff.setUTCDate(Math.min(originalDay, lastDay));
  const day = tradingDate(cutoff.toISOString()); return bars.filter(bar => tradingDate(bar.time) >= day);
}

export function parseOptions(values: unknown): OptionContract[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap(value => {
    const r = record(value), details = record(r.details), day = record(r.day), quote = record(r.last_quote), greeks = record(r.greeks);
    const symbol = text(details.ticker, 50), type = details.contract_type, strike = nonnegative(details.strike_price), expiry = text(details.expiration_date, 10);
    if (!symbol || (type !== 'call' && type !== 'put') || strike === null || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !timestamp(expiry)) return [];
    return [{ symbol, type, strike, expiry, price: nonnegative(quote.midpoint) ?? nonnegative(day.close), volume: nonnegative(day.volume), openInterest: nonnegative(r.open_interest), iv: nonnegative(r.implied_volatility), delta: finite(greeks.delta), gamma: nonnegative(greeks.gamma) }];
  });
}

export function parseNews(values: unknown, symbol: string): NewsItem[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap(value => {
    const r = record(value), publisher = record(r.publisher); const url = safeUrl(r.article_url), publishedAt = timestamp(r.published_utc), title = text(r.title, 400);
    if (!url || !publishedAt || !title) return [];
    const insight = Array.isArray(r.insights) ? r.insights.map(record).find(item => item.ticker === symbol) : undefined;
    const sentiment = insight && ['positive', 'negative', 'neutral'].includes(String(insight.sentiment)) ? insight.sentiment as NewsItem['sentiment'] : null;
    return [{ id: text(r.id, 150) || url, title, description: text(r.description, 1000), url, publisher: text(publisher.name, 100) || 'Publisher not supplied', publishedAt, symbols: Array.isArray(r.tickers) ? r.tickers.filter((s): s is string => typeof s === 'string' && isSymbol(s)).slice(0, 30) : [], sentiment, ...(insight && text(insight.sentiment_reasoning) ? { reasoning: text(insight.sentiment_reasoning) } : {}) }];
  });
}
