import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'", // Existing charts use inline size/color styles.
    "img-src 'self' https: data: blob:", "font-src 'self'", "connect-src 'self'",
    "frame-src 'self' https://www.tradingview-widget.com", "object-src 'none'", "base-uri 'self'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: "/((?!api(?:/|$)|widgets(?:/|$)|_next/|consensus/|reports/|media/|favicon.ico|robots.txt|sitemap.xml).*)",
};
