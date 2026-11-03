# The Daily Consensus relaunch

Goal: recover and rebuild the original service as a free public market-research site, deploy and verify it, then update the owner's LinkedIn with actual delivered capabilities. The user asked for a continuing goal/loop. Do not stop at a local demo.

Canonical app: `web/` (Next.js 16 / React 19). Root source is the preserved old prototype. Branch: `codex/daily-consensus-relaunch`. Production project: existing Vercel `v0-the-daily-consensus`.

Current implementation: source-linked published brief; hosted market chart/technical/profile/news widgets; official SEC filings; CFTC futures-only category positions; FRED macro observations; 58 full archived articles with 106 locally preserved media references; watchlist; light/dark themes; responsive navigation; 41 original article redirects; sitemap/robots/health.

Data constraints: public reads never call OpenAI or private Polygon APIs. No keys are needed. Use the user's Codex subscription to prepare editorial editions from official evidence; use scripts and the publishing runbook. Do not buy API credits or paid feeds. Never infer missing values as zero. Keep observation dates separate from retrieval dates. TradingView content stays inside its hosted widgets.

Verification before deployment: typecheck and 30 tests passed; production build generated 68 pages. Public provider audit matched 12 brief facts. All 58 archive routes and 106 media references returned 200 locally, unknown article returned 404. Production root/API/robots/sitemap checks passed without authentication. All 58 production article URLs and 103 unique media URLs returned 200. Charts, ticker/theme switches, brief and archived reader rendered correctly; production browser logs were clean. A 390px viewport had no document overflow and mobile navigation/positioning worked.

Live alias: https://v0-the-daily-consensus.vercel.app . LinkedIn company tagline/overview/website/specialties and a separate November2026-present Founder & Operator role are saved and verified. Original experience and other current employment remain. Remaining boundaries: custom domain DNS currently Bluehost; authenticated WordPress drafts/export remain unavailable. Do not send messages to other people.

Operational evidence lives in `web/docs/`; private recovery ledger is outside Git. The existing Codex restoration heartbeat runs every 30 minutes in the original chat, quiet unless progress/failure/action is meaningful. Prevent concurrent deployments or competing local/remote editors; an idle Parcel copy is a continuation backup, not proof of a running worker.
