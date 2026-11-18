"""Read the SEC's quarterly individual-security ZIP and emit only five ETF ratios."""
import csv
from datetime import date
import io
import json
import math
import re
import sys
from zipfile import ZipFile

SYMBOLS = ("SPY", "QQQ", "IWM", "DIA", "TLT")
MAX_ZIP_BYTES = 40_000_000
MAX_CSV_BYTES = 160_000_000
METRICS = (
    ("LitVol('000)", "OrderVol('000)", 100),
    ("Cancels", "LitTrades", 1),
    ("HiddenVol('000)", "TradeVolForHidden('000)", 100),
    ("OddLotVol('000)", "TradeVolForOddLots('000)", 100),
)


def ratios(row):
    result = []
    for numerator, denominator, scale in METRICS:
        top, bottom = float(row[numerator]), float(row[denominator])
        if not math.isfinite(top) or not math.isfinite(bottom) or top < 0 or bottom <= 0:
            raise ValueError("Invalid MIDAS volume or message count")
        result.append(round(scale * top / bottom, 6))
    if max(result[2:]) > 100:
        raise ValueError("Invalid MIDAS hidden or odd-lot share")
    return result


def parse(payload, year, quarter):
    if len(payload) > MAX_ZIP_BYTES:
        raise ValueError("MIDAS ZIP exceeds size limit")
    start_month, end_month = 1 + 3 * (quarter - 1), 3 * quarter
    rows = {symbol: {} for symbol in SYMBOLS}
    with ZipFile(io.BytesIO(payload)) as archive:
        members = [member for member in archive.infolist() if member.filename.lower().endswith(".csv")]
        if len(members) != 1 or members[0].file_size > MAX_CSV_BYTES:
            raise ValueError("Expected one bounded MIDAS CSV")
        with archive.open(members[0]) as file:
            reader = csv.DictReader(io.TextIOWrapper(file, encoding="utf-8-sig", newline=""))
            columns = {"Date", "Security", "Ticker", *(key for pair in METRICS for key in pair[:2])}
            if not reader.fieldnames or not columns.issubset(reader.fieldnames) or len(set(reader.fieldnames)) != len(reader.fieldnames):
                raise ValueError("Invalid MIDAS CSV schema")
            for row in reader:
                ticker = row["Ticker"]
                if ticker not in rows:
                    continue
                raw_date = row["Date"]
                if row["Security"] != "ETF" or not re.fullmatch(r"[0-9]{8}", raw_date):
                    raise ValueError("Invalid MIDAS ETF identity or date")
                year_number, month_number, day_number = int(raw_date[:4]), int(raw_date[4:6]), int(raw_date[6:])
                day = date(year_number, month_number, day_number).isoformat()
                if year_number != year or not start_month <= month_number <= end_month or day in rows[ticker]:
                    raise ValueError("Out-of-quarter or duplicate MIDAS row")
                rows[ticker][day] = ratios(row)
    dates = sorted(rows[SYMBOLS[0]])
    if not dates or any(sorted(values) != dates for values in rows.values()):
        raise ValueError("Inconsistent MIDAS dates across the five ETFs")
    return {symbol: [[day, *values[day]] for day in dates] for symbol, values in rows.items()}


if __name__ == "__main__":
    year, quarter = map(int, sys.argv[1:])
    print(json.dumps(parse(sys.stdin.buffer.read(MAX_ZIP_BYTES + 1), year, quarter), allow_nan=False))
