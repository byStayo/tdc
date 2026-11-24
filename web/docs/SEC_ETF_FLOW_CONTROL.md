# Issuer-reported ETF share flows

The private collector reads Item B.6 of each fund’s public SEC Form N-PORT. It adds the three reported months’ share sales at net asset value and subtracts redemptions or repurchases. It retains dividend and distribution reinvestment separately. The form includes exchanges within a fund family and can include mergers, liquidations and net omnibus-account transactions. [SEC Form N-PORT, Item B.6](https://www.sec.gov/about/forms/formn-port.pdf#page=9) · [SEC field definitions](https://www.sec.gov/files/nport_readme.pdf#page=12)

Creation units can change hands for securities, cash or both. Item B.6 identifies the value of shares issued and redeemed across these transactions. A cash-only amount, secondary-market trading volume and daily flows each require separate data. ETFIQ comparisons require the same fund, dates and flow definition. SEC control observations supply no additional directional vote. [SEC investor bulletin on ETF creation units](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24) · [Invesco QQQ financial statements](https://www.invesco.com/content/dam/invesco/hk/en/pdf/qqq-semi-annual-report-en.pdf)

## Five verified filings

On November 24, 2026 the SEC’s registrant submissions and, for iShares, its separate fund-series listings identified these originals. Each filing and its index were independently retrieved. EDGAR shows acceptance in New York time. The collector emits UTC and preserves the first local verification timestamp separately.

| Fund | Registrant CIK | SEC series / class | Reported period in 2026 | Accepted UTC | SEC filing |
| --- | --- | --- | --- | --- | --- |
| SPY | 884394 | Single-portfolio trust | Apr 1–Jun 30 | Aug 28 16:25:47 | [SPY index and original XML](https://www.sec.gov/Archives/edgar/data/884394/000141036826089410/0001410368-26-089410-index.htm) |
| QQQ | 1067839 | S000101292 / C000271435 | Apr 1–Jun 30 | Aug 28 13:26:52 | [QQQ index and original XML](https://www.sec.gov/Archives/edgar/data/1067839/000106783926000030/0001067839-26-000030-index.htm) |
| IWM | 1100663 | S000004344 / C000012074 | Apr 1–Jun 30 | Aug 25 14:10:43 | [IWM index and original XML](https://www.sec.gov/Archives/edgar/data/1100663/000207169126019749/0002071691-26-019749-index.htm) |
| DIA | 1041130 | Single-portfolio trust | May 1–Jul 31 | Sep 18 19:20:26 | [DIA index and original XML](https://www.sec.gov/Archives/edgar/data/1041130/000141036826095867/0001410368-26-095867-index.htm) |
| TLT | 1100663 | S000004360 / C000012090 | Jun 1–Aug 31 | Oct 22 15:25:28 | [TLT index and original XML](https://www.sec.gov/Archives/edgar/data/1100663/000207169126024225/0002071691-26-024225-index.htm) |

The April–June figures for SPY, QQQ and IWM were all accepted by August 28 at 16:25:47 UTC. By October 22 at 15:25:28 UTC all five filings were available. Their only common calendar month was June. An all-five comparison for a single quarter needs additional dated observations. The XML uses numbered month slots, and issuers have documented changes in their ordering. The collector groups only identical three-month periods. [Issuer’s explanation of its B.6 month ordering](https://www.sec.gov/Archives/edgar/data/277751/000114554924055336/xslFormNPORT-P_X01/primary_doc.xml)

## Collection and replay

The weekday harvester checks all five accession inventories. When an accession has already been verified, it replays its local XML and filing index. New filings and amendments receive their own original receipts. A source failure prints the affected fund and allows the other daily collection to continue. Run from `web` using Python 3.9 or later. The XML, index and local receipt stay under the ignored `.consensus/private-sec-etf-flows/v1/` directory. Data.gov identifies the structured Form N-PORT dataset as an open government data asset. [SEC EDGAR access](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) · [SEC open-data listing and rights](https://catalog.data.gov/dataset/form-n-port-data-sets)

```sh
python3 -B scripts/collect-sec-etf-flows.py --collect-latest
python3 -B scripts/collect-sec-etf-flows.py
python3 -B -m unittest discover -s tests -p test_sec_etf_flows.py
```

The first command compares filer and series inventories, filing date, report period and acceptance before storing new originals. A newer amendment supersedes the previous accession for that period, and a newer period takes precedence over amendments to earlier periods. Corrections to flow definitions, changed fund identities, incomplete records and failed acquisitions produce a per-fund reason and a nonzero exit. `--collect-samples` pins the five accessions above. Running without flags reconstructs each latest retained quarter from the exact stored XML and index, including their hashes and original verification time. Only `--collect-latest` checks for subsequent filings.
