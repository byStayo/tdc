# Prospective issuer guidance comparison

This private QQQ study follows the original AMD and NVIDIA management revenue ranges through matching reported quarters. It adds future collection and first-settlement intake. It does not rerun the 124-date historical QQQ study, the 39 Texas Instruments EPS quarters, or their inspected windows. The historical sign failure remains unchanged.

## Frozen source and comparison

The source design was first sealed on November 24, 2026 at `18:13:49.771Z`, before reading any real outcome. The independent runner parameters were sealed at `18:22:38.919Z`. A stricter first-seen version was sealed at `18:31:08.088Z`, still before any real enrollment or label access: the prior guidance must already have been captured before the actual release. The original v1 seals, real registrations and zero-enrollment replay remain immutable under the private `v1` directory.

The operative v2 source policy is `5036105a6c563d70a14d3ad39fef0cf1b5f1aab49a16868c7beabc95219ade72`; its runner policy is `1cfedd700b9334d5518d9b7870fcfba13d161b61866368b374dc98704759cf9c`. The field, sign, panel, target, control, partitions and alpha were preserved. No historical result informed the stricter source gate.

- The fixed panel is AMD and NVIDIA, with QQQ as the only target. Both have an existing reviewed QQQ source scope. This is a named semiconductor panel, not index-wide earnings, analyst consensus, household sentiment or EPS.
- Candidate: `100 * (reported consolidated quarterly GAAP revenue / original management revenue midpoint - 1)`, in percent. A positive fitted coefficient is required.
- Control: `log1p(calendar days from the actual 8-K's New York acceptance day to the target date)`. Pool candidate and control by arithmetic mean across the **same** eligible issuer events. Coincident releases count as one date; releases on distinct dates remain independent events.
- The original prior EX-99.1 must guide the identical fiscal quarter before its end. Its index and exhibit must have been pinned strictly before current-result SEC acceptance; later retrieval of an older-dated filing does not qualify. The later original EX-99.1 and separate original 10-Q must agree exactly on entity-wide consolidated USD quarterly revenue. The existing issuer parser rejects mismatched periods, entities, currencies, segments, amendments and ambiguous facts.
- Retain filing day, SEC acceptance instant, first complete private capture and public-availability bound separately. The target is the first exchange session strictly after every original filing/report/New York acceptance day. It must be an ordinary 390-minute session. A late capture or early close never moves the event to a later target.
- Both the actual results and statutory confirmation must postdate the real registrations. A late 10-Q cannot enroll a result already public when registration occurred. Complete original evidence and the as-issued archive must be witnessed before that target's open. There is no CLI clock override.

The native replay pins the first catalog, prior/results exhibits, statutory index/instance and complete private receipt hashes. It runs `collectIssuerGuidance` against those originals without a network request or source write, and checks that the first-complete clock equals the latest original capture. A later check cannot refresh a missed event.

