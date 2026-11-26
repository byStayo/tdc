# ETFIQ daily fund-flow context

## All five fund histories and their comparison groups

ETFIQ revised its November 20, 2026 aggregate. Its earlier file omitted SPY and DIA. At 07:03 New York on November 24, all five net flows matched the individual fund histories exactly. The source NAV date was November 19. Each fund is compared with the other eligible ETFs in its provider category. [ETFIQ market file](https://etfiq.com/data/flows/daily/latest.json) · [Methodology](https://etfiq.com/methodology/flows) · [November 23 licence](https://etfiq.com/license/)

| Fund | Net flow, USD | Flow / prior net assets | Other ETFs with inflows | With outflows | Flat |
| --- | ---: | ---: | ---: | ---: | ---: |
| SPY | −1,539,201,250 | −0.20% | 149 | 99 | 579 |
| QQQ | +612,981,544 | +0.14% | 148 | 100 | 579 |
| IWM | +435,781,797 | +0.60% | 148 | 100 | 579 |
| DIA | −24,539,606 | −0.06% | 149 | 99 | 579 |
| TLT | −96,374,380 | −0.20% | 54 | 43 | 301 |

The market file reported $2,197,614,281 of net creations across 2,684 eligible funds. It held 84 for review and excluded 49 with counts spanning sessions. SPY, QQQ, IWM and DIA use the Stocks group. TLT uses Bonds. Other and unclassified funds are outside those groups. Genuine zero flows count in the group denominator. Each fund is excluded from its own comparison.

The publisher fetches the market file once and each eligible tracked history once. Shared private receipts under `.consensus/private-etfiq-flow-peers/v1` store the comparison members and signs, target computed flows, dates, native hashes and first capture times. A history mismatch withholds that comparison. The public aggregate and other funds are checked separately. The two representations come from the same provider. [Collector](../lib/consensus/etf-flow-peers.ts)

The private forward study tests whether the fund's net flow percentage adds predictive value beyond the difference in fractions of peers with inflows and outflows. The target is the next ordinary session's open-to-close return sign. It requires the immediately prior session's count date, the preceding NAV date, a morning public witness and inputs first captured after registration. Across the first eight distinct archived pre-open mornings with an ETFIQ sample, one had the immediately prior count date. Friday's flows supply dated context on Tuesday, November 24. [Study policy](../lib/consensus/etf-flow-study-policy.ts)

Register once with `npm run consensus:fund-flow-study -- --register`. The weekday verifier enrolls qualifying inputs and the native evaluator settles the final witnessed edition. Read per-fund counts with `npm run consensus:fund-flow-study -- --status`. Training, validation and sealed testing require 300, 100 and 100 qualified observations per ETF.

## Initial November 9 qualification

Verified November 9, 2026 (US Eastern). Source: https://etfiq.com/data/flows/daily/latest.json; methodology: https://etfiq.com/methodology/flows; explicit licence: https://etfiq.com/license/ (updated November 9).

ETFIQ explicitly permits quotation, commercial republication, retained use and model use of its computed figures with attribution and a link. Its grant excludes issuer NAVs, net assets and shares outstanding and raw vendor prices/distributions. Public signals contain only the provider's computed net flows, round trips, computed flow percentages, observation dates and coverage counts. The underlying net-assets values are used transiently to validate percentages; they are never copied to signals, fixtures, public APIs or editions. Name ETFIQ with the original observation date; no endorsement is implied.

The actual November 6 file contains 2,154 rows: 1,944 valid one-day observations, 68 held for review and 142 whose counts span more than one session. Usable rows sum exactly to the reported $6,834,906,761 net flow. QQQ is +$2,785,439,956; IWM +$542,672,422; TLT −$204,757,455. SPY and DIA are absent from this particular file, which does not establish zero flow. These are dated counts and may be corrected by the source. A flow dated November 6 reflects the previous trading day's orders under the provider's count convention; the three named observations use November 5 NAVs.

## Operation

- Full collection includes the feed once. A bounded, scoped addition/refresh is `node --experimental-strip-types scripts/publish-consensus.ts --etf-flows-only`; add `--publish` after validation/review to append a genuine edition.
- Both full/scoped paths insert the same six identities before the established analyst/TWSE/private-credit tail. Only the new source changes during scoped collection; existing source timestamps/values and editorial reports remain intact.
- Existing lock, archive reconciliation, observation identity, immutable index, hashed snapshots and frozen voting engines apply. A retrieval-only change cannot create an edition. Reads never call ETFIQ.
- All horizons and directional scopes remain empty/null. Creation/redemption direction does not demonstrate price direction, investor identity, private-equity capital flows or predictive accuracy.
- Missing, held and multi-session rows stay unavailable. A genuine zero is available only when backed by eligible observations; no eligible daily fund leaves the aggregate unavailable.
- Hashes, cutoff clocks, licence metadata, schema, duplicates, dates, percentages, aggregate arithmetic and saved contracts fail closed. Only classified transport errors may retain older verified values, preserving dates and showing the outage notice. Staleness is seven days from the flow date, not from retrieval.
- The morning panel uses the selected snapshot only. Old editions without these signals render no new flow panel; current values never fill an old edition. Raw provider fields are not added to the Research Desk's separate saved-workspace API.

## Verification

Synthetic fixtures are labelled and cannot enter publication. Tests cover signed/zero/missing/held/multi-session observations, no-coverage withholding, positive-coverage zero, one fetch, full/scoped order, corrupt hashes/clocks/terms/schema/arithmetic, saved voting scope and real component historical/instrument isolation. A fresh independent review found the all-excluded false-zero edge; a failing regression reproduced it and the implementation now withholds it. No further required finding was reported. The final rendered and deployment receipt is maintained in HANDOFF.md.
