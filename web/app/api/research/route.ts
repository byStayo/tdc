import { getPublishedBrief } from '@/lib/published-brief';

// Readers receive an already published brief; this route never calls a model.
export function GET() {
  return Response.json(getPublishedBrief(), { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } });
}

export function POST() {
  return Response.json(getPublishedBrief(), { headers: { 'Cache-Control': 'no-store' } });
}
