import 'server-only';
import type { Company, Envelope, SourceState, Workspace } from './contracts';
import archive from './research-archive.json';
import saved from './saved-public-data.json';
import { savedPublicContext, type SavedPublicData } from './saved-public-data';
import { isPublicRange, isPublicSymbol } from './public-normalization';

export async function getPublicWorkspace(symbol: string, range = '3M'): Promise<Workspace> {
  if (!isPublicSymbol(symbol) || !isPublicRange(range)) throw new Error('Invalid public workspace request');
  const fetchedAt = saved.collectedAt;
  const {macro, filings, positioning} = savedPublicContext(saved as SavedPublicData, symbol);
  const empty = <T>(data: T, source: string, message: string): Envelope<T> => ({ status: 'unavailable', source, asOf: null, fetchedAt, data, message });
  const quotes = empty<Workspace['quotes']['data']>([], 'TradingView hosted market display', 'Price data is displayed only within the official hosted market widget. This public API does not redistribute a private market-data subscription.');
  const history = empty<Workspace['history']['data']>([], 'TradingView hosted chart', 'Interactive prices and technical studies are available in the official hosted chart. No separately licensed price history is supplied by this public API.');
  const options = empty<Workspace['options']['data']>([], 'Options data', 'No public redistribution feed for options contracts is connected. Futures positioning is available separately from the CFTC.');
  const company = empty<Company | null>(null, 'Issuer profiles', 'SEC filing metadata and links are available separately. No private company-reference dataset is redistributed.');
  const news = empty<Workspace['news']['data']>([], 'Hosted headlines', 'Current headlines are displayed through the official hosted news widget. SEC filings and the original editorial archive are available separately.');
  const sources: SourceState[] = [
    { id: 'sec', name: 'SEC filings', status: filings.status, asOf: filings.asOf, url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(symbol)}`, description: `${filings.coverage} ${filings.message ?? ''}` },
    { id: 'cftc', name: 'CFTC futures positioning', status: positioning.status, asOf: positioning.asOf, url: 'https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if', description: `${positioning.coverage} ${positioning.message ?? ''}` },
    { id: 'macro', name: 'FRED macro data', status: macro.status, asOf: null, url: 'https://fred.stlouisfed.org', description: `${macro.coverage} ${macro.message ?? ''}` },
    { id: 'archive', name: 'Original research', status: 'ok', asOf: archive[0]?.publishedAt ?? null, url: 'https://dailyconsensus.substack.com', description: '58 recovered historical publications, with original publication dates and attribution. Historical views are not current market signals.' },
    { id: 'hosted-markets', name: 'TradingView market widgets', status: 'partial', asOf: null, url: 'https://www.tradingview.com/widget/', description: 'Hosted display only. Official widgets supply their own prices, charts and headlines. Availability and any exchange delay are determined inside the widgets; this API does not verify or redistribute that content.' },
    { id: 'options', name: 'Options contract feed', status: 'unconfigured', asOf: null, url: 'https://thedailyconsensus.com', description: 'A public redistribution feed is not connected. No contract prices or dealer-gamma estimates are invented.' },
    { id: 'darkpool', name: 'Dark-pool analysis', status: 'unconfigured', asOf: null, url: 'https://thedailyconsensus.com/consensus-report/', description: 'No publicly redistributable original dark-pool source has been connected. CFTC weekly futures reports are not dark-pool data.' },
    { id: 'social', name: 'Social positioning', status: 'unconfigured', asOf: null, url: 'https://thedailyconsensus.com/consensus-report/', description: 'No current social-media feed or validated inverse-sentiment model is connected.' },
  ];
  return { mode: 'public', symbol, fetchedAt, market: { state: 'public_research', asOf: null }, quotes, history, news, options, company, indicators: [], archive, sources, macro, filings, positioning };
}
