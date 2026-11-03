import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { siteUrl } from '@/lib/site';
import './globals.css';
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'The Daily Consensus | Your Morning Market Map',
  description: 'A visual morning view of market signals, rates, currencies, liquidity and institutional positioning. Inspect the evidence, agreement and missing inputs. Free for everyone.',
  openGraph: { siteName: 'The Daily Consensus', type: 'website', locale: 'en_US' },
  twitter: { card: 'summary', title: 'The Daily Consensus', description: 'Independent market research. Free for every reader.' },
};
const themeInit = `try{var t=localStorage.getItem('tdc-theme');document.documentElement.dataset.theme=t==='light'?'light':'dark'}catch{}`;
export default async function RootLayout({children}:{children:React.ReactNode}) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return <html lang="en" suppressHydrationWarning><head><script nonce={nonce} dangerouslySetInnerHTML={{__html:themeInit}} /></head><body>{children}</body></html>;
}
