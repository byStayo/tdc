import type { NextConfig } from 'next';
import legacyRedirects from './lib/legacy-redirects.json';
const config: NextConfig = {
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: {
    '/': ['./lib/consensus/current.json'],
    '/api/consensus': ['./lib/consensus/current.json'],
    '/api/health': ['./lib/consensus/current.json'],
  },
  poweredByHeader: false,
  async redirects() { return legacyRedirects; },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }, { source: '/widgets/:path*', headers: [
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    ] }];
  },
};
export default config;
