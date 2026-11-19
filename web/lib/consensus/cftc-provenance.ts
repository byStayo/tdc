import { publicDate } from '../public-normalization.ts';
import { newYorkDate } from './time.ts';
import type { Signal } from './types.ts';

export const isCftcPosition = (id: string) => /^cftc-[0-9A-Z]{6}-(asset|leveraged)$/.test(id);

type TableClock = { createdAt: string; updatedAt: string };
function fixedTimestamp(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !publicDate(value) ||
    !/T\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    return null;
  return new Date(value).toISOString();
}

export function cftcReportCitation(day: string, contract: string) {
  const url = new URL('https://publicreporting.cftc.gov/resource/gpe5-46if.json');
  url.searchParams.set('id', `${day.replaceAll('-', '').slice(2)}${contract}F`);
  url.searchParams.set(
    '$select',
    'id,cftc_contract_market_code,report_date_as_yyyy_mm_dd,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short,:created_at,:updated_at'
  );
  return url.href;
}

/** Socrata's UTC row creation and version clocks apply only to the public table. */
export function cftcTableClock(
  raw: Record<string, unknown>,
  day: string,
  code: string,
  collectedAt?: string
): TableClock | null {
  if (raw[':created_at'] == null && raw[':updated_at'] == null) return null;
  const createdAt = fixedTimestamp(raw[':created_at']),
    updatedAt = fixedTimestamp(raw[':updated_at']);
  if (
    !createdAt ||
    !updatedAt ||
    newYorkDate(createdAt) < day ||
    updatedAt < createdAt ||
    (collectedAt !== undefined && updatedAt > collectedAt) ||
    raw.id !== `${day.replaceAll('-', '').slice(2)}${code}F`
  )
    throw new Error('Invalid CFTC public table identity or publication clock');
  return { createdAt, updatedAt };
}

export function validateCftcProvenance(signal: Signal) {
  const { observedAt, releasedAt, vintageAt, retrievedAt } = signal.source;
  if (!isCftcPosition(signal.id) || (releasedAt == null && vintageAt === undefined)) return;
  if (
    !observedAt ||
    observedAt !== publicDate(observedAt) ||
    signal.series.at(-1)?.date !== observedAt ||
    !releasedAt ||
    !vintageAt ||
    fixedTimestamp(releasedAt) !== releasedAt ||
    fixedTimestamp(vintageAt) !== vintageAt ||
    newYorkDate(releasedAt) < observedAt ||
    vintageAt < releasedAt ||
    vintageAt > retrievedAt ||
    signal.source.url !== cftcReportCitation(observedAt, signal.id.split('-')[1]) ||
    !['available', 'stale'].includes(signal.status)
  )
    throw new Error(`Invalid CFTC public table provenance for ${signal.id}`);
}
