# MarketParquet sample qualification

The owner can replay a bounded evaluation of five ETFs for October 23 through November 20, 2026 and the November 28, 2025 early close. It covers TLT’s November 2 ex-date. The sample tool has no publisher, score, purchase or account integration. Use the existing licensed path for production. MarketParquet grants private retention, modelling and qualifying public derived outputs upon archive purchase. Its site prohibits scraping as a substitute for buying the product. [License](https://marketparquet.com/license) · [Terms](https://marketparquet.com/terms) · [Plans](https://marketparquet.com/pricing)

From `web`, pass the publishing installation’s existing `web` evidence root and the owner-only saved preview directory. The command replays entirely offline. Its standard output is an owner-private qualification report.

```sh
umask 077
node --disable-warning=ExperimentalWarning scripts/research-marketparquet-preview-window.mjs \
  "$PUBLISHING_WEB" "$PRIVATE_RESEARCH/originals" > "$PRIVATE_RESEARCH/replayed.json"
python3 -B tests/test_marketparquet_previews.py
```

The provider’s yearly ETF catalogue offers a preview button for selected days. Each native page links to a CSV of the same displayed rows. The verifier compares both representations, requires all five funds, preserves the full precision of the input and records hashes. The nine qualification dates were chosen to fill missing regular days, one known ex-distribution boundary and one early close. Existing archive observations are replayed from prior pinned evidence. Each date needs exactly one native input. The first two retained HTML captures have a local reception time but no retained HTTP Date or MIME header. Both dates also have the separate, hashed CSV with its actual response headers. [ETF catalogue](https://marketparquet.com/browse/etf_daily) · [October 30 sample](https://marketparquet.com/preview/etf_daily/2026-10-30) · [November 2 sample](https://marketparquet.com/preview/etf_daily/2026-11-02)

The full replay checks independent controls and both opening and closing prices. For October 30 onward it decodes the four signed Market History raw and split-only hourly grids per fund. It confirms cash against the held issuer originals and separately classified corporate-action records. The first five sessions use the existing, separately sealed Kibot guest evaluation controls. No signed Market History controls were captured for these earlier dates. The short-day sample is checked against executed Nasdaq crosses for QQQ and TLT and final primary-listing Arca participant summary records for SPY, IWM and DIA. The separate consolidated and listing comparisons remain visible in the private report. The script also retests the saved QQQ closing auction and verifies the 5- and 21-session directions without consuming any forecast or reserved outcome. [Provider adjustment method](https://marketparquet.com/data-quality) · [Market History bars](https://getmarkethistory.com/docs/bars/) · [Corporate actions](https://getmarkethistory.com/docs/corporate-actions/) · [CTA historical summary](https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.20251128.csv) · [Nasdaq historical tape](https://emi.nasdaq.com/ITCH/Nasdaq%20ITCH/S112825-v50.txt.gz)

The ETF series includes the vendor’s share adjustments and excludes cash dividends. The verifier applies the issuer’s gross distribution once. For a preceding close \(P\), an ex-date close \(C\) and a distribution \(D\), the project computes the adjusted close-to-close return as \(C/(P-D)-1\). An investor holding one share and a cash receivable has a return of \((C+D)/P-1\). A separate decimal implementation checks both conventions, prior-session opening and closing adjustments, and the unmodified ex-date endpoints. The ordinary-session test uses the project’s existing 3 and 15 basis point tolerances and matching direction. Window direction agreement and agreement of every constituent are reported separately. [iShares TLT distributions](https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf)

A per-date offline replay checks only cached inputs and prints the date, fund count and evidence hash. The optional `--collect` flag retrieves only a missing, expressly offered sample from the nine fixed dates of this study. It never requests a full archive file or uses credentials.

```sh
python3 -B scripts/qualify-marketparquet-previews.py "$PRIVATE_RESEARCH/originals" 2026-11-02
```
