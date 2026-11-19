import { getPublishedBrief } from '@/lib/published-brief';
import { getPublishedInstrumentBrief } from '@/lib/published-instrument-reports';
import { INSTRUMENT_REPORTS } from '@/lib/instrument-reports';
import { publishedSnapshot } from '@/lib/consensus/published-snapshot';
import { asIssuedConsensus } from '@/lib/consensus/as-issued';

export function GET() {
  const brief = getPublishedBrief();
  const reports = Object.fromEntries(INSTRUMENT_REPORTS.map(({ symbol }) => {
    const report = getPublishedInstrumentBrief(symbol);
    return [symbol, { status: report.status, publishedAt: report.createdAt }];
  }));
  const snapshot = publishedSnapshot();
  const consensus = asIssuedConsensus(snapshot, 'MARKET', 'daily');
  return Response.json({ service: 'The Daily Consensus', mode: 'free-public', status: 'ready', research: { status: brief.status, publishedAt: brief.createdAt }, reports, consensus: { edition: snapshot.id, consensusBasis: 'as-issued', coverage: consensus.coverage, directionalCoverage: consensus.directionalCoverage, abstain: consensus.abstain, productScope: 'in_progress' }, runtimeGeneration: false }, { headers: { 'Cache-Control': 'no-store' } });
}
