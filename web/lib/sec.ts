import 'server-only';
import { unstable_cache } from 'next/cache';
import type { DataStatus, Envelope, Filing } from './contracts';
import { normalizeCik, parseIssuerDirectory, parseSECSubmissions } from './public-normalization';

const USER_AGENT = 'The Daily Consensus public research https://thedailyconsensus.com';
const ETF_CONTEXT = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD', 'VTI', 'VOO', 'IEF']);
const MARKET_ISSUERS = ['AAPL', 'MSFT', 'NVDA'];
// Verified in SEC's current public issuer directory; a bounded fallback if that directory is unavailable.
const KNOWN_CIKS: Record<string, string> = { AAPL: '0000320193', MSFT: '0000789019', NVDA: '0001045810', AMZN: '0001018724', GOOGL: '0001652044', GOOG: '0001652044', META: '0001326801', TSLA: '0001318605', JPM: '0000019617', AMD: '0000002488', 'BRK-B': '0001067983' };
const pending = new Map<string, Promise<unknown>>();
let nextRequestAt = 0;

class SECFailure extends Error {
  status: DataStatus;
  constructor(status: DataStatus) { super('SEC public data unavailable'); this.status = status; }
}
async function fetchSEC(path: string): Promise<unknown> {
  // Cache misses are spaced below ten requests/second within this server process.
  // The bounded queue rejects excess load instead of accumulating long waits.
  const now = Date.now(), delay = Math.max(0, nextRequestAt - now);
  if (delay > 1200) throw new SECFailure('rate_limited');
  nextRequestAt = now + delay + 160;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const url = path === 'directory' ? 'https://www.sec.gov/files/company_tickers.json' : `https://data.sec.gov/submissions/CIK${path}.json`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new SECFailure(response.status === 429 ? 'rate_limited' : 'unavailable');
  return response.json();
}
async function cachedSEC(path: string, seconds: number): Promise<unknown> {
  if (path !== 'directory' && normalizeCik(path) !== path) throw new SECFailure('unavailable');
  const key = `${seconds}:${path}`, current = pending.get(key); if (current) return current;
  const cached = unstable_cache(fetchSEC, ['tdc-sec-public-v1', String(seconds)], { revalidate: seconds });
  const request = cached(path); if (pending.size < 64) pending.set(key, request);
  try { return await request; } finally { if (pending.get(key) === request) pending.delete(key); }
}

export async function getSECFilings(symbol: string): Promise<Envelope<Filing[]>> {
  const fetchedAt = new Date().toISOString(), context = ETF_CONTEXT.has(symbol), requested = context ? MARKET_ISSUERS : [symbol.replaceAll('.', '-')];
  let directory: ReturnType<typeof parseIssuerDirectory> = new Map(), directoryUnavailable = false;
  try { directory = parseIssuerDirectory(await cachedSEC('directory', 86_400)); } catch { directoryUnavailable = true; }
  const issuers = requested.flatMap(ticker => { const cik = directory.get(ticker)?.cik ?? KNOWN_CIKS[ticker]; return cik ? [{ ticker, cik }] : []; });
  const coverage = context ? `Broad-market issuer context for ${symbol}: recent filings by AAPL, MSFT and NVDA. These are company filings, not ${symbol} fund disclosures or its full holdings.` : `Recent SEC submissions for ${symbol}. A bounded list of filing metadata and original documents; no claim of complete filing history.`;
  if (!issuers.length) return { status: directoryUnavailable ? 'unavailable' : 'unconfigured', source: 'U.S. Securities and Exchange Commission · EDGAR', fetchedAt, asOf: null, data: [], coverage, message: directoryUnavailable ? 'The SEC issuer directory is temporarily unavailable, and no verified fallback issuer mapping exists for this symbol. Use the linked EDGAR search.' : 'No issuer mapping was found in the SEC company directory for this symbol. Use the linked EDGAR search; no substitute company is shown.' };
  const results = await Promise.allSettled(issuers.map(async issuer => parseSECSubmissions(await cachedSEC(issuer.cik, 3600), issuer.cik, context ? 6 : 18)));
  const data = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  const failures = results.filter(result => result.status === 'rejected'), missing = results.some(result => result.status === 'fulfilled' && !result.value.length) || issuers.length !== requested.length;
  const limited = failures.some(result => result.status === 'rejected' && result.reason instanceof SECFailure && result.reason.status === 'rate_limited');
  const status: DataStatus = data.length ? failures.length || missing ? 'partial' : 'ok' : limited ? 'rate_limited' : 'unavailable';
  return { status, source: 'U.S. Securities and Exchange Commission · EDGAR', fetchedAt, asOf: data[0]?.filedAt ?? null, data, coverage,
    message: failures.length || missing ? 'Some requested issuer filings were not returned. The available documents remain linked; missing filings are not treated as zero.' : data.length ? 'Filing dates are publication dates; report periods can differ. Metadata is refreshed at most hourly. Company filings are supplied by filers, not endorsed by the SEC.' : 'The SEC did not return usable recent filing metadata. Use the linked EDGAR search.',
  };
}
