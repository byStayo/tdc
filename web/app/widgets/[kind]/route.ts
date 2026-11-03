import { isPublicSymbol } from '@/lib/public-normalization';
import { isWidgetKind, tradingViewDocument } from '@/lib/tradingview-config';

export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  const { kind } = await context.params;
  if (!isWidgetKind(kind)) return new Response('Unknown widget', { status: 404 });
  const query = new URL(request.url).searchParams;
  const symbol = query.get('symbol') ?? 'SPY', theme = query.get('theme') ?? 'dark', newsScope = query.get('newsScope') ?? 'symbol';
  if (!isPublicSymbol(symbol) || (theme !== 'dark' && theme !== 'light') || (newsScope !== 'symbol' && newsScope !== 'market')) return new Response('Invalid widget parameters', { status: 400 });
  return new Response(tradingViewDocument(kind, symbol, theme, newsScope), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=86400',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Only this public widget document may be framed, and only by this site.
    'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'",
  } });
}
