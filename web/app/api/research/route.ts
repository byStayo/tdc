import { getPublishedBrief } from '@/lib/published-brief';
import { getPublishedInstrumentBrief } from '@/lib/published-instrument-reports';
import { isPublicSymbol } from '@/lib/public-normalization';

// Readers receive an already published brief; this route never calls a model.
export function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get('symbol');
  if (symbol !== null && !isPublicSymbol(symbol)) return Response.json({ status: 'unavailable', scope: 'instrument', data: null, message: 'Enter a valid uppercase instrument symbol.' }, { status: 400 });
  return Response.json(symbol === null ? getPublishedBrief() : getPublishedInstrumentBrief(symbol), { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } });
}

export function POST() {
  return Response.json(getPublishedBrief(), { headers: { 'Cache-Control': 'no-store' } });
}
