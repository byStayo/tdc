# Daily Consensus publication consistency

Owner requested meticulous, cohesive formatting and natural scrolling across every Daily Consensus page. Explicit clarification: The Daily Consensus only; the portfolio is out of scope. This steers the active completion goal; feed/model work remains open.

Use the existing Manrope body and Space Grotesk display fonts, quiet dark/light surfaces (#0d1214 / #f4f5f1), and existing teal/green accents (#a2d5bb / #316b51). Keep research data, dates, numerical precision and navigation behavior intact. The design choice is a calm reading instrument with consistent hierarchy, not a brand reset.

- Shared 1240px page grid, 28px desktop / 20px mobile gutters; article text keeps its 740px reading measure.
- One page-heading contract: display font, weight 500, 44px desktop / 32px narrow-screen cap, consistent line height and spacing. Archive, article, methodology, morning and desk use it.
- Shared top-level header and footer treatment, predictable section rhythm, useful 44px controls and visible keyboard focus.
- Stable scroll: no page zoom/scale effects. Hosted chart frames receive input only after explicit interaction; ordinary wheel/touch scrolling crosses the chart naturally. Keep normal pinch zoom available.
- Mobile text inputs/selects at least 16px. Preserve user zoom and reduced-motion support.

Baseline evidence: at 390px all five routes have scale 1 and no overflow; archive/article h1 use body font while other routes use display font. Morning selectors are 14px. At 1440px wheel input over the live chart leaves document scroll unchanged while the cross-origin frame receives the pointer. Do not claim iOS Safari behavior was directly tested in Chromium.

Validation: production-mode browser matrix at 375/390, 768 and 1440px, both themes, all five route types and all desk sections. Test natural wheel scrolling over a loaded chart, explicit activation/exit, configuration reset, keyboard access, typography/gutters and mobile control size. Run existing tests/typecheck/build once for the final code, then deploy and verify live. Preserve prior image/source/model evidence for unchanged code.

## Review and observed refinements

The independent source review found one P2: pan-y alone would disable manual pinch over the shield. It now uses pan-y pinch-zoom. Actual emulated touch scrolling moved the page359→524 with scale1; a deliberate pinch over the locked chart changed scale1→1.2. Keyboard activation focuses the frame, Finish returns focus to activation, outside-input clicks preserve input focus while relocking, and theme changes reset interaction. These are Chromium/emulated-touch results, not a physical iPhone Safari test. One provider-owned configuration fetch warning was observed during development; hosted chart canvases rendered and application navigation remained functional.

Model results now use labelled mobile rows, retaining all nine results, four-decimal errors, semantic table/row/header roles and caption. Mobile accessibility inspection finds10rows,6column headers,9row headers. The Treasury metric gap and edition-popup positioning were corrected at320px rather than hiding overflow. All44 morning/desk view-width combinations pass (320,375,768,1440), alongside the route-type typography/footer/provenance checks. Every route now has one site contentinfo footer; article-specific provenance remains intact.
