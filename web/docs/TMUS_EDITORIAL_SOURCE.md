# Reviewing T-Mobile US analyst consensus

This owner-only tool checks an external analyst estimate for T-Mobile US before an editor uses it in reporting. Its parent company Deutsche Telekom collects the analyst submissions and publishes their median. The estimate refers to T-Mobile US consolidated gross revenue in millions of US dollars under US GAAP. The annual median can change as more quarterly results become known or analysts enter or leave the survey. The publisher does not identify same-analyst revisions. [Issuer methodology](https://www.telekom.com/en/investor-relations/publications/consensus)

## Collect and replay

Run these commands from `web`. Python 3 and Poppler’s `pdftotext` are required. Each collection uses a new directory so earlier evidence can be identified and removed individually. Use the active period in the directory name.

```sh
python3 scripts/review_tmus_consensus.py --collect .editorial/tmus-consensus/2026-Q3
python3 scripts/review_tmus_consensus.py .editorial/tmus-consensus/2026-Q3
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_tmus_consensus_editorial.py
```

The first command reads the public issuer index, current methodology, media licence, adjacent quarterly PDF and XLSX releases, and one SEC company-concept series. It creates an owner-only directory under ignored `.editorial`. It writes the original bytes under their SHA-256 hashes, an origin and receipt-time manifest in `sources.json`, and a reconciled `aggregate.json`. The second command reads these local files, verifies the hashes, recalculates the result, and checks it against the first report.

The printed PDF date must agree with the workbook’s modification day. Both formats must agree on the fiscal periods, rounded medians and analyst counts. The SEC comparison uses the first original filing for the same fiscal quarter, currency, registrant and concept. It excludes year-to-date figures, later amendments and an SEC filing whose New York filing day is still in progress. An unavailable quarter actual stays pending. An annual revision requires two adjacent source releases for the same forecast year. Each result records the actual first collection time. The printed survey date does not establish when the original became public within that day. [Quarterly source archive](https://www.telekom.com/en/investor-relations/publications/financial-results) · [SEC original company facts](https://data.sec.gov/api/xbrl/companyconcept/CIK0001283699/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json)

## Permitted editorial use and retention

Deutsche Telekom allows free journalistic reporting about itself and affiliated companies, subject to asset-specific conditions. Its grant is revocable, prohibits use to train AI, and requires permission for other commercial uses. Publications have separate reproduction limits. The checker stops for review when the terms or workbook notice change. Attribute the issuer as the survey compiler and the sell-side analysts as the forecasters. An editor can report a limited factual comparison with links to the originals within that context. [Deutsche Telekom media terms](https://www.telekom.com/en/general/terms-of-use-for-media-content)

Keep the source packet and its derived native values in the owner’s removable private store. If the issuer revokes permission, stop collecting the affected material, identify its receipts by origin and digest, and remove the packets and copies or exports under the owner’s control, subject to any statutory retention duty. The stored permission is insufficient for a permanent public JSON archive, a model training dataset or a consensus vote. This tool has no scheduled job or public publisher hook.
