import { getPublishedBrief } from '@/lib/published-brief';

export function GET() {
  const brief = getPublishedBrief();
  return Response.json({ service: 'The Daily Consensus', mode: 'free-public', status: 'ready', research: { status: brief.status, publishedAt: brief.createdAt }, runtimeGeneration: false }, { headers: { 'Cache-Control': 'no-store' } });
}
