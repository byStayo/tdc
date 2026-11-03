import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestPublicPositioning, parseSECSubmissions, publicDate, PUBLIC_CONTRACT_CODES } from '../lib/public-normalization.ts';

export const PUBLIC_HOSTS = new Set(['publicreporting.cftc.gov', 'www.cftc.gov', 'fred.stlouisfed.org', 'www.sec.gov', 'data.sec.gov']);
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'The Daily Consensus public editorial research https://thedailyconsensus.com';
export interface EditorialSource {
  id: string; kind: 'cftc' | 'fred' | 'sec' | 'methodology'; title: string;
  url: string; retrievalUrl: string; retrievedAt: string; observationDates: string[];
  status: 'ok' | 'unavailable'; data: unknown; error?: string;
}
export interface EditorialEvidence { schemaVersion: 1; scope: 'market'; collectedAt: string; sources: EditorialSource[]; limitations: string[]; }
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function assertPublicURL(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4000) throw new Error('Invalid public source URL');
  let url: URL; try { url = new URL(input); } catch { throw new Error('Invalid public source URL'); }
  if (url.protocol !== 'https:' || !PUBLIC_HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error('Source URL must use an allowlisted public HTTPS host');
  for (const key of url.searchParams.keys()) if (/^(?:api[_-]?key|key|token|access[_-]?token|authorization|password|secret)$/i.test(key)) throw new Error('Credential-bearing source URLs are forbidden');
  url.searchParams.sort(); return url.href;
}

async function fetchText(url: string, fetcher: Fetcher): Promise<{ text: string; retrievedAt: string }> {
  assertPublicURL(url);
  const response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/csv,text/html' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error(`Public source returned HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Public source exceeded the bounded response size');
      chunks.push(result.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return { text: Buffer.concat(chunks).toString('utf8'), retrievedAt: new Date().toISOString() };
}

export function parseFREDCSV(input: string, id: string): { date: string; value: number | null }[] {
  const lines = input.trim().split(/\r?\n/);
  if (lines[0] !== `observation_date,${id}` && lines[0] !== `DATE,${id}`) throw new Error('Unexpected FRED CSV header');
  return lines.slice(1).flatMap(line => {
    const [rawDate, rawValue, extra] = line.split(','), date = publicDate(rawDate);
    if (!date || extra !== undefined) return [];
    if (rawValue !== undefined && rawValue.trim() && rawValue !== '.' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawValue.trim())) return [];
    const value = rawValue === undefined || !rawValue.trim() || rawValue === '.' ? null : Number(rawValue);
    if (value !== null && !Number.isFinite(value)) return [];
    return [{ date, value }];
  }).slice(-60);
}

const FRED = [
  { id: 'FRED_RATE', series: 'FEDFUNDS', title: 'Federal Reserve / FRED · Effective federal funds rate', unit: 'percent', frequency: 'monthly' },
  { id: 'FRED_PRIME', series: 'DPRIME', title: 'Federal Reserve / FRED · Bank prime loan rate', unit: 'percent', frequency: 'daily' },
  { id: 'FRED_WEALTH', series: 'TNWBSHNO', title: 'Federal Reserve / FRED · Household and nonprofit net worth', unit: 'millions USD', frequency: 'quarterly' },
] as const;
const CFTC_IDS: Record<string, string> = { '13874A': 'CFTC_ES', '209742': 'CFTC_NQ', '239742': 'CFTC_RTY', '124603': 'CFTC_DOW', '020601': 'CFTC_BOND', '043602': 'CFTC_TENYEAR' };
const ISSUERS = [{ ticker: 'AAPL', cik: '0000320193' }, { ticker: 'MSFT', cik: '0000789019' }, { ticker: 'NVDA', cik: '0001045810' }];
const CFTC_METHOD = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm';

