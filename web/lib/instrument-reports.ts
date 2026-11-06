/** Initial editorial coverage; this is not a claim about the original service's five symbols. */
export const INSTRUMENT_REPORTS = [
  { symbol: 'SPY', name: 'S&P 500', sourceId: 'CFTC_ES', contractCode: '13874A' },
  { symbol: 'QQQ', name: 'Nasdaq-100', sourceId: 'CFTC_NQ', contractCode: '209742' },
  { symbol: 'IWM', name: 'Russell 2000', sourceId: 'CFTC_RTY', contractCode: '239742' },
  { symbol: 'DIA', name: 'Dow', sourceId: 'CFTC_DOW', contractCode: '124603' },
  { symbol: 'TLT', name: 'Long Treasuries', sourceId: 'CFTC_BOND', contractCode: '020601' },
] as const;

export type ReportSymbol = (typeof INSTRUMENT_REPORTS)[number]['symbol'];
export function instrumentReport(symbol: unknown) {
  return INSTRUMENT_REPORTS.find(report => report.symbol === symbol);
}
