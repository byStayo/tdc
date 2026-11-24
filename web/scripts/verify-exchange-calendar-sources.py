"""Replay the November 2026 exchange-calendar review using original public schedules and rules."""

import argparse
import hashlib
import html
from pathlib import Path
import re
import urllib.request

# Dated native bytes saved by the November 24 review. A live recheck may render a
# different HTML shell. Check both the intended source passages and the new hash.
SOURCES = {
    "NYSE holiday table": (
        "https://www.nyse.com/trade/hours-calendars",
        "8f213c85de7fc30cf98625535e225f7103f2fe0ae4a910640301ee8023e3ee57",
        ("Holiday 2026 2027 2028", "Friday, December 24 (Christmas Day observed)",
         "Friday, November 26, 2027", "Friday, November 24, 2028", "Monday, July 3, 2028",
         "Saturday, January 1, 2028", "Monday, January 17", "Monday, February 21",
         "Friday, April 14", "Monday, May 29", "Monday, June 19", "Tuesday, July 4",
         "Monday, September 4", "Thursday, November 23", "Monday, December 25")),
    "Nasdaq trading holidays, SEC Release 34-93675": (
        "https://www.govinfo.gov/content/pkg/FR-2021-12-03/html/2021-26242.htm",
        "d2e0537800c5c7e8975d7111d15fb77d43fc6adea10e70c4588aebf71c049f54",
        ("New Year's Day", "Juneteenth National Independence Day",
         "on the preceding Friday", "unless unusual business conditions")),
    "Nasdaq trading hours, approved April 2026": (
        "https://www.govinfo.gov/content/pkg/FR-2026-04-15/html/2026-07259.htm",
        "4f4bc7331f3259a4910fef16aaf088e11b16e26e6ebf1812ddde589699153def",
        ("commencing at 9:30 a.m.", "Regular Market Hours trading session until 4:00 p.m.",
         "designated by Nasdaq on a day when Nasdaq closes early")),
    "SEC order approving the market-hours designation procedure": (
        "https://www.govinfo.gov/content/pkg/FR-2001-04-17/html/01-9504.htm",
        "1e5d305c03028285b719ea45c23b4a323f871d6762736f9f8d793321dbb94171",
        ("who maintains the primary listing", "shall specify the regular trading hours")),
    "Cboe U.S. Equities holiday CSV": (
        "https://www.cboe.com/us/equities/holidays/csv/",
        "adde93b8446277072205c3dc59b27b8af6ce62377d5aa1c4f22145c1648953e9",
        ("Thanksgiving Early Close,2027-11-26", "Christmas Day Observed,2027-12-24")),
    "Nasdaq Trader calendar": (
        "https://www.nasdaqtrader.com/Trader.aspx?id=Calendar",
        "235143ddd414e4f31c9a2bd3818db6908c98c28a7840c17edb141f60dda26791",
        ("Equity and Options Markets Holiday Schedule 2026", "Nasdaq will continue to send alerts")),
    "UTP SIP Thanksgiving notice": (
        "https://www.nasdaqtrader.com/TraderNews.aspx?id=UTP2026-34",
        "eb21b1e801ef91b4a62030747d8e3e33280353b914e581eb4cd5d7d76df6141b",
        ("Friday, November 27, 2026", "9:30 a.m. to 1:00 p.m.")),
    "FINRA market transparency holiday calendar": (
        "https://www.finra.org/filing-reporting/market-transparency-reporting/holiday-calendar",
        "41cb1665f00cac2aeb4ecf214253419887f4eb19e51a1ad89c74331395c58aca",
        ("Friday, November 27, 2026", "Day after Thanksgiving (1 p.m. early close)")),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--saved", type=Path, help="directory of SHA-256-named .bin originals")
    mode.add_argument("--live", action="store_true", help="read the public sources without writing files")
    args = parser.parse_args()
    for name, (url, expected_hash, phrases) in SOURCES.items():
        if args.saved:
            raw = (args.saved / (expected_hash + ".bin")).read_bytes()
            if hashlib.sha256(raw).hexdigest() != expected_hash:
                raise ValueError(f"{name}: stored source digest differs")
        else:
            with urllib.request.urlopen(url, timeout=12) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError(f"{name}: source exceeds the reviewed limit")
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", raw.decode("utf-8", errors="replace"))))
        missing = [phrase for phrase in phrases if phrase.casefold() not in text.casefold()]
        if missing:
            raise ValueError(f"{name}: review the changed original for these missing passages: {missing}")
        # A newly published timetable warrants direct review. A matching old notice cannot confirm future hours.
        if name in {"Nasdaq Trader calendar", "FINRA market transparency holiday calendar"} and re.search(
            r"November 26, 2027|December 31, 2027|July 3, 2028|November 24, 2028", text, re.I
        ):
            raise ValueError(f"{name}: review the actual session clock for the newly listed date")
        print(f"{name}: {hashlib.sha256(raw).hexdigest()}")


if __name__ == "__main__":
    main()
