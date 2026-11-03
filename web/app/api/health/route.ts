import { getPublishedBrief } from '@/lib/published-brief';
import { getPublishedInstrumentBrief } from '@/lib/published-instrument-reports';
import { INSTRUMENT_REPORTS } from '@/lib/instrument-reports';

export function GET() {
  const brief = getPublishedBrief();
  const reports = Object.fromEntries(INSTRUMENT_REPORTS.map(({ symbol }) => {
    const report = getPublishedInstrumentBrief(symbol);
    return [symbol, { status: report.status, publishedAt: report.createdAt }];
  }));
  return Response.json({ service: 'The Daily Consensus', mode: 'free-public', status: 'ready', research: { status: brief.status, publishedAt: brief.createdAt }, reports, runtimeGeneration: false }, { headers: { 'Cache-Control': 'no-store' } });
}
