"""Extract numeric proposal fields from original SEC Form 144 XML."""

from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
import sys
from xml.etree import ElementTree as ET


NS = {"sec": "http://www.sec.gov/edgar/ownership"}


def date_field(value):
    return datetime.strptime(value or "", "%m/%d/%Y").date().isoformat()


def positive(value):
    try:
        number = Decimal(value or "")
    except InvalidOperation as error:
        raise ValueError("Invalid Form 144 proposal amount") from error
    if not number.is_finite() or number <= 0 or number > 2**53 - 1:
        raise ValueError("Form 144 proposal amount is outside the supported range")
    return float(number)


def parse(original):
    if "<!DOCTYPE" in original or "<!ENTITY" in original:
        raise ValueError("Unexpected Form 144 XML declaration")
    root = ET.fromstring(original)
    form = root.find("sec:formData", NS)
    if root.findtext("sec:headerData/sec:submissionType", namespaces=NS) != "144" or form is None:
        raise ValueError("Expected an original Form 144")
    issuer = form.findtext(".//sec:issuerCik", namespaces=NS)
    if not issuer or not issuer.isdecimal() or not 0 < int(issuer) < 10**10:
        raise ValueError("Invalid Form 144 issuer")
    signature = form.find("sec:noticeSignature", NS)
    if signature is None:
        raise ValueError("Missing Form 144 signature block")
    notice_day = date_field(signature.findtext("sec:noticeDate", namespaces=NS))
    plans = sorted(set(date_field(entry.text) for entry in signature.findall(".//sec:planAdoptionDate", NS)))
    if any(day > notice_day for day in plans):
        raise ValueError("Form 144 plan date follows the notice")
    proposals = []
    for row in form.findall("sec:securitiesInformation", NS):
        security = (row.findtext("sec:securitiesClassTitle", namespaces=NS) or "").strip()
        if not security or len(security) > 125:
            raise ValueError("Invalid Form 144 security class")
        proposals.append({"security": security, "approxSaleDate": date_field(row.findtext("sec:approxSaleDate", namespaces=NS)),
                          "shares": positive(row.findtext("sec:noOfUnitsSold", namespaces=NS)),
                          "marketValue": positive(row.findtext("sec:aggregateMarketValue", namespaces=NS))})
    if not proposals or len(proposals) > 30:
        raise ValueError("Missing or unexpectedly many Form 144 proposal rows")
    return {"cik": issuer.zfill(10), "noticeDate": notice_day, "planAdoptionDates": plans, "proposals": proposals}


if __name__ == "__main__":
    print(json.dumps([parse(text) for text in json.load(sys.stdin)], separators=(",", ":"), allow_nan=False))
