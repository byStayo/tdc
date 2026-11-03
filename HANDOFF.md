# The Daily Consensus relaunch

Goal: recover and rebuild the original service as a free public market-research site, deploy and verify it, then update the owner's LinkedIn with actual delivered capabilities. The user asked for a continuing goal/loop. Do not stop at a local demo.

Canonical app: `web/` (Next.js 16 / React 19). Root source is the preserved old prototype. Branch: `codex/daily-consensus-relaunch`. Production project: existing Vercel `v0-the-daily-consensus`.

Current implementation: source-linked published brief; hosted market chart/technical/profile/news widgets; official SEC filings; CFTC futures-only category positions; FRED macro observations; 58 full archived articles with 106 locally preserved media references; watchlist; light/dark themes; responsive navigation; 41 original article redirects; sitemap/robots/health.

Data constraints: public reads never call OpenAI or private Polygon APIs. No keys are needed. Use the user's Codex subscription to prepare editorial editions from official evidence; use scripts and the publishing runbook. Do not buy API credits or paid feeds. Never infer missing values as zero. Keep observation dates separate from retrieval dates. TradingView content stays inside its hosted widgets.

Verification before deployment: typecheck and 30 tests passed; production build generated 68 pages. Public provider audit matched 12 brief facts. All 58 archive routes and 106 media references returned 200 locally, unknown article returned 404. Production root/API/robots/sitemap checks passed without authentication. All 58 production article URLs and 103 unique media URLs returned 200. Charts, ticker/theme switches, brief and archived reader rendered correctly; production browser logs were clean. A 390px viewport had no document overflow and mobile navigation/positioning worked.

Canonical address: https://thedailyconsensus.com; alternate: https://v0-the-daily-consensus.vercel.app. Latest production deployment: dpl_F7waipY9ULUpxkUvPmcyWqVqMwc4. Bluehost A record changed to216.150.1.1 with15minuteTTL; auto-renewing Vercel TLS covers apex and www. The new origin passes10 public HTTPS/API/archive/canonical/redirect checks without authentication or TLS bypass. DNS answers are still inconsistent across resolver caches; verify the default public route before closing the restoration goal. Never undo the cutover merely because an old cached response is observed.

Authenticated WordPress recovery is complete:188 WXR objects including2draft pages,104 original media files,7.9MB database SQL, and a2.71GB hosting file backup with176,315 archive members. Integrity hashes/manifests are private outsideGit. Do not upload these backups or original credential files. No hosting account or backup was deleted.

LinkedIn company tagline/overview/website/specialties and a separate November2026-present Founder & Operator role are saved and verified. Company and experience now link the original domain. Original experience and other current employment remain; network notifications stayed off and no feed announcement was published. Do not send messages to other people.

Final browser check confirms broad-market headlines for ETFs. A third-party TradingView console warning can occur when navigating away before its chart script initializes; rendered charts and other views work. Do not claim every rapid-navigation browser log is clean.

Operational evidence lives in `web/docs/`; private recovery ledger is outside Git. The existing Codex restoration heartbeat runs every30minutes in the original chat. Remaining work is default-route DNS verification and final goal/loop closure. After restoration is verified, use a weekday morning subscription editorial loop to collect official evidence, publish only verified meaningful updates, run checks, deploy and verify; never purchase feeds/API credits or publish LinkedIn posts automatically. Prevent concurrent deployments or competing local/remote editors; an idle Parcel copy is a continuation backup, not proof of a running worker.
