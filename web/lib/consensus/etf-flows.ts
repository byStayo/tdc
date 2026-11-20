import { createHash } from 'node:crypto';
import type { PublicDocument } from './calendars.ts';
import type { Instrument, Signal, Snapshot } from './types.ts';
import { sourceFailureKind } from './source-failure.ts';

export const ETF_FLOW_URL = 'https://etfiq.com/data/flows/daily/latest.json';
export const ETF_FLOW_LICENSE = 'https://etfiq.com/license/';
export const ETF_FLOW_PREFIX = 'etfiq-flow-';
const symbols = ['MARKET', 'SPY', 'QQQ', 'IWM', 'DIA', 'TLT'] as const;
const attribution = 'Source: ETFIQ (https://etfiq.com/flows/). Computed figures selected by The Daily Consensus; no endorsement implied.';
const usage = `ETFIQ-computed figures may be reused, republished and used in models with attribution: ${ETF_FLOW_LICENSE}. Issuer NAV, net assets, share counts and vendor prices are excluded.`;
const frequency = 'daily fund creations/redemptions; dated issuer counts';
function fail(): never { throw new Error('Invalid ETFIQ daily flow document'); }
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail();
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const instant = (x: string) => Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const date = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
type Flow = { ticker: string; status: 'ok' | 'held' | 'spans-sessions'; flowUsd: number | null; roundTripUsd: number | null; flowPct: number | null; navDate: string | null };

/** Copy only the provider's computed fields; issuer assets/NAVs are validation inputs, never output. */
export function parseEtfFlows(text: string, cutoff: string) {
  if (Buffer.byteLength(text) > 2_000_000 || !instant(cutoff)) fail();
  const raw = object(JSON.parse(text)), cite = object(raw.cite), window = object(raw.window), total = object(raw.total);
  if (raw.schemaVersion !== 1 || raw.basis !== 'daily' || !date(raw.asOf) || raw.asOf > cutoff.slice(0,10) ||
      cite.publisher !== 'ETFIQ' || cite.page !== 'https://etfiq.com/flows/' || cite.class !== 'ETFIQ-computed' ||
      cite.license !== ETF_FLOW_LICENSE || cite.as_of !== raw.asOf || window.from !== raw.asOf || window.to !== raw.asOf ||
      window.days !== 1 || !date(window.opens) || window.opens >= raw.asOf || !Array.isArray(raw.funds) || !raw.funds.length || raw.funds.length > 20_000) fail();
  const asOf = raw.asOf;
  const tickers = new Set<string>();
  const funds: Flow[] = raw.funds.map(input => {
    const row = object(input);
    if (typeof row.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(row.ticker) || tickers.has(row.ticker) ||
        row.basis !== 'daily' || typeof row.held !== 'boolean' || !['ok','held','spans-sessions'].includes(String(row.status)) ||
        row.held !== (row.status === 'held') || row.page !== `https://etfiq.com/funds/${row.ticker.toLowerCase()}` ||
        (row.navDate !== null && (!date(row.navDate) || row.navDate > asOf))) fail();
    tickers.add(row.ticker);
    const available = row.status === 'ok';
    if (available) {
      if (!integer(row.flowUsd) || !integer(row.roundTripUsd)) fail();
      if (row.startNetAssetsUsd === null) { if (row.flowPctOfStartNetAssets !== null) fail(); }
      else {
        if (!finite(row.startNetAssetsUsd) || row.startNetAssetsUsd <= 0 || !date(row.startNetAssetsDate) ||
            row.startNetAssetsDate !== window.opens || !finite(row.flowPctOfStartNetAssets) ||
            Math.abs(row.flowPctOfStartNetAssets - Math.round(row.flowUsd / row.startNetAssetsUsd * 10_000) / 100) > 1e-8) fail();
      }
    } else if (row.flowUsd !== null || row.roundTripUsd !== null || row.flowPctOfStartNetAssets !== null) fail();
    return { ticker: row.ticker, status: row.status as Flow['status'], flowUsd: row.flowUsd as number | null,
      roundTripUsd: row.roundTripUsd as number | null, flowPct: row.flowPctOfStartNetAssets as number | null, navDate: row.navDate as string | null };
  });
  const available = funds.filter(row => row.status === 'ok'), held = funds.filter(row => row.status === 'held').length;
  if (!integer(total.funds) || total.funds !== available.length || !integer(total.heldFunds) || total.heldFunds !== held ||
      !integer(total.flowUsd) || total.flowUsd !== available.reduce((sum,row) => sum + row.flowUsd!,0) ||
      !integer(total.roundTripUsd) || total.roundTripUsd !== available.reduce((sum,row) => sum + row.roundTripUsd!,0)) fail();
  return { asOf, funds, total: { funds: available.length, heldFunds: held,
    excludedSessions: funds.filter(row => row.status === 'spans-sessions').length, flowUsd: total.flowUsd, roundTripUsd: total.roundTripUsd } };
}

