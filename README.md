# The Daily Consensus — public research desk

The canonical application is `web/`. The older React prototype at the repository root is retained as historical source and is not deployed.

The rebuild is free to readers: no account, checkout, paywall, or per-reader AI generation. It combines published AI-assisted editorial research with SEC filings, CFTC futures positioning, FRED economic series, and TradingView's official hosted market widgets. Each source keeps its own observation date and limitations.

## Run and verify

From `web/`:

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

The development URL is `http://127.0.0.1:3107`. No API keys are required. The public API never calls the recovered private Polygon or OpenAI accounts. Prices remain inside the attributed hosted widgets and are not extracted into the editorial analysis.

## Preserved research

The local archive has 58 original articles: 41 from WordPress and 17 from Substack. Original text, dates, authors, captions, and 106 image references are preserved. The images resolve to 103 local files, with source URLs and SHA256 hashes in `web/public/archive-media/manifest.json`. Historical articles carry an explicit date/context notice. Subscription forms and tracking embeds were removed. The 41 old WordPress article paths redirect to their new reader pages.

The authenticated WordPress export, two draft pages, form responses, all 104 original media files, and complete database/hosting backups were recovered separately and kept private outside this repository. The public archive contains published research only. Recovery does not establish access to deleted content.

## Publishing and operations

See `web/docs/EDITORIAL.md` for the subscription-based publishing workflow and `web/docs/SOURCES.md` for provider boundaries. `GET /api/health` reports application/edition status. `GET /api/research` serves the published brief and labels it historical after 72 hours. Reading the site never starts a model job.

The production project is the existing `v0-the-daily-consensus` Vercel project. Deploy from `web/` using the authenticated Vercel CLI, after checks pass. Preserve existing production protection settings. The canonical address is https://thedailyconsensus.com, with https://v0-the-daily-consensus.vercel.app as a working alternate. Bluehost remains the DNS provider; the website A record now points to Vercel. The new origin passes HTTPS, API, archive, sitemap and redirect checks. Resolver propagation is recorded separately in `web/docs/domain-cutover-verification.json`; old cached DNS can temporarily reach the previous host.

The preserved utilities for market calculations are tested but do not imply a publicly licensed raw market-data feed. Options chains, dark-pool direction, and social sentiment are not supplied by the free sources used here. SEC Form 4 filings do not by themselves identify open-market purchases; CFTC categories are reported aggregate futures positions, not individual identities or real-time flows.