Only numerical facts and attributed derived comparisons enter the study. AMD/NVIDIA authored the issuer exhibits; SEC EDGAR hosts them. Original documents remain private verification evidence, with no wholesale document redistribution. See [SEC access guidance](https://www.sec.gov/about/webmaster-frequently-asked-questions) and [SEC API documentation](https://www.sec.gov/search-filings/edgar-application-programming-interfaces). The study does not treat issuer documents as SEC-authored public-domain text.

## Existing model and outcome protections

`createSecondaryStudy` supplies the unchanged 300 training / 100 validation / 100 test partitions. Each later phase accepts only new decisions after the previous freeze. Test probabilities are signed before entry; test windows are disjoint by actual accepted-label clocks. The first native production settlement alone can supply a sign. An existing core reservation, already settled target, manual/guest price, missing transaction or changed native proof cannot supply one. Later production reservations remain untouched.

The model uses existing standardization, 600 gradient steps, penalties `0.01, 0.1, 1, 10`, and validation-only selection. Each held-out Brier improvement must exceed `0.01` versus matched age alone, training prevalence and `0.5`; the fitted candidate coefficient must be positive, each block-bootstrap 95% lower endpoint positive, and each one-sided p no greater than `0.01/(15*5*3)`. This conservative new-study alpha does not change any existing policy or reservation. No model is fit while collecting; there is no automatic promotion or public vote.

QQQ price sources must already be approved by the normal core: FirstRate, subscriber Kibot or licensed MarketParquet. Their existing native settlement checks still apply. The source-only replay reads no returns or private outcome contents.

## Authentic November 24 replay and actual enrollment

The real source registration is `2026-11-24T18:32:28.688Z`; the separate model-study registration is `2026-11-24T18:32:28.702Z`. Both occurred after the November 24 open. The normal recorder refused that past target and wrote no session seal. Actual enrolled features, study decisions, settlements and partition members are all **zero**.

The replay used edition `2026-11-24T13-04-12-171Z` and only original files already present in the publishing checkout:

| Issuer | Actual original evidence | Result |
| --- | --- | --- |
| AMD | August 4 EX-99.1: $13.0bn midpoint ±$0.3bn. November 3 EX-99.1 and separate 10-Q: $13.377bn for the quarter ended September 26. Results accepted `2026-11-03T21:16:27Z`; 10-Q accepted `2026-11-03T23:00:17Z` with official filing day November 4. | Exact native comparison reproduces: +2.9% versus management midpoint. First complete verification was `2026-11-24T04:09:31.046Z` (November 23 New York), long after the November 5 original target. Release also predates this registration, and guidance was first captured after the actual release. No enrollment. |
| NVIDIA | August 26 original range and November 17 original results for the quarter ended October 25. Results accepted `2026-11-17T21:20:51Z`; original exhibit captured `2026-11-18T19:18:56.668Z`. | Two original earnings exhibits reproduce, but the separate matching 10-Q remains pending in the issued source. No feature or enrollment. Its already-public result remains excluded even if a 10-Q appears later. |

Primary originals: [AMD prior range](https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/q22026991.htm), [AMD actual](https://www.sec.gov/Archives/edgar/data/2488/000000248826000188/q32026991.htm), [AMD statutory filing](https://www.sec.gov/Archives/edgar/data/2488/000000248826000191/0000002488-26-000191-index.htm), [NVIDIA prior range](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm), [NVIDIA actual](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000088/q3fy27pr.htm).

Two genuine issuers and distinct release dates are supported by real originals. Only AMD currently has the complete statutory comparison. The current parser accepts 10-Q quarters Q1–Q3, so this two-issuer panel offers at most six issuer events per year and fewer independent dates after overlaps/exclusions. It cannot quickly meet 500 dates. A larger panel or annual-filing parser needs its own new source/design review and registration, not a silent expansion. The reviewed calendar currently ends December 31, 2028.

## Commands and private custody

Run from the isolated `web` directory. No deployment or new vendor run is required.

```sh
node --experimental-strip-types scripts/prospective-earnings.ts register
node --experimental-strip-types scripts/prospective-earnings.ts source-replay /Users/stelios/device-fleet-work/daily-consensus-polish/web 2026-11-24T13-04-12-171Z
node --experimental-strip-types scripts/prospective-earnings.ts status
```

On a genuinely future target morning, after the normal public-edition verification and source collection:

```sh
node --experimental-strip-types scripts/prospective-earnings.ts record YYYY-MM-DD EDITION_ID
```

`verify-live-consensus.ts` also records the earnings lane and enrolls the already-registered study after its public pre-open witness. `publisherSecondaryStudies` includes earnings, so ordinary native evaluation/recovery stages its first settlement and the existing evaluator advances it. For a separate private advance, use `node --experimental-strip-types scripts/prospective-earnings.ts advance`. Commands that write take the normal publication lock; status is read-only. Do not run the recorder against an active/post-open target or fabricate a historical witness.

The immutable replay is `.consensus/private-prospective-earnings/v2/source-replays/2026-11-24T13-04-12-171Z.json`, with payload digest `90a4e9ca42f03c9ace73d0a825c3920cd1d7291293873eb269c515dce9788207`. Replays validate the original hashes and retain the original assessment date/count, rather than rewriting the receipt with a later clock. The v2 first-seen design seal, real registrations and `after-open-refusal.json` are siblings; earlier v1 evidence is preserved separately. Raw evidence is referenced, not copied into Git.

Retain these canonical inputs to repeat the real source replay: edition `public/consensus/2026-11-24T13-04-12-171Z.json`; `.consensus/private-issuer-revenue/guidance-matches/AMD-2026-09-26.json`; `0000002488-26-000121.json`, `0000002488-26-000188.json`, `0000002488-26-000191-quarter.json`, `0001045810-26-000073.json`, and `0001045810-26-000088.json` in that issuer directory. Their actual hashes are pinned in the private replay. All pre-existing receipts remain unchanged.

## Verification

Focused tests exercise the real issuer parser and original pre-open feature recorder through the native first-settlement adapter. Synthetic fixtures are explicitly labeled and never count as real enrollment. Cases cover coincident/distinct issuer dates, future captures, changed bytes, original registration immutability, late statutory confirmations, retrospectively captured guidance, shortened targets, post-open refusal, manual price rejection, reserved weekly overlap, and first-only intake. The original feature/retail/interruption tests also pass: 39 focused tests total. Strict TypeScript passes. The parent release owns the combined full-suite run; this isolated study performs no build, publication or deployment.