function baseSignal(symbol: typeof symbols[number], retrievedAt: string): Signal {
  return { id: ETF_FLOW_PREFIX + symbol, family: 'capital', title: symbol === 'MARKET' ? 'US ETF net flows · covered daily sample' : `${symbol} · daily net fund flow`,
    shortLabel: symbol === 'MARKET' ? 'US ETF flow sample' : `${symbol} fund flow`, instruments: [symbol], directionalInstruments: [], status: 'unavailable',
    summary: 'No verified daily ETF flow observation returned.', source: { name: 'ETFIQ · computed daily fund flows', url: ETF_FLOW_URL,
      retrievedAt, observedAt: null, releasedAt: null, frequency, attribution, usage, sha256: null },
    methodology: 'ETFIQ computes creations/redemptions from changes in issuer share counts valued at the earlier NAV, adjusted for confirmed splits. The displayed flow date follows the provider count convention and reflects the previous trading day’s orders. Only its computed flows and coverage counts are republished. Held rows and counts spanning sessions are excluded, never set to zero.',
    limitation: 'Flows do not identify investors or trade direction, are not returns or private-equity flows, and do not measure real-time buying. Coverage is a dated provider sample, not the entire US ETF market. No directional vote or model accuracy is inferred.',
    series: [], metrics: [], scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 7, unit: 'USD net flow' };
}

