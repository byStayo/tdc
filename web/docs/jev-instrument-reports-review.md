# Instrument report presentation

Jev 1.14.0 selected a dedicated report view, a wrapping five-button selector and the report followed by a hosted chart. Full questions, choices, distributions, confidence and usage are in the adjacent request/decisions JSON artifacts. No private input or credentials were sent or saved in those artifacts.

The combination is compatible with the existing sidebar/mobile dialog, research panel, chart and light/dark token system. The chart remains separate from the editorial evidence. Selection buttons use native button behavior, an accessible group label and aria-pressed state. Unsupported tickers receive no substitute market-wide text. A scope guard prevents a previous market/ticker publication from appearing under a new instrument label during transitions.

The context-placement confidence was 0.21, with several reasonable layouts receiving probability. This is not a visual-quality score. The report-first/chart-after arrangement was retained because it follows the existing reading order and stacks naturally on mobile; actual browser evidence is recorded separately.
