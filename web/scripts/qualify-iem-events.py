"""Rebuild the pre-outcome cohort from the IEM operators' original CC0 workbooks. Offline."""
import argparse
from collections import Counter, defaultdict
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from pathlib import Path
import re
import stat
import subprocess
from xml.etree import ElementTree
from zipfile import ZipFile

WEB = Path(__file__).resolve().parents[1]
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
WORKBOOKS = {
    "political-wta-2020-original.xlsx": "29c353526653482529245b43997bd7a495bedc67bb7051697a2fa0112d5aa7ce",
    "political-wta-2024.xlsx": "eeac2b38a88cc11ab2d5d0bd0c79c901e8ffaf8d43ab2110682ca70e0801b86b",
}
SOURCE_SHA = "cf718b3022d7026797be015ae8cb83ee9506c08725b10f32f568c596aab8f427"
FIRST_SELECTION = "330d8dfd4ffff43b47d600513a0af7d01019696a3fadcad04af50b26f6d2ec0c"
ELECTIONS = {2008: 4, 2012: 6, 2016: 8, 2020: 3, 2024: 5}
# The filed 2012 fund holidays include Columbus/Veterans Days for fund operations.
# Equities traded then. Hurricane Sandy closed the exchange on October 29 and 30.
CLOSED = {
    2008: set("0101 0121 0218 0321 0526 0704 0901 1127 1225".split()),
    2012: set("0102 0116 0220 0406 0528 0704 0903 1029 1030 1122 1225".split()),
}
SHORT = {2008: {"0703", "1128", "1224"}, 2012: {"0703", "1123", "1224"}}
SHEETS = {
    "2008": (2008, 0, {"VS": "BCDEFGI", "WTA": "PQRSTUW"}),
    "2012": (2012, 0, {"VS": "BCDEFGI", "WTA": "PQRSTUW"}),
    "2016": (2016, 0, {"VS": "BCDEFGI", "WTA": "PQRSTUW"}),
    "Main Data": (2020, 3, {"VS": "BCDEFGI", "WTA": "LMNOPQS"}),
    "PresVS": (2024, 2, {"VS": "BCDEFGH"}),
    "PresWTA": (2024, 2, {"WTA": "BCDEFGH"}),
}


def verified(directory, name, expected_sha):
    file = directory / name
    mode = file.lstat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o077 or not 0 < file.stat().st_size <= 9_000_000:
        raise ValueError("Expected an owner-only bounded original")
    if sha256(file.read_bytes()).hexdigest() != expected_sha:
        raise ValueError(f"Original differs from the frozen {name}")
    return file


def venue_sheets(file):
    """Open only the two named exchange contracts in the selected election sheets."""
    with ZipFile(file) as original:
        shared = ["".join(t.text or "" for t in item.iter(NS + "t")).strip()
                  for item in ElementTree.fromstring(original.read("xl/sharedStrings.xml"))]
        links = {link.get("Id"): link.get("Target")
                 for link in ElementTree.fromstring(original.read("xl/_rels/workbook.xml.rels"))}
        book = ElementTree.fromstring(original.read("xl/workbook.xml"))
        for sheet in book.iter(NS + "sheet"):
            spec = SHEETS.get(sheet.get("name"))
            if not spec:
                continue
            rid = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            sheet_xml = ElementTree.fromstring(original.read("xl/" + links[rid]))
            rows = []
            for row in sheet_xml.iter(NS + "row"):
                values = {}
                for cell in row.iter(NS + "c"):
                    value = cell.find(NS + "v")
                    if value is not None:
                        col = re.match("[A-Z]+", cell.get("r")).group()
                        values[col] = shared[int(value.text)] if cell.get("t") == "s" else value.text
                rows.append(values)
            yield spec, rows


def number(value):
    try:
        return Decimal(value.replace(",", "").strip())
    except (AttributeError, InvalidOperation):
        return None


