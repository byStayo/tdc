import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, link, unlink, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITORIAL_ISSUERS, latestPublicPositioning, parseSECSubmissions, publicDate, PUBLIC_CONTRACT_CODES } from '../lib/public-normalization.ts';
import { assertFedMinutesURL, attachFedMinutesSource, collectFedMinutes, FED_MINUTES_FEED, privateFedMinutesText } from '../lib/fed-minutes-editorial.ts';
import { durableDirectory, durableJSON } from '../lib/publication-storage.ts';

export const PUBLIC_HOSTS = new Set(['publicreporting.cftc.gov', 'www.cftc.gov', 'fred.stlouisfed.org', 'www.sec.gov', 'data.sec.gov', 'www.bls.gov', 'www.bankofengland.co.uk', 'www.federalreserve.gov']);
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'The Daily Consensus public editorial research https://thedailyconsensus.com';
export interface EditorialSource {
  id: string; kind: 'cftc' | 'fred' | 'sec' | 'sec_form144' | 'methodology' | 'bls' | 'boe_mpc' | 'fed_minutes'; title: string;
  url: string; retrievalUrl: string; retrievedAt: string; observationDates: string[];
  status: 'ok' | 'unavailable'; data: unknown; error?: string;
}
export interface EditorialEvidence { schemaVersion: 1; scope: 'market'; collectedAt: string; sources: EditorialSource[]; limitations: string[]; }
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function assertPublicURL(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4000) throw new Error('Invalid public source URL');
  let url: URL; try { url = new URL(input); } catch { throw new Error('Invalid public source URL'); }
  if (url.protocol !== 'https:' || !PUBLIC_HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error('Source URL must use an allowlisted public HTTPS host');
  if (url.hostname === 'www.bankofengland.co.uk' && (url.search || url.hash ||
      !/^\/monetary-policy-summary-and-minutes\/\d{4}\/[a-z]+-\d{4}$/.test(url.pathname))) throw new Error('Only dated Bank of England MPC minutes are supported');
  if (url.hostname === 'www.federalreserve.gov') assertFedMinutesURL(url.href);
  for (const key of url.searchParams.keys()) if (/^(?:api[_-]?key|key|token|access[_-]?token|authorization|password|secret)$/i.test(key)) throw new Error('Credential-bearing source URLs are forbidden');
  url.searchParams.sort(); return url.href;
}