function failed(source: Omit<EditorialSource, 'status' | 'data' | 'observationDates'>): EditorialSource {
  return { ...source, status: 'unavailable', observationDates: [], data: null, error: 'The official source did not return usable public evidence. Do not cite this item.' };
}
async function collectFRED(fetcher: Fetcher): Promise<EditorialSource[]> {
  return Promise.all(FRED.map(async descriptor => {
    const url = `https://fred.stlouisfed.org/series/${descriptor.series}`, retrievalUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${descriptor.series}`;
    const base = { id: descriptor.id, kind: 'fred' as const, title: descriptor.title, url, retrievalUrl };
    try {
      const response = await fetchText(retrievalUrl, fetcher), observations = parseFREDCSV(response.text, descriptor.series);
      if (!observations.some(item => item.value !== null)) throw new Error('No usable FRED observations');
      return { ...base, retrievedAt: response.retrievedAt, status: 'ok', observationDates: observations.map(item => item.date), data: { seriesId: descriptor.series, unit: descriptor.unit, frequency: descriptor.frequency, observations } };
    } catch { return failed({ ...base, retrievedAt: new Date().toISOString() }); }
  }));
}
async function collectCFTC(fetcher: Fetcher): Promise<EditorialSource[]> {
  const url = new URL('https://publicreporting.cftc.gov/resource/gpe5-46if.json');
  url.searchParams.set('$limit', '100'); url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
  url.searchParams.set('$where', `cftc_contract_market_code in (${PUBLIC_CONTRACT_CODES.map(code => `'${code}'`).join(',')})`);
  url.searchParams.set('$select', 'id,report_date_as_yyyy_mm_dd,contract_market_name,market_and_exchange_names,cftc_contract_market_code,contract_units,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short,dealer_positions_long_all,dealer_positions_short_all,futonly_or_combined');
  let rawRows: unknown[] = [], rows: ReturnType<typeof latestPublicPositioning> = [], retrievedAt = new Date().toISOString();
  try {
    const result = await fetchText(url.href, fetcher); retrievedAt = result.retrievedAt;
    const parsed: unknown = JSON.parse(result.text); rawRows = Array.isArray(parsed) ? parsed : [];
    rows = latestPublicPositioning(rawRows);
  } catch { /* Every missing contract is explicit below. */ }
  return PUBLIC_CONTRACT_CODES.map(code => {
    const data = rows.find(row => row.contractCode === code), citation = new URL('https://publicreporting.cftc.gov/resource/gpe5-46if.json');
    citation.searchParams.set('cftc_contract_market_code', code);
    if (data) citation.searchParams.set('report_date_as_yyyy_mm_dd', `${data.reportDate}T00:00:00.000`);
    const base = { id: CFTC_IDS[code], kind: 'cftc' as const, title: data ? `CFTC · ${data.market} · ${data.reportDate}` : `CFTC · contract ${code}`, url: citation.href, retrievalUrl: url.href, retrievedAt };
    if (!data) return failed(base);
    const earlier = rawRows.filter(row => row && typeof row === 'object' &&
      typeof (row as Record<string, unknown>).report_date_as_yyyy_mm_dd === 'string' &&
      String((row as Record<string, unknown>).report_date_as_yyyy_mm_dd).slice(0, 10) < data.reportDate);
    const previous = latestPublicPositioning(earlier, [code])[0] ?? null;
    // Pin both report dates in the citation when a comparison is available.
    // A latest-only URL would not support a claim about the previous report.
    if (previous) {
      citation.searchParams.delete('report_date_as_yyyy_mm_dd');
      citation.searchParams.set('$where', `report_date_as_yyyy_mm_dd in ('${data.reportDate}T00:00:00.000','${previous.reportDate}T00:00:00.000')`);
      citation.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
    }
    return { ...base, url: citation.href, status: 'ok', observationDates: previous ? [data.reportDate, previous.reportDate] : [data.reportDate], data: { ...data, previous } };
  });
}
async function collectSEC(fetcher: Fetcher): Promise<EditorialSource[]> {
  const sources: EditorialSource[] = [];
  // Three declared issuers only; serialize and space requests below SEC's fair-access ceiling.
  for (const issuer of ISSUERS) {
    const url = `https://data.sec.gov/submissions/CIK${issuer.cik}.json`, base = { id: `SEC_${issuer.ticker}`, kind: 'sec' as const, title: `SEC · ${issuer.ticker} recent filings`, url, retrievalUrl: url };
    try {
      const response = await fetchText(url, fetcher), filings = parseSECSubmissions(JSON.parse(response.text), issuer.cik, 8);
      if (!filings.length) throw new Error('No usable SEC filings');
      sources.push({ ...base, retrievedAt: response.retrievedAt, status: 'ok', observationDates: [...new Set(filings.map(filing => filing.filedAt))], data: { cik: issuer.cik, ticker: issuer.ticker, filings } });
    } catch { sources.push(failed({ ...base, retrievedAt: new Date().toISOString() })); }
    if (issuer !== ISSUERS.at(-1)) await new Promise(resolve => setTimeout(resolve, 160));
  }
  return sources;
}
async function collectMethod(fetcher: Fetcher): Promise<EditorialSource[]> {
  const base = { id: 'CFTC_METHOD', kind: 'methodology' as const, title: 'CFTC · Commitments of Traders methodology', url: CFTC_METHOD, retrievalUrl: CFTC_METHOD };
  try {
    const response = await fetchText(CFTC_METHOD, fetcher);
    const main = response.text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? response.text;
    const plain = main.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (plain.length < 100) throw new Error('No methodology text');
    return [{ ...base, retrievedAt: response.retrievedAt, status: 'ok', observationDates: [], data: { format: 'official-document-excerpt', sha256: createHash('sha256').update(response.text).digest('hex'), excerpt: plain.slice(0, 12_000) } }];
  } catch { return [failed({ ...base, retrievedAt: new Date().toISOString() })]; }
}

export async function collectEditorialEvidence(fetcher: Fetcher = fetch): Promise<EditorialEvidence> {
  const parts = await Promise.all([collectCFTC(fetcher), collectFRED(fetcher), collectSEC(fetcher), collectMethod(fetcher)]);
  return { schemaVersion: 1, scope: 'market', collectedAt: new Date().toISOString(), sources: parts.flat(), limitations: [
    'This is bounded public evidence, not an exhaustive market feed. Missing sources remain unavailable.',
    'CFTC data is futures-only and weekly, generally observed Tuesday and released Friday. Contract counts have different units and must not be summed across markets.',
    'FRED observations have different frequencies, publication lags and revision schedules. Null observations are missing, not zero.',
    'SEC coverage is recent filing metadata for AAPL, MSFT and NVDA, not an index holdings file or an exhaustive issuer search.',
    'Hosted widget content, private subscription data and paid AI APIs are not collected.',
  ] };
}

export async function saveEditorialEvidence(evidence: EditorialEvidence, root = PROJECT_ROOT): Promise<string> {
  const directory = resolve(root, '.editorial'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(evidence, null, 2)}\n`, date = evidence.collectedAt.slice(0, 10), temporary = resolve(directory, `.evidence-${randomUUID()}.tmp`);
  await writeFile(temporary, payload, { flag: 'wx', mode: 0o600 });
  let destination = resolve(directory, `evidence-${date}.json`);
  try {
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      destination = resolve(directory, `evidence-${date}-${evidence.collectedAt.slice(11, 19).replaceAll(':', '')}-${createHash('sha256').update(payload).digest('hex').slice(0, 8)}.json`);
      await link(temporary, destination);
    }
    return destination;
  } finally { await unlink(temporary).catch(() => undefined); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node --experimental-strip-types scripts/collect-editorial-evidence.ts');
    const evidence = await collectEditorialEvidence(), output = await saveEditorialEvidence(evidence);
    console.log(JSON.stringify({ output, collectedAt: evidence.collectedAt, available: evidence.sources.filter(source => source.status === 'ok').length, unavailable: evidence.sources.filter(source => source.status !== 'ok').map(source => source.id) }, null, 2));
  } catch (error) { console.error(`Collection failed: ${error instanceof Error ? error.message : 'Unknown failure'}`); process.exitCode = 1; }
}