def numeric_features(group):
    if len(group) != 4:
        return None
    features = []
    for market in ("VS", "WTA"):
        last_trades = []
        for party in ("DEM", "REP"):
            trade = group.get((market, party))
            if trade is None or None in trade:
                return None
            units, dollars, low, high, last = trade
            if not (units > 0 and units == int(units) and dollars > 0 and 0 <= low <= last <= high <= 1 and 0 < last < 1):
                return None
            last_trades.append(last)
        total = sum(last_trades)
        if not Decimal("0.90") <= total <= Decimal("1.10"):
            return None
        features.append(float(2 * abs(last_trades[0] / total - Decimal("0.5"))))
    return features


def ordinary_dates():
    code = """import {extendedResearchSession, extendedResearchSessions} from './lib/consensus/extended-research-calendar.ts';
const days = extendedResearchSessions('2016-01-01','2024-11-05').filter(day => {
  const hours = extendedResearchSession(day);
  return Date.parse(hours.closeAt) - Date.parse(hours.openAt) === 23400000;
});
console.log(JSON.stringify(days));"""
    return set(json.loads(subprocess.check_output(
        ["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], cwd=WEB, timeout=12)))


def replay(directory):
    base = json.loads(verified(directory, "matched-source.json", FIRST_SELECTION).read_bytes())
    sealed = json.loads(verified(directory, "extended-source.json", SOURCE_SHA).read_bytes())
    if sealed["priorSourceSHA256"] != FIRST_SELECTION:
        raise ValueError("Original 83-target source selection changed")
    grouped = defaultdict(dict)
    for filename, digest in WORKBOOKS.items():
        for (cycle, header, columns), rows in venue_sheets(verified(directory, filename, digest)):
            for market, cols in columns.items():
                schema = [rows[header].get(col, "").upper().replace(" ", "") for col in cols]
                if schema[:3] != ["DATE", "CONTRACT", "UNITS"] or schema[3] not in {"$VOLUME", "DOLLARVOLUME"} or schema[4:] != ["LOWPRICE", "HIGHPRICE", "LASTPRICE"]:
                    raise ValueError("Market source schema changed")
                contract = re.compile(rf"U?(DEM|REP){cycle % 100:02d}_{market}$")
                for row in rows[header + 1:]:
                    match = contract.fullmatch(row.get(cols[1], ""))
                    if not match:
                        continue
                    serial = Decimal(row[cols[0]])
                    if serial != int(serial):
                        raise ValueError("Unsupported event timestamp")
                    day = date(1899, 12, 30) + timedelta(days=int(serial))
                    if cycle in CLOSED and day.year != cycle or cycle >= 2016 and day < date(2016, 1, 1):
                        continue
                    values = tuple(number(row.get(c)) for c in cols[2:])
                    key = (market, match[1])
                    existing = grouped[cycle, day]
                    if key in existing and existing[key] != values:
                        raise ValueError("Conflicting native rows for one venue day and contract")
                    existing[key] = values

    reviewed = ordinary_dates()
    result = []
    for (cycle, observed), group in sorted(grouped.items()):
        target = observed + timedelta(days=1)
        if target >= date(cycle, 11, ELECTIONS[cycle]):
            continue
        if cycle in CLOSED:
            code = target.strftime("%m%d")
            if target.year != cycle or target.weekday() >= 5 or code in CLOSED[cycle] or code in SHORT[cycle]:
                continue
        elif str(target) not in reviewed:
            continue
        features = numeric_features(group)
        if features is not None:
            result.append({"cycle": cycle, "nativeDay": str(observed), "target": str(target), "features": features})
    if result != sealed["rows"] or [r for r in result if r["cycle"] >= 2016] != base["rows"]:
        raise ValueError("Reconstructed two-market source rows differ from the pre-outcome selection")
    counts = dict(Counter(r["cycle"] for r in result))
    if counts != {2008: 85, 2012: 46, 2016: 51, 2020: 24, 2024: 8}:
        raise ValueError("Unexpected per-election source count")
    return {"selection": SOURCE_SHA, "total": len(result), "cycles": counts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("private_directory", type=Path)
    print(json.dumps(replay(parser.parse_args().private_directory)))
