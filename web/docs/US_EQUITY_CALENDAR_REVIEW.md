# Common U.S. equity sessions through 2028

The November 24, 2026 review establishes four more intervals for the U.S. regular equity session. NYSE Group published its 2026–2028 holidays and special closes on December 23, 2025. Nasdaq General 3 Rule 1030 defines its business holidays and their weekend observance. Nasdaq Equity 1 defines its ordinary core session. The SEC’s April 2026 approval of Nasdaq’s expanded hours preserves the 9:30 a.m. opening cross, the 4 p.m. ordinary close and Nasdaq’s authority to designate an earlier close. The times in this table concern the core session in New York. [NYSE dated announcement](https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx) · [NYSE exchange table](https://www.nyse.com/trade/hours-calendars) · [Nasdaq holiday rule](https://listingcenter.nasdaq.com/rulebook/nasdaq/rules/nasdaq-general-3) · [Federal Register holiday rule filing](https://www.govinfo.gov/content/pkg/FR-2021-12-03/html/2021-26242.htm) · [Approved Nasdaq trading hours](https://www.govinfo.gov/content/pkg/FR-2026-04-15/html/2026-07259.htm)

| Reviewed interval, inclusive | Earliest target with a prior ordinary session in that interval | Potential ordinary-session pairs |
|---|---|---:|
| November 24, 2026–November 25, 2027, with the existing November 23 lookback | November 24, 2026 | 248 |
| November 27–December 30, 2027 | November 30, 2027 | 22 |
| January 1–July 2, 2028 | January 4, 2028 | 124 |
| July 4–November 23, 2028 | July 6, 2028 | 99 |
| November 25–December 31, 2028 | November 28, 2028 | 23 |

There are 516 possible pairs. With complete timely features and verified outcomes every eligible day, the 300th pair would fall on February 15, 2028 and the 500th on December 6, 2028. A comparison that needs two preceding full sessions within the same interval has 510 possible targets and would reach its 500th on December 14, 2028. Sample sizes, model gates and reservations depend on actual captured inputs and settled outcomes.

## Dates awaiting an exchange notice

| Date | Evidence still needed |
|---|---|
| November 26, 2027 | NYSE and Cboe list an early close. The available Nasdaq and UTP Thanksgiving notices specify November 27, 2026. |
| December 31, 2027 | NYSE specifically keeps this Friday open. Nasdaq’s standing rule observes a Saturday holiday on the preceding Friday unless unusual business conditions exist. A Nasdaq determination for New Year’s Day 2028 is outstanding. |
| July 3 and November 24, 2028 | NYSE schedules 1 p.m. closes. The reviewed Nasdaq and FINRA notices do not cover these dates. |

The SEC-approved national market system procedure assigns any different regular hours to the participant maintaining the primary listing. NYSE’s schedule therefore settles Arca’s published dates. Nasdaq’s own designation or an applicable UTP/FINRA notice naming the common equity session can resolve these four gaps. The November 24 fetch of Nasdaq Trader’s usual calendar PDF returned a real PDF for 2026 and HTML error pages for 2027 and 2028. [SEC order, section X](https://www.govinfo.gov/content/pkg/FR-2001-04-17/html/01-9504.htm) · [Nasdaq Trader schedule](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar) · [UTP SIP Thanksgiving notice](https://www.nasdaqtrader.com/TraderNews.aspx?id=UTP2026-34) · [FINRA schedule](https://www.finra.org/filing-reporting/market-transparency-reporting/holiday-calendar) · [Cboe exchange CSV](https://www.cboe.com/us/equities/holidays/csv/)

Dates in separate intervals can appear together in a settlement inventory. An individual outcome from issue time through exit, a consecutive feature or a corporate-action adjustment must stay within one contiguous interval. A new edition on the first ordinary day after a gap can have a daily target. A feature that needs the preceding ordinary day must wait for another session. Existing calendar identifiers for 2026 and the original 2027 interval remain pinned in archived outcomes.

## Reproduce the review

Run these from `web`. The live source check makes eight bounded public requests and prints the originals’ SHA-256 hashes. Source wording or dates that change call for another calendar review. The offline form accepts the directory containing the original source bodies named by their pinned SHA-256 hashes.

```sh
python3 -B scripts/verify-exchange-calendar-sources.py --live
python3 -B scripts/verify-exchange-calendar-sources.py --saved .consensus/private-common-equity-calendar
node --experimental-strip-types --test tests/consensus-exchange-calendar.test.ts tests/marketparquet.test.ts
```
