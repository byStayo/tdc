"""Read the recent point-in-time revisions from Philadelphia Fed's published ADS archive."""

from datetime import date, datetime, timedelta
from hashlib import sha256
import json
import math
from pathlib import Path
import re
from shutil import copyfileobj
from stat import S_IMODE
import sys
from tempfile import NamedTemporaryFile
from xml.etree import ElementTree as ET
from zipfile import ZipFile


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
ROW = re.compile(rb'<row\b[^>]*\br="([0-9]+)"')
DATE_CELL = re.compile(rb'<c\b[^>]*\br="A([0-9]+)"[^>]*\bt="s"[^>]*><v>([0-9]+)</v></c>')
CELL = re.compile(r"([A-Z]+)([0-9]+)")
VINTAGE = re.compile(r"ADS_INDEX_([0-9]{6})")
FROM = date(2021, 12, 1)
THROUGH = date(2026, 11, 17)


def sheet_rows(stream):
    """Keep only a bounded row and chunk in memory even for the complete sheet."""
    remaining = b""
    while chunk := stream.read(2_000_000):
        buffer = remaining + chunk
        start = buffer.find(b"<row ")
        while start >= 0:
            end = buffer.find(b"</row>", start)
            if end < 0:
                remaining = buffer[start:]
                if len(remaining) > 300_000:
                    raise ValueError("Unexpected ADS worksheet row size")
                break
            if end + 6 - start > 300_000:
                raise ValueError("Unexpected ADS worksheet row size")
            yield buffer[start:end + 6]
            start = buffer.find(b"<row ", end + 6)
        else:
            remaining = buffer[-8:]
    if b"<row " in remaining:
        raise ValueError("Truncated ADS worksheet row")


def cells(fragment, ordinal):
    # Excel may declare row-height metadata with this namespace at the top of the sheet.
    wrapper = b'<root xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">'
    row = ET.fromstring(wrapper + fragment + b'</root>')[0]
    if row.tag != "row" or row.get("r") != str(ordinal):
        raise ValueError("Invalid ADS row number")
    seen = set()
    for cell in row.findall("c"):
        match = CELL.fullmatch(cell.attrib["r"])
        if not match or int(match[2]) != ordinal or match[1] in seen:
            raise ValueError("Invalid or duplicate ADS cell")
        seen.add(match[1])
        yield match[1], cell.get("t"), cell.findtext("v", "")


def vintage_columns(header, strings):
    columns = {}
    for column, kind, index in cells(header, 1):
        if kind != "s":
            raise ValueError("ADS column labels must be strings")
        text = strings[int(index)]
        if column == "A" and text == "Date":
            continue
        match = VINTAGE.fullmatch(text)
        if not match:
            raise ValueError("Unrecognized ADS vintage label")
        columns[column] = datetime.strptime(match[1], "%m%d%y").date()
    dates = list(columns.values())
    if len(dates) < 1_500 or dates != sorted(set(dates)) or dates[-1] != THROUGH:
        raise ValueError("ADS archive has an unexpected publication calendar")
    return columns


def extract(workbook):
    sheet = workbook.getinfo("xl/worksheets/sheet1.xml")
    strings_file = workbook.getinfo("xl/sharedStrings.xml")
    if sheet.file_size > 1_600_000_000 or strings_file.file_size > 1_000_000:
        raise ValueError("ADS worksheet exceeds the verified scope")
    strings = ["".join(node.text or "" for node in item.iter(NS + "t"))
               for item in ET.fromstring(workbook.read(strings_file))]
    with workbook.open(sheet) as stream:
        rows = sheet_rows(stream)
        columns = vintage_columns(next(rows), strings)
        chosen = {column: day for column, day in columns.items() if FROM <= day <= THROUGH}
        values = {day: {} for day in chosen.values()}
        prior_observed = None
        count = 0
        for ordinal, fragment in enumerate(rows, 2):
            row = ROW.match(fragment[:150])
            date_cell = DATE_CELL.search(fragment[:400])
            if not row or not date_cell or int(row[1]) != ordinal or int(date_cell[1]) != ordinal:
                raise ValueError("Missing or nonconsecutive ADS date row")
            observed = date.fromisoformat(strings[int(date_cell[2])].replace(":", "-"))
            if prior_observed is not None and observed != prior_observed + timedelta(days=1):
                raise ValueError("Missing calendar date in daily ADS worksheet")
            prior_observed = observed
            count += 1
            if observed < FROM - timedelta(days=90):
                continue
            for column, kind, text in cells(fragment, ordinal):
                published = chosen.get(column)
                if not published or not text or not published - timedelta(days=90) <= observed <= published:
                    continue
                if ((kind == "s" and strings[int(text)] in ("", "NA", "#N/A", ".", "N/A"))
                        or (kind == "e" and text == "#N/A")):
                    continue
                if kind not in (None, "n") or not math.isfinite(value := float(text)):
                    raise ValueError("Invalid ADS observation value")
                values[published][observed] = value
    updates = []
    for previous, published in zip(values, list(values)[1:]):
        common = values[previous].keys() & values[published].keys()
        if not common:
            raise ValueError("Adjacent ADS releases have no recent common observation")
        observed = max(common)
        updates.append({"date": published.isoformat(), "previous": previous.isoformat(), "observed": observed.isoformat(),
                        "change": values[published][observed] - values[previous][observed]})
    return {"allVintages": len(columns), "allDailyRows": count, "selectedVintages": len(chosen),
            "firstVintage": next(iter(columns.values())).isoformat(), "lastVintage": THROUGH.isoformat(), "updates": updates}


def main():
    if len(sys.argv) != 3:
        raise ValueError("ADS extractor requires a pinned private ZIP and its SHA-256")
    archive_path = Path(sys.argv[1])
    stat = archive_path.lstat()
    if not archive_path.is_file() or archive_path.is_symlink() or S_IMODE(stat.st_mode) != 0o600 or stat.st_size > 180_000_000:
        raise ValueError("ADS archive must be a bounded owner-only file")
    checksum = sha256()
    with archive_path.open("rb") as file:
        while piece := file.read(2_000_000):
            checksum.update(piece)
    if checksum.hexdigest() != sys.argv[2]:
        raise ValueError("ADS source archive differs from its receipt")
    with ZipFile(archive_path) as outer, NamedTemporaryFile(prefix="tdc-ads-workbook-") as inner:
        info = outer.getinfo("ads_all_vintages-zip.xlsx")
        if len(outer.infolist()) != 1 or info.file_size > 220_000_000:
            raise ValueError("Unrecognized ADS archive contents")
        with outer.open(info) as source:
            copyfileobj(source, inner, 1_000_000)
        inner.flush()
        with ZipFile(inner.name) as workbook:
            result = extract(workbook)
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
