# Bluesky market-discussion sample

The free [Jetstream v2 live tail](https://bsky.network/docs/jetstream/) is a separate community source. It is not X, Instagram, all Bluesky or representative retail positioning. The [developer guidelines](https://bsky.network/docs/developer-guidelines/) require deletion/report handling and an accessible monitored contact. The owner explicitly selected **support@thedailyconsensus.com**. No email was sent and inbox delivery/monitoring has not been tested by Codex.

## Collection and interpretation

`npm run consensus:bluesky-private -- --seconds 600` captures a bounded live window (10–900seconds,100,000events/50MB maximum) using no API key. It processes creates/edits/deletes and account removals, handles duplicate/out-of-order record events, and keeps at most the latest qualifying post per account for each instrument. It does not retain post text, handles or raw account IDs. Matching record/account hashes exist only in memory during capture; sourceDigest is a hash of received frames, not a recoverable raw corpus.

Eligible content is English-tagged original posts; replies, quotations, self-labelled content, old timestamps and missing-language posts are excluded. Instruments match explicit ETF/index cashtags or index names:SPY/SPX/S&P500,QQQ/NDX/Nasdaq100,IWM/RUT/Russell2000,DIA/DJI/DowJones,TLT. The aggregate market view additionally includes selected company cashtags AAPL/MSFT/NVDA/AMZN/GOOGL/META/TSLA, #stockmarket and the phrases stock market,US stocks,US equities,Wall Street (excluding Wall Street Journal),Federal Reserve,Treasury yields. This is a declared filter sample, not an index-weighted or representative population; large-cap and English-language selection biases remain.

Four categories count simple English word cues:upward,downward,mixed,unclassified. Questions,negation,conditional phrasing and quotations remain unclassified. A label is neither the author's known investment intent nor a validated sentiment forecast. Other topics, sarcasm, bots and coordinated accounts can mislead it. No classifier accuracy or semantic AI review is claimed. Each instrument has its own counts; multi-instrument posts overlap and cannot be summed.

The private candidate is `.consensus/bluesky-private/candidate.json` (0700directory/0600file). It contains only aggregate counts, window,filter diagnostics and source hash. A scan with fewer than10distinct matching accounts cannot be staged publicly. Instrument-specific distributions are also suppressed below10accounts. Provider/schema failure never creates a fabricated neutral reading.

## Publication and expiry

After checking a real qualifying candidate, `npm run consensus:bluesky-private -- --publish` stages an allowlisted aggregate into `lib/community-current.json`. It does **not** commit, deploy, create a consensus edition or report successful publication. Complete the existing clean Git/test/build/review/deploy/HTTPS/browser procedure before claiming it is public. Only aggregate counts/window/diagnostic event total and hash enter Git; raw content, exclusion hashes and private provenance files do not.

The community disclosure stays hidden until a valid aggregate has been staged for the build; an empty adapter does not add another blank card. `/api/community` serves a current, validated aggregate with no caching and excludes all raw/private fields. It withholds expired/future/invalid data. The client refreshes once a minute while open, fails closed on errors and never loads current data for a selected historical edition. Samples expire24hours after capture; source-version history may retain anonymous totals. No raw social corpus is archived, and these display counts do not enter consensus votes, coverage, immutable consensus editions, forecasts or model training. A successful transport or visualization does not complete the full social requirement.

## Reports, removals and opt-outs

The owner monitors support@thedailyconsensus.com and keeps the original report and response in that mailbox. This tool does not read the mailbox or send replies. Never infer monitored delivery merely from configuring a mailto link. Do not publish report content or complainant contact details.

For a verified request affecting a displayed sample:

1. Stage withdrawal with `npm run consensus:bluesky-private -- --invalidate`; this removes the private current candidate and writes a null public aggregate. Complete the authorized clean commit/deployment and verify `/api/community` returns unavailable. Clients remove their displayed aggregate on the next refresh (at most one minute after a successful deployment/check). Record exact response/deployment evidence privately. Old source/deployment versions may retain non-identifying aggregate totals until their display expiry; there is no retained individual content to retrieve or delete.
2. If an account/post requests future exclusion, provide a verified DID or AT post URI via stdin to `npm run consensus:bluesky-private -- --exclude-stdin`, keeping it out of shell arguments/history. This invalidates the whole current sample and stores only its one-way identifier hash in the private exclusion file. These hashes are pseudonymous, not anonymous, and are retained solely to honor opt-outs. The owner may remove an exclusion after an authenticated reversal request; preserve the request/response privately.
3. Collection, staging and withdrawal share the existing kernel publication lock. A busy lock means wait for the identified collector to finish, then repeat the requested operation; never steal/delete the lock or report a staged change as live. A concurrent collection cannot silently resurrect a withdrawal.
4. The owner responds to the report in the mailbox. Do not send outreach/replies automatically without explicit authorization.

Because all individual contributions are discarded at the end of capture, post-window edits/deletes cannot be mapped back into counts. The remedy is withdrawal of the whole current aggregate plus an optional future exclusion. This limitation is disclosed in the UI. It is not permission to create a training corpus.