export async function collectEtfFlows(read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Signal[]> {
  const started = now();
  try {
    const doc = await read(ETF_FLOW_URL);
    if (!instant(doc.retrievedAt) || doc.retrievedAt > now() || createHash('sha256').update(doc.text).digest('hex') !== doc.sha256) fail();
    const parsed = parseEtfFlows(doc.text, doc.retrievedAt);
    return symbols.map(symbol => {
      const base = baseSignal(symbol, doc.retrievedAt), row = parsed.funds.find(row => row.ticker === symbol);
      if (symbol === 'MARKET' && parsed.total.funds === 0) return {...base,summary:`No eligible one-day observations in the provider file dated ${parsed.asOf}; held and multi-session rows do not establish a zero flow.`};
      if (symbol !== 'MARKET' && (!row || row.status !== 'ok')) return { ...base,
        summary: !row ? `${symbol} is not included in the provider’s daily flow file dated ${parsed.asOf}. No zero or substituted observation is inferred.`
          : `${symbol} is ${row.status === 'held' ? 'held for provider review' : 'excluded because its count spans sessions'} in the file dated ${parsed.asOf}. No daily flow is inferred.` };
      const value = symbol === 'MARKET' ? parsed.total.flowUsd : row!.flowUsd!, roundTrip = symbol === 'MARKET' ? parsed.total.roundTripUsd : row!.roundTripUsd!;
      const metrics = [{label:'Net creations / redemptions',value,unit:'USD',date:parsed.asOf},
        {label:'Round trips included in net flow',value:roundTrip,unit:'USD',date:parsed.asOf}];
      if (symbol === 'MARKET') metrics.push(...[
        {label:'Funds with daily observations',value:parsed.total.funds}, {label:'Funds held for review',value:parsed.total.heldFunds},
        {label:'Funds excluded for multi-session counts',value:parsed.total.excludedSessions},
      ].map(m => ({...m,unit:'funds',date:parsed.asOf})));
      else if (row!.flowPct !== null) metrics.push({label:'Flow / previous net assets',value:row!.flowPct!,unit:'%',date:parsed.asOf});
      return {...base,status:'available',series:[{date:parsed.asOf,value}],metrics,
        summary:`${symbol === 'MARKET' ? `${parsed.total.funds} covered ETFs` : symbol}: ${value.toLocaleString('en-US')} USD net flow dated ${parsed.asOf}.${symbol === 'MARKET' ? ` ${parsed.total.heldFunds} funds held for review and ${parsed.total.excludedSessions} multi-session counts excluded.` : ` Source NAV date: ${row!.navDate ?? 'unavailable'}.`} Dated creations/redemptions context; no directional vote.`,
        source:{...base.source,observedAt:parsed.asOf,sha256:doc.sha256}};
    });
  } catch (error) { return symbols.map(symbol => ({...baseSignal(symbol,started),failureKind:sourceFailureKind(error)})); }
}

export function validateEtfFlows(signal: Signal): void {
  if (!signal.id.startsWith(ETF_FLOW_PREFIX)) return;
  const symbol = signal.id.slice(ETF_FLOW_PREFIX.length);
  if (!symbols.includes(symbol as typeof symbols[number]) || signal.family !== 'capital' || signal.instruments.join() !== symbol ||
      !signal.directionalInstruments || signal.directionalInstruments.length || Object.values(signal.scores).some(value => value !== null) ||
      signal.source.url !== ETF_FLOW_URL || signal.source.attribution !== attribution || signal.source.usage !== usage || signal.source.frequency !== frequency ||
      signal.source.releasedAt !== null || signal.staleAfterDays !== 7 || signal.unit !== 'USD net flow') throw new Error('Invalid saved ETF flow scope or provenance');
  if (signal.status === 'unavailable') {
    if (signal.series.length || signal.metrics.length || signal.source.observedAt || signal.source.sha256) throw new Error('Unavailable flow contains observations');
    return;
  }
  if (!date(signal.source.observedAt) || !signal.source.sha256 || signal.series.length !== 1 || signal.series[0].date !== signal.source.observedAt ||
      !integer(signal.series[0].value) || signal.metrics.length < 2 || signal.metrics.length > 5 ||
      signal.metrics[0].label !== 'Net creations / redemptions' || signal.metrics[0].unit !== 'USD' || signal.metrics[0].value !== signal.series[0].value ||
      signal.metrics[1].label !== 'Round trips included in net flow' || signal.metrics[1].unit !== 'USD' || !integer(signal.metrics[1].value) ||
      signal.metrics.some(m => m.date !== signal.source.observedAt || !finite(m.value))) throw new Error('Invalid saved ETF flow observations');
  const rest = signal.metrics.slice(2);
  if (symbol === 'MARKET') {
    if (rest.length !== 3 || rest.map(m => m.label).join('|') !== 'Funds with daily observations|Funds held for review|Funds excluded for multi-session counts' ||
        rest.some(m => m.unit !== 'funds' || !integer(m.value) || m.value < 0) || rest[0].value <= 0) throw new Error('Invalid ETF sample coverage');
  } else if (rest.length > 1 || rest.some(m => m.label !== 'Flow / previous net assets' || m.unit !== '%')) throw new Error('Invalid ETF flow metrics');
}

export async function refreshEtfFlows(previous: Snapshot, read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Snapshot> {
  const flows = await collectEtfFlows(read,now), issuedAt = now();
  const signals = previous.signals.filter(s => !s.id.startsWith(ETF_FLOW_PREFIX));
  const anchor = signals.findIndex(s => s.id === 'quantisnow-monthly-ratings' || s.id.startsWith('twse-') || s.id === 'fed-private-credit-loans');
  signals.splice(anchor < 0 ? signals.length : anchor,0,...flows);
  return {...previous,id:issuedAt.replace(/[:.]/g,'-'),issuedAt,cutoff:issuedAt,consensus:undefined,forecasts:undefined,
    signals,sourcesAttempted:1,
    collectionErrors:[...previous.collectionErrors.filter(e => !e.startsWith(ETF_FLOW_PREFIX)),...flows.filter(s => s.failureKind).map(s => `${s.id}: ${s.summary}`)]};
}
