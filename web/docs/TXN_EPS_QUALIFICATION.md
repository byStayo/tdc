# Texas Instruments earnings against original EPS and revenue guidance

TI’s July 22, 2026 results gave third-quarter revenue guidance of $5.65–6.15 billion and EPS guidance of $2.23–2.57. Its October 21 consolidated income statement reported $6.055 billion in revenue and $2.62 in diluted EPS for July 1 through September 30. Revenue fell inside its range. Diluted EPS exceeded the upper bound by five cents. TI identified a one-cent reduction outside its original guidance. Removing only that signed item produces a six-cent excess. The reported GAAP amount remains $2.62. These are management expectations for one issuer. [July earnings filing](https://www.sec.gov/Archives/edgar/data/97476/000009747626000148/0000097476-26-000148-index.htm) · [October earnings release](https://investor.ti.com/node/38631)

The original Form 10-Q was accepted October 23 at 17:03:12 UTC. Its consolidated diluted EPS in USD per share matches the earnings release and the accession-specific SEC Company Concept extract. The nine-month entry of $6.44 covers a different period. The issuer authored both filings. The November 24 source audit preserves when the documents were actually checked. [Original statutory filing](https://www.sec.gov/Archives/edgar/data/97476/000009747626000169/0000097476-26-000169-index.htm) · [SEC data service](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

## Historical coverage

| Stage | Distinct TXN quarters |
| --- | ---: |
| Consecutive quarters with native reported revenue and the two original management ranges | 44 |
| Same-quarter diluted EPS confirmed in the original statutory accession | 39 |
| Confirmed EPS and an explicit, signed per-share item outside original guidance | 29 |
| Confirmed quarters on untouched historical QQQ target dates | 0 |

The fixed corpus contains 46 candidate 8-K filings and 45 original earnings releases from October 2015 through October 2026. The original annual filings for 2021–2025 supplied no directly reported fourth-quarter diluted EPS for the required period. Annual EPS minus nine-month EPS can give an incorrect result because diluted shares and accounting adjustments can differ. The checker withholds those five quarters. It also leaves an unquantified or unsigned adjustment unknown.

On the 39 confirmed dates, revenue stayed inside management’s range while EPS exceeded its range 11 times and fell below it once. One further quarter had revenue above range and EPS inside it. Removing the explicitly quantified item changed five of the 29 eligible EPS classifications. These counts describe company results. Every confirmed date already belonged to the earlier 124-session QQQ revenue study. The new field provides no untouched historical QQQ outcome, and the project requires at least 120 unique eligible dates for its retrospective screen. The checker opens no ETF prices and supplies no directional vote. [Earlier registered study](../scripts/issuer-guidance-qqq-study-policy.json)

## Fourth-quarter witness

A private receipt sealed at 17:31:27 UTC on November 24 preserves TI’s already issued Q4 ranges of $5.80–6.30 billion and $2.45–2.79 per share, the original accession, source digests and verification times. The EPS midpoint of $2.62 equals the last published quarterly EPS. A persistence forecast therefore predicts the same value for this quarter. The fiscal quarter closes December 31. Its outcome remains pending and will require an actual three-month statutory EPS for confirmation. [Issuer’s Q4 outlook](https://investor.ti.com/node/38631)

Run from \`web\` on the authorized publisher with the existing ignored \`.consensus/private-issuer-guidance-archive-qualification\` package. Scripts use only Python's standard library. \`capture\` downloads the four missing official SEC documents at most once each, then verifies the original issuer releases, forms and exact per-share units. \`qualify\` verifies local originals and seals the source result and prospective witness. \`replay\` recomputes and checks the saved receipts offline. A new witness requires a real host clock before December 31. A later machine can replay a transferred original witness.

\`\`\`sh
python3 -B scripts/qualify_txn_eps.py capture
python3 -B scripts/qualify_txn_eps.py replay
python3 -B -m unittest discover -s tests -p 'test_txn_eps.py'
\`\`\`

Use \`--archive PATH\` for the earlier issuer-research store and \`--store PATH\` for these owner-only SEC captures and receipts. Keep both directories outside Git. The November 24 source qualification has SHA-256 \`1b0460d0de08a0fc16343ad65a0eb46892e8bf62fa147e16679c7269346e9bc7\`. Its time-stamped Q4 source witness has SHA-256 \`25f82b57a34cb562603a21b7f0380b18c124729270dc6565f52b783788097531\`. No new polling, ETF settlement or production model is required to reproduce these checks.
