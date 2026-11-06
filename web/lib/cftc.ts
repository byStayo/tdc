import 'server-only';
import type { DataStatus, Envelope, Positioning } from './contracts';
import { contractsForSymbol, hasRelatedContract, latestPublicPositioning, PUBLIC_CONTRACT_CODES } from './public-normalization';

const FIELDS = ['id', 'report_date_as_yyyy_mm_dd', 'contract_market_name', 'market_and_exchange_names', 'cftc_contract_market_code', 'contract_units', 'open_interest_all', 'asset_mgr_positions_long', 'asset_mgr_positions_short', 'lev_money_positions_long', 'lev_money_positions_short', 'dealer_positions_long_all', 'dealer_positions_short_all', 'futonly_or_combined'];

export async function getCFTCPositioning(symbol: string): Promise<Envelope<Positioning[]>> {
  const fetchedAt = new Date().toISOString(), codes = contractsForSymbol(symbol);
  const coverage = hasRelatedContract(symbol) ? `Related futures-market context for ${symbol}; these are futures positions, not ETF holdings, equity trades or dark-pool activity.` : `Broad-market context across six index and Treasury futures contracts. This is not positioning in ${symbol}${symbol === 'GLD' ? '; COMEX gold is outside this financial-futures dataset' : ''}.`;
  const base = { source: 'CFTC · Traders in Financial Futures · Futures Only', fetchedAt, coverage };
  try {
    const url = new URL('https://publicreporting.cftc.gov/resource/gpe5-46if.json');
    url.searchParams.set('$limit', '100');
    url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
    url.searchParams.set('$select', FIELDS.join(','));
    url.searchParams.set('$where', `cftc_contract_market_code in (${PUBLIC_CONTRACT_CODES.map(code => `'${code}'`).join(',')})`);
    const response = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 21_600 }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return { ...base, status: response.status === 429 ? 'rate_limited' : 'unavailable', asOf: null, data: [], message: 'The CFTC public reporting endpoint is temporarily unavailable. No positioning values are substituted.' };
    const data = latestPublicPositioning(await response.json(), codes), dates = data.map(row => row.reportDate).sort();
    const stale = data.some(row => Date.now() - Date.parse(`${row.reportDate}T00:00:00Z`) > 14 * 86_400_000);
    const incomplete = data.length !== codes.length || data.some(row => [row.openInterest, row.assetManagerLong, row.assetManagerShort, row.leveragedLong, row.leveragedShort, row.dealerLong, row.dealerShort].some(value => value === null));
    const status: DataStatus = !data.length ? 'unavailable' : stale ? 'stale' : incomplete ? 'partial' : 'ok';
    return { ...base, status, asOf: dates.at(-1) ?? null, data, message: `${stale ? 'At least one report is more than 14 days old. ' : ''}${incomplete ? 'Some requested contracts or fields were not returned. ' : ''}Weekly observations are generally measured Tuesday and released Friday. Each contract keeps its own report date and units; counts are not summed across markets. Trader categories do not reveal individual identities, intent or a forecast.` };
  } catch { return { ...base, status: 'unavailable', asOf: null, data: [], message: 'The CFTC public reporting endpoint did not return usable data. No positioning values are substituted.' }; }
}
