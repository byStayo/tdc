import type { Filing, Positioning } from './contracts';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, limit = 400): string => typeof value === 'string' ? value.trim().slice(0, limit) : '';

export const isPublicSymbol = (value: string): boolean => /^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/.test(value);
export const isPublicRange = (value: string): boolean => ['1M', '3M', '6M', '1Y'].includes(value);
export function publicCount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.0+)?$/.test(value.trim())) return null;
  const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
export function publicDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
  if (value.includes('T') && !Number.isFinite(Date.parse(value))) return null;
  const date = value.slice(0, 10), parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}
export function normalizeCik(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!/^\d{1,10}$/.test(raw) || Number(raw) <= 0) return null;
  return raw.padStart(10, '0');
}
export function parseIssuerDirectory(value: unknown): Map<string, { cik: string; name: string }> {
  const map = new Map<string, { cik: string; name: string }>();
  for (const entry of Object.values(object(value))) {
    const row = object(entry), ticker = string(row.ticker, 15), cik = normalizeCik(row.cik_str);
    if (isPublicSymbol(ticker) && cik) map.set(ticker, { cik, name: string(row.title, 200) });
  }
  return map;
}
export function secDocumentUrl(cikInput: unknown, accessionInput: unknown, documentInput: unknown): string | null {
  const cik = normalizeCik(cikInput), accession = string(accessionInput, 30), document = string(documentInput, 400);
  if (!cik || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  // EDGAR primary documents may include an XSL directory, but never an absolute URL or traversal.
  if (!document || document.split('/').some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(segment) || segment === '.' || segment === '..')) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/${document}`;
}
export function parseSECSubmissions(value: unknown, expectedCik: string, limit = 12): Filing[] {
  const root = object(value), cik = normalizeCik(root.cik), company = string(root.name, 200);
  if (!cik || cik !== normalizeCik(expectedCik) || !company) return [];
  const recent = object(object(root.filings).recent), accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const column = (name: string, index: number): unknown => Array.isArray(recent[name]) ? (recent[name] as unknown[])[index] : undefined;
  const records = new Map<string, Filing>();
  for (let i = 0; i < Math.min(accessions.length, 2000); i++) {
    const accession = string(accessions[i], 30), url = secDocumentUrl(cik, accession, column('primaryDocument', i)), filedAt = publicDate(column('filingDate', i)), form = string(column('form', i), 30);
    if (!url || !filedAt || !/^[A-Za-z0-9][A-Za-z0-9 /.-]{0,29}$/.test(form)) continue;
    const id = `sec:${cik}:${accession}`;
    records.set(id, { id, company, cik, form, filedAt, reportDate: publicDate(column('reportDate', i)), url, description: string(column('primaryDocDescription', i), 600) || `${form} filing` });
  }
  return [...records.values()].sort((a, b) => b.filedAt.localeCompare(a.filedAt)).slice(0, limit);
}

/** Codes verified against the CFTC TFF Futures Only public dataset gpe5-46if. */
export const PUBLIC_CONTRACT_CODES = ['13874A', '209742', '239742', '124603', '020601', '043602'] as const;
const RELATED_CONTRACTS: Record<string, readonly string[]> = { SPY: ['13874A'], VOO: ['13874A'], QQQ: ['209742'], IWM: ['239742'], DIA: ['124603'], TLT: ['020601'], IEF: ['043602'] };
export function contractsForSymbol(symbol: string): readonly string[] { return RELATED_CONTRACTS[symbol] ?? PUBLIC_CONTRACT_CODES; }
export function hasRelatedContract(symbol: string): boolean { return !!RELATED_CONTRACTS[symbol]; }
export function latestPublicPositioning(value: unknown, codes: readonly string[] = PUBLIC_CONTRACT_CODES): Positioning[] {
  if (!Array.isArray(value)) return [];
  const latest = new Map<string, Positioning>();
  for (const item of value) {
    const row = object(item), contractCode = string(row.cftc_contract_market_code, 10), reportDate = publicDate(row.report_date_as_yyyy_mm_dd), market = string(row.market_and_exchange_names, 250) || string(row.contract_market_name, 250);
    // Futures-only and futures/options-combined counts are different namespaces.
    if (row.futonly_or_combined !== 'FutOnly' || !codes.includes(contractCode) || !reportDate || !market) continue;
    const previous = latest.get(contractCode); if (previous && previous.reportDate >= reportDate) continue;
    latest.set(contractCode, {
      id: `cftc-tff-futures:${contractCode}:${reportDate}`, market, contractCode, reportDate, units: string(row.contract_units, 200) || 'Contract specification unavailable',
      openInterest: publicCount(row.open_interest_all), assetManagerLong: publicCount(row.asset_mgr_positions_long), assetManagerShort: publicCount(row.asset_mgr_positions_short), leveragedLong: publicCount(row.lev_money_positions_long), leveragedShort: publicCount(row.lev_money_positions_short), dealerLong: publicCount(row.dealer_positions_long_all), dealerShort: publicCount(row.dealer_positions_short_all),
    });
  }
  return codes.flatMap(code => latest.has(code) ? [latest.get(code)!] : []);
}
