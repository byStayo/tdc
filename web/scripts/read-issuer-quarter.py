"""Read one entity-wide quarterly US GAAP revenue fact from a filed SEC XBRL instance."""
import datetime as dt
import io
import re
import sys
import xml.etree.ElementTree as ET


INSTANCE = "{http://www.xbrl.org/2003/instance}"
SEC_CIK = "http://www.sec.gov/CIK"
CONCEPTS = {"AMD": ("0000002488", "RevenueFromContractWithCustomerExcludingAssessedTax"),
            "NVDA": ("0001045810", "Revenues")}


def revenue(xml, ticker, start, end, fiscal_year, fiscal_quarter):
    if len(xml) > 5_000_000 or re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", xml, re.I):
        raise ValueError("Invalid XBRL document")
    cik, tag = CONCEPTS[ticker]
    if not 75 <= (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days <= 105:
        raise ValueError("Invalid fiscal quarter duration")
    namespaces = {}
    for _, (prefix, uri) in ET.iterparse(io.BytesIO(xml), events=("start-ns",)):
        if prefix in namespaces and namespaces[prefix] != uri:
            raise ValueError("Conflicting XBRL namespace")
        namespaces[prefix] = uri
    root = ET.fromstring(xml)
    if root.tag != INSTANCE + "xbrl":
        raise ValueError("Expected an XBRL instance")
    contexts = {}
    for item in root.findall(INSTANCE + "context"):
        identifier = item.find(INSTANCE + "entity/" + INSTANCE + "identifier")
        if (identifier is None or identifier.get("scheme") != SEC_CIK or identifier.text != cik or
                item.find(".//" + INSTANCE + "segment") is not None or
                item.find(".//" + INSTANCE + "scenario") is not None):
            continue
        period = item.find(INSTANCE + "period")
        cid = item.get("id")
        if not cid or cid in contexts or period is None:
            raise ValueError("Invalid consolidated XBRL context")
        contexts[cid] = (period.findtext(INSTANCE + "startDate"), period.findtext(INSTANCE + "endDate"))
    report = {"EntityCentralIndexKey": cik, "DocumentType": "10-Q", "DocumentPeriodEndDate": end,
              "DocumentFiscalYearFocus": fiscal_year, "DocumentFiscalPeriodFocus": "Q" + fiscal_quarter}
    usd = set()
    for unit in root.findall(INSTANCE + "unit"):
        if len(unit) != 1 or unit[0].tag != INSTANCE + "measure":
            continue
        parts = (unit[0].text or "").split(":")
        if len(parts) == 2 and parts[1] == "USD" and namespaces.get(parts[0]) == "http://www.xbrl.org/2003/iso4217":
            usd.add(unit.get("id"))
    cover = {name: set() for name in report}
    amounts = set()
    for fact in root:
        period = contexts.get(fact.get("contextRef"))
        if not period or period[1] != end:
            continue
        if re.fullmatch(r"\{https?://xbrl\.sec\.gov/dei/\d{4}\}[A-Za-z]+", fact.tag):
            name = fact.tag.split("}")[-1]
            if name in cover:
                cover[name].add(fact.text)
        if (period == (start, end) and fact.get("unitRef") in usd and
                re.fullmatch(r"\{https?://fasb\.org/us-gaap/\d{4}\}" + tag, fact.tag)):
            value = (fact.text or "").strip()
            if not re.fullmatch(r"[1-9]\d*(?:\.0+)?", value):
                raise ValueError("Invalid reported USD quarterly revenue")
            amounts.add(int(value.partition(".")[0]))
    if any(cover[k] != {v} for k, v in report.items()) or len(amounts) != 1:
        raise ValueError("No unique consolidated USD quarter matching the issuer and fiscal cover")
    return amounts.pop()


if __name__ == "__main__":
    print(revenue(sys.stdin.buffer.read(5_000_001), *sys.argv[1:]))
