# Comparing SEC filings with ETFIQ daily share flows

The weekday publisher checks for new SEC filings and amendments, then runs this comparison. When the five filing identities and reviewed exchange sessions match an existing comparison, it replays that receipt with zero ETFIQ requests. To check an announced ETFIQ historical backfill against the same filings, use `--collect`. Each new comparison retains its first local timestamp.

This private check compares each fund’s public Item B.6 fiscal quarter with the computed daily flows in its original ETFIQ history. Each comparison carries the fund, SEC accession, reporting period, EDGAR acceptance time, ETFIQ observation date, original source hashes and first local comparison time. [SEC filings and verified fund identities](SEC_ETF_FLOW_CONTROL.md)

ETFIQ calculates daily flow from the change in issuer share counts valued at the earlier NAV, adjusting the earlier count for confirmed splits. It dates that amount to the later count. For each economic order session in the SEC quarter, the primary comparison selects exactly one ETFIQ row whose NAV date is that session and whose count date is the immediately following reviewed exchange session. This includes the first trading-day count after quarter-end. A separate diagnostic includes the later count dates inside the fiscal quarter. It exposes how much changing the two boundary observations affects the dollar difference. [ETFIQ fund-flow methodology](https://etfiq.com/methodology/flows)

The issuer comparison shows two SEC definitions. One subtracts redemptions from sales, while the other adds dividend and distribution reinvestments as ETFIQ does for its filed-month figures. The independent side reads the individual fund’s daily share-count calculations. ETFIQ’s own published monthly series and filing comparisons can use the same SEC accession. The daily flow includes both legs of identified round trips. Split-adjusted daily amounts already incorporate the provider’s adjustment. [SEC Item B.6](https://www.sec.gov/about/forms/formn-port.pdf#page=9) · [ETFIQ’s filed-month and daily definitions](https://etfiq.com/methodology/flows)

The report lists coverage, measured zero days and excluded economic dates. A held or multi-session observation, a provider warning, a duplicate, an unverified source or a missing or conflicting date prevents a complete-period difference. A partial period has a subtotal only when at least one order session qualifies. The reported differences preserve the issuers’ decimal precision and ETFIQ’s published whole-dollar daily observations. Differences and agreement on direction describe these observed windows. Predictive testing is separate.

Run from `web` after collecting the SEC originals. Give the replay command the 64-character `receipt` emitted by the first command.

```sh
python3 -B scripts/reconcile-sec-etfiq-flows.py --collect
python3 -B scripts/reconcile-sec-etfiq-flows.py --replay RECEIPT_SHA256
python3 -B -m unittest discover -s tests -p test_sec_etfiq_comparison.py
```

Each private receipt under `.consensus/private-sec-etfiq-comparisons/v1/` pins the original ETFIQ response hashes, dated daily computed amounts and their quality markers. The offline replay verifies the SEC originals and recomputes coverage and differences from the permitted ETFIQ fields and the publisher’s exchange calendar. Issuer NAVs, net assets, share counts, vendor split factors and prices are discarded during collection. Rechecking the full ETFIQ response hash requires the original provider response. [ETFIQ licence and attribution](https://etfiq.com/license/)
