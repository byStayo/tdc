"""Read the dated By Quarter table from the official New York Fed chart workbook."""

from datetime import date, timedelta
from io import BytesIO
import json
import math
import re
import sys
from xml.etree import ElementTree
from zipfile import ZipFile


NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
MAX_INPUT = 2_000_000


def xml_part(book, name):
    entry = book.getinfo(name)
    if entry.file_size > 800_000:
        raise ValueError("Nowcast workbook part is too large")
    data = book.read(entry)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("Unexpected workbook declarations")
    return ElementTree.fromstring(data)


def table(raw):
    if not raw or len(raw) > MAX_INPUT:
        raise ValueError("Nowcast workbook size outside bounds")
    with ZipFile(BytesIO(raw)) as book:
        names = xml_part(book, "xl/workbook.xml").findall("m:sheets/m:sheet", NS)
        matches = [entry for entry in names if entry.get("name") == "Forecasts By Quarter"]
        if len(matches) != 1:
            raise ValueError("Expected the named Forecasts By Quarter sheet")
        rel = matches[0].get(REL)
        links = [item.get("Target", "") for item in xml_part(book, "xl/_rels/workbook.xml.rels")
                 if item.get("Id") == rel and item.get("TargetMode") != "External"]
        if len(links) != 1 or not re.fullmatch(r"worksheets/sheet[1-9][0-9]*\.xml", links[0]):
            raise ValueError("Unrecognized nowcast sheet reference")
        strings = ["".join(elem.text or "" for elem in node.findall(".//m:t", NS))
                   for node in xml_part(book, "xl/sharedStrings.xml")]
        rows = {}
        for row in xml_part(book, "xl/" + links[0]).findall("m:sheetData/m:row", NS):
            number = int(row.attrib["r"])
            values = {}
            for cell in row.findall("m:c", NS):
                match = re.fullmatch(r"([A-Z]+)[0-9]+", cell.attrib["r"])
                if not match or match[1] in values:
                    raise ValueError("Invalid or repeated cell in nowcast table")
                value = cell.findtext("m:v", "", NS)
                values[match[1]] = strings[int(value)] if cell.get("t") == "s" else value
            if number in rows:
                raise ValueError("Repeated row in nowcast workbook")
            rows[number] = values
        return rows


def read_forecasts(raw):
    rows = table(raw)
    header = rows.pop(6)
    if header.pop("A") != "Forecast Date" or not header or not all(re.fullmatch(r"20\d\dQ[1-4]", q) for q in header.values()):
        raise ValueError("Unexpected New York Fed forecast table header")
    result = []
    for number, values in sorted(rows.items()):
        raw_day = values.get("A", "")
        if number < 7 or not raw_day:
            continue
        serial = int(raw_day)
        if not 44_000 <= serial <= 50_000:
            raise ValueError("Date outside the current workbook era")
        day = (date(1899, 12, 30) + timedelta(days=serial)).isoformat()
        forecast = {quarter: float(values[column]) for column, quarter in header.items() if values.get(column)}
        if not forecast or not all(math.isfinite(value) for value in forecast.values()) or (result and day <= result[-1]["date"]):
            raise ValueError("Invalid dated forecast row")
        result.append({"date": day, "quarters": forecast})
    if not result or len(result) > 800:
        raise ValueError("Dated forecast coverage outside bounds")
    return result


if __name__ == "__main__":
    print(json.dumps(read_forecasts(sys.stdin.buffer.read(MAX_INPUT + 1)), separators=(",", ":"), allow_nan=False))
