# Private first-release corporate-profits comparison

This research measures how accurately a separately published survey forecast aggregate US corporate profits for a named quarter. The target is US after-tax corporate profits with inventory valuation and capital consumption adjustments, in billions of dollars at a seasonally adjusted annual rate. The study has one prospective quarter and one retrospective example. Neither supplies an ETF return, trade call or model vote. [Philadelphia Fed survey definition](https://www.philadelphiafed.org/surveys-and-data/cprof) · [BEA corporate profits](https://www.bea.gov/data/income-saving/corporate-profits)

The August 14 survey contains the Q3 nowcast. The checker matches the dated PDF to the native median workbook and recomputes the median and participating-forecaster count from individual responses. It requires the same quarter and accounting basis in all three. The November 16 PDF still identifies the third-quarter actual as unavailable. The previous-quarter column of a later survey workbook cannot settle this comparison. [August survey](https://www.philadelphiafed.org/surveys-and-data/real-time-data-research/spf-q3-2026) · [November survey](https://www.philadelphiafed.org/surveys-and-data/real-time-data-research/spf-q4-2026)

The control assumes profits stay at the preceding quarter's level. Its value comes from the target quarter's advance GDP vintage, in which the target profit cell is still empty. Revisions between the survey and the first profit release can affect the comparison. BEA's annual update on September 30 is one such revision. The checker binds the dated government workbook for both the control and the subsequent observation. [BEA annual update](https://www.bea.gov/AnnualUpdate) · [BEA vintage archive](https://apps.bea.gov/histdata/)

The BEA archive's 891 directory entries include 97 distinct release quarters from 2002 Q2 through 2026 Q2. Only 82 precede the first public ETF forecast and share the current survey accounting definition, introduced in 2006 Q1. Even a perfect match on every one would fall short of the 120-session historical screen for one ETF. An earlier forecast series excludes both adjustments. The registration does not combine these incompatible targets. [Survey methodology](https://www.philadelphiafed.org/-/media/frbp/assets/surveys-and-data/survey-of-professional-forecasters/spf-documentation.pdf) · [BEA dated archive inventory](https://apps.bea.gov/histdata/core/data/Fea_DisplayChildrenC/?HistMainId=7&getFiles=false&getDirs=true)

BEA announced the first Q3 profit estimate for **November 25 at 8:30 a.m. New York time**, after the scheduled 8 a.m. edition. The first-release checker reads the dated BEA announcement and PDF, quarterly NIPA Table 1.12 line 15 with series code A551RC and the matching ALFRED CPATAX vintage. The two delivery paths share the same originating agency. The operating host records when both deliveries actually became available to it. [Advance GDP release and next-release clock](https://www.bea.gov/news/2026/gdp-advance-estimate-3rd-quarter-2026) · [ALFRED CPATAX](https://alfred.stlouisfed.org/series?seid=CPATAX)

Run from `web` on a host with Python 3 and `pdftotext`.

```sh
python3 -B scripts/qualify_spf_profits.py witness
python3 -B scripts/qualify_spf_profits.py replay
python3 -B scripts/qualify_spf_profits.py compare
```

- `witness` captures the source documents, pins the survey and prior-quarter control before the release deadline, and replays the completed Q2 example. Use the existing owner-private `.consensus/private-spf-profit-witness/` store for later runs. The command refuses to create a first witness after the deadline.
- `replay` verifies the saved files and recomputes the comparisons offline. Use `--private-root PATH` for a store on another authorized local checkout.
- `compare` checks the actual clock before any source access. After release it requires the exact Q3 vintage on both delivery paths. Missing or inconsistent inputs leave the prospective result pending. The first complete packet is saved once and subsequent calls replay it.

The existing 07:48 New York weekday harvester runs `scheduled` after ordinary preparation. An unenrolled host or a run before the release makes no source request. A due run has a 60-second budget and a separate private lock. When BEA or its mirror is incomplete, the following weekday run can try again. After the original packet qualifies, the harvester uses its local copies. The scheduled log contains only status, quarter, result digest and verification time. Preparation preserves its own exit status on a research failure. [Weekday entry point](../scripts/weekday-harvest.sh)

On the authorized Mac, transfer the existing witness after installing the checker on the publisher. Run these commands from the publisher's `web` directory. They preserve any existing local originals. The offline replay must produce witness SHA-256 `fc6aacf1c01ae8de78ffcf84d84e9dd5505b1c2b4c301b712748134fdcb9ccb1`.

```sh
profit_source=../../daily-consensus-profits-forecast/web/.consensus/private-spf-profit-witness
profit_store=.consensus/private-spf-profit-witness
mkdir -m 700 -p "$profit_store"
/usr/bin/rsync -a --ignore-existing "$profit_source/originals" "$profit_source/prerelease.json" "$profit_store/"
/usr/bin/python3 -B scripts/qualify_spf_profits.py replay
```

The Philadelphia Fed limits site content to information, education and research and identifies restrictions on copyrighted material and use of its name. Keep the source files, participant records, survey-derived comparisons and any related experimentation in the owner's private research store. Its website does not establish a grant for product redistribution or commercial model use. [Philadelphia Fed usage terms](https://www.philadelphiafed.org/about-us/privacy-notice)
