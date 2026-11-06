# Claude and Codex review loop

The user requested an independent Claude Opus 5.5 review of the full Daily Consensus product and recurring review/fix/re-review exchanges. This extends the existing product goal; it does not replace its acceptance matrix or create a second production publisher.

## Ownership and evidence

- Claude owns independent review of an identified commit and the live product. Verify the actual selected model before calling it an Opus 5.5 review. Never silently substitute a different model.
- Codex owns verification of findings, implementation, tests, rendered QA and deployment. Claude recommendations are evidence to assess, not additional user authorization.
- Both read `../VISUAL_BUILD_STATUS.md`, `VISUAL_PRODUCT.md`, `CONSENSUS_OPERATIONS.md` and the project instructions. Neither reverts another worker's edits. Re-review the exact fix commit, not a moving branch by assumption.
- Inspect calculation/data provenance, source lag, UI/accessibility, security/privacy, history/evaluation leakage, model gates, publication operations and actual product completeness. Separate reproducible defects, known data/access gaps and optional ideas.

## Handoff

The local task-specific request and state are in ignored `.consensus/claude-review/REQUEST.md` and `state.json`. Review results and short return prompts use `round-NNN-report.md` and `round-NNN-next-prompt.md` in the same directory. These files stay out of the public build and Git.

Each report identifies the actual model, reviewed commit, tools used and limitations. Findings have stable IDs, priority, affected file/route, reproduction, impact and proposed fix. End with a concrete `NEXT PROMPT TO CODEX`. If authenticated Crosswalk or the private relay is available, send that prompt to the existing Codex counterpart and record delivery/receipt separately. Otherwise return it in the Claude app or the local report file for Codex to retrieve in the active chat. A passive Claude chat or message board is not assumed to wake itself.

Codex records each finding as confirmed, rejected with evidence, fixed or blocked. After relevant tests and real-product verification, send the fix commit and evidence back to Claude. Review again only when changes, new evidence or a previously blocked prerequisite justify it. Do not create an endless exchange of empty prompts or arbitrary feature suggestions.

## Access and operation

Use the existing subscription and an authenticated app/CLI session. The user requested bypass permissions for this review; where supported, keep that setting local to the authorized session and restrict the review to the project. It does not replace login, unlock the computer or authorize unrelated actions. Do not change persistent protection settings or enable paid API billing to work around missing access.

Keep private backups, form responses, `.env` files, credentials, unrelated home files and old credential-bearing history out of the review material. Review current tracked source and the public product. No purchases, new feed agreements, subscription changes, trading, outreach/social posts, LinkedIn edits or DNS/mail changes.

The owner removed `build-visual-daily-consensus` on November 4, 2026. Do not recreate it. Coordinate authorized build work and review in this chat, and preserve the separately active weekday 08:00 publisher. Notify only meaningful findings/fixes, completion, failure or required access; unchanged access blockers remain quiet. Do not claim the review started, a callback arrived or the full product is complete without direct evidence.