export async function fetchText(url: string, fetcher: Fetcher): Promise<{ text: string; retrievedAt: string; sha256: string }> {
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
  const body = Buffer.concat(chunks);
  return { text: body.toString('utf8'), retrievedAt: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex') };
}

/** Archive replay evidence privately; only the bounded source object enters a manifest. */
export async function collectFedMinutesEvidence(fetcher: Fetcher = fetch, archiveRoot?: string, cutoff = new Date().toISOString()): Promise<EditorialSource> {
  const captures: ({ url: string } & Awaited<ReturnType<typeof fetchText>>)[] = [];
  const source = await collectFedMinutes(async url => {
    const capture = await fetchText(url, fetcher); captures.push({ url, ...capture }); return capture;
  }, cutoff);
  if (!archiveRoot) return source;
  try {
    const directory = resolve(archiveRoot, '.editorial/fed-minutes');
    await durableDirectory(directory, 0o700);
    await durableDirectory(resolve(directory, 'captures'), 0o700);
    await durableDirectory(resolve(directory, 'runs'), 0o700);
    const save = async (path: string, value: unknown) => {
      try {
        const old = JSON.parse(await readFile(path, 'utf8'));
        if (JSON.stringify(old) !== JSON.stringify(value)) throw new Error('Private Fed capture changed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await durableJSON(path, value, true);
      }
    };
    const files = [];
    for (const capture of captures) {
      if (createHash('sha256').update(capture.text).digest('hex') !== capture.sha256) throw new Error('Fed text capture is not byte-preserving UTF-8');
      const file = `${capture.retrievedAt.replace(/[:.]/g, '-')}-${capture.sha256}.json`;
      await save(resolve(directory, 'captures', file), { schemaVersion: 1, ...capture,
        ...(capture.url === source.retrievalUrl && source.status === 'ok' ? { normalizedText: privateFedMinutesText(capture.text) } : {}) });
      files.push({ url: capture.url, sha256: capture.sha256, retrievedAt: capture.retrievedAt, file: `captures/${file}` });
    }
    const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 16);
    await save(resolve(directory, 'runs', `${cutoff.replace(/[:.]/g, '-')}-${hash}.json`), { schemaVersion: 1, cutoff, source, files });
    return source;
  } catch {
    return { ...source, url: FED_MINUTES_FEED, retrievalUrl: FED_MINUTES_FEED, retrievedAt: new Date().toISOString(),
      status: 'unavailable', data: null, observationDates: [], error: 'Private Fed replay evidence could not be saved. Do not cite this item.' };
  }
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
  { id: 'FRED_DGS2', series: 'DGS2', title: 'Federal Reserve / FRED · Two-year Treasury constant maturity yield', unit: 'percent', frequency: 'daily', editorialOnly: true },
  { id: 'FRED_DGS10', series: 'DGS10', title: 'Federal Reserve / FRED · Ten-year Treasury constant maturity yield', unit: 'percent', frequency: 'daily', editorialOnly: true },
  { id: 'FRED_DGS30', series: 'DGS30', title: 'Federal Reserve / FRED · Thirty-year Treasury constant maturity yield', unit: 'percent', frequency: 'daily', editorialOnly: true },
  { id: 'FRED_SOFR', series: 'SOFR', title: 'Federal Reserve / FRED · Secured Overnight Financing Rate', unit: 'percent', frequency: 'daily', editorialOnly: true },
] as const;
const CFTC_IDS: Record<string, string> = { '13874A': 'CFTC_ES', '209742': 'CFTC_NQ', '239742': 'CFTC_RTY', '124603': 'CFTC_DOW', '020601': 'CFTC_BOND', '043602': 'CFTC_TENYEAR' };
const CFTC_METHOD = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm';

function failed(source: Omit<EditorialSource, 'status' | 'data' | 'observationDates'>): EditorialSource {
  return { ...source, status: 'unavailable', observationDates: [], data: null, error: 'The official source did not return usable public evidence. Do not cite this item.' };
}
async function collectFRED(fetcher: Fetcher): Promise<EditorialSource[]> {
  const from = new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10);
  return Promise.all(FRED.map(async descriptor => {
    const editorialOnly = 'editorialOnly' in descriptor;
    const url = `https://fred.stlouisfed.org/series/${descriptor.series}`;
    const retrievalUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${descriptor.series}${editorialOnly ? `&cosd=${from}` : ''}`;
    const base = { id: descriptor.id, kind: 'fred' as const, title: descriptor.title, url, retrievalUrl };
    try {
      const response = await fetchText(retrievalUrl, fetcher);
      const observations = parseFREDCSV(response.text, descriptor.series).filter(item => item.date <= response.retrievedAt.slice(0, 10));
      if (!observations.some(item => item.value !== null)) throw new Error('No usable FRED observations');
      return { ...base, retrievedAt: response.retrievedAt, status: 'ok', observationDates: observations.map(item => item.date), data: { seriesId: descriptor.series, unit: descriptor.unit, frequency: descriptor.frequency, observations, ...(editorialOnly ? { sha256: createHash('sha256').update(response.text).digest('hex') } : {}) } };
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
  // Serialize and space requests to the declared issuers below the SEC fair-access ceiling.
  for (const issuer of EDITORIAL_ISSUERS) {
    const url = `https://data.sec.gov/submissions/CIK${issuer.cik}.json`, base = { id: `SEC_${issuer.ticker}`, kind: 'sec' as const, title: `SEC · ${issuer.ticker} recent filings`, url, retrievalUrl: url };
    try {
      const response = await fetchText(url, fetcher), filings = parseSECSubmissions(JSON.parse(response.text), issuer.cik, 8);
      if (!filings.length) throw new Error('No usable SEC filings');
      sources.push({ ...base, retrievedAt: response.retrievedAt, status: 'ok', observationDates: [...new Set(filings.map(filing => filing.filedAt))], data: { cik: issuer.cik, ticker: issuer.ticker, filings } });
    } catch { sources.push(failed({ ...base, retrievedAt: new Date().toISOString() })); }
    if (issuer !== EDITORIAL_ISSUERS.at(-1)) await new Promise(resolve => setTimeout(resolve, 160));
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

export async function collectEditorialEvidence(fetcher: Fetcher = fetch, options: { fedMinutesArchiveRoot?: string } = {}): Promise<EditorialEvidence> {
  const cutoff = new Date().toISOString();
  const parts = await Promise.all([collectCFTC(fetcher), collectFRED(fetcher), collectSEC(fetcher), collectMethod(fetcher),
    collectFedMinutesEvidence(fetcher, options.fedMinutesArchiveRoot, cutoff).then(source => [source])]);
  return { schemaVersion: 1, scope: 'market', collectedAt: new Date().toISOString(), sources: parts.flat(), limitations: [
    'This is bounded public evidence, not an exhaustive market feed. Missing sources remain unavailable.',
    'CFTC data is futures-only and weekly, generally observed Tuesday and released Friday. Contract counts have different units and must not be summed across markets.',
    'FRED observations have different frequencies, publication lags and revision schedules. Null observations are missing, not zero.',
    'SEC filing coverage is limited to AAPL, MSFT, NVDA and WMT.',
    'FOMC minutes are editorial context from an earlier meeting. Availability follows the original release clock, not the meeting dates; this source does not create a forecast vote.',
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
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--enrich-fed-minutes'))
      throw new Error('Usage: node --experimental-strip-types scripts/collect-editorial-evidence.ts [--enrich-fed-minutes SAVED_EVIDENCE.json]');
    let evidence: EditorialEvidence;
    if (args.length) {
      const path = resolve(args[1]);
      if ((await stat(path)).size > MAX_RESPONSE_BYTES) throw new Error('Saved editorial evidence exceeds the bounded size');
      const original = JSON.parse(await readFile(path, 'utf8')) as EditorialEvidence;
      const source = await collectFedMinutesEvidence(fetch, PROJECT_ROOT);
      evidence = attachFedMinutesSource(original, source, new Date().toISOString());
    } else evidence = await collectEditorialEvidence(fetch, { fedMinutesArchiveRoot: PROJECT_ROOT });
    const output = await saveEditorialEvidence(evidence);
    console.log(JSON.stringify({ output, collectedAt: evidence.collectedAt, available: evidence.sources.filter(source => source.status === 'ok').length, unavailable: evidence.sources.filter(source => source.status !== 'ok').map(source => source.id) }, null, 2));
  } catch (error) { console.error(`Collection failed: ${error instanceof Error ? error.message : 'Unknown failure'}`); process.exitCode = 1; }
}
