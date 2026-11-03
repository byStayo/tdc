import { getPublicWorkspace } from '@/lib/public-market';
import { isPublicRange, isPublicSymbol } from '@/lib/public-normalization';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url), symbol = url.searchParams.get('symbol') ?? 'SPY', range = url.searchParams.get('range') ?? '3M';
  if (!isPublicSymbol(symbol) || !isPublicRange(range)) return Response.json({ message: 'Use a valid uppercase US equity ticker and range 1M, 3M, 6M or 1Y.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  try {
    // This public route never accepts a private-mode override or calls the private provider adapter.
    const workspace = await getPublicWorkspace(symbol, range);
    return Response.json(workspace, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return Response.json({ message: 'The research workspace is temporarily unavailable. Please try again.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
