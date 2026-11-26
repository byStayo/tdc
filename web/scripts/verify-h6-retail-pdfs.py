"""Check both balance columns, economic periods and publication date against a second Board rendering."""
import argparse
import calendar
import datetime as dt
import json
import os
import re
import runpy
import subprocess
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path

helper = runpy.run_path(str(Path(__file__).with_name("research-h6-retail-originals.py")))
root = helper["ROOT"]
months = {x[:3].lower():i for i,x in enumerate(calendar.month_name) if i}
number = r"[0-9,]+\.[0-9]+"

def rendered_pairs(text):
    section = re.search(r"(?im)^\s*Seasonally Adjusted Components of Non-M1 M2\s*$",text)
    if not section:
        raise ValueError("PDF lacks the original seasonally adjusted components table")
    table = re.split(r"(?i)Week ending|Table 5|NOT SEASONALLY ADJUSTED COMPONENTS",text[section.end():],1)[0]
    if not re.search("retail",table,re.I) or not re.search("small-denomination time deposit",table,re.I):
        raise ValueError("PDF lacks the named retail and bank components")
    found = {}
    year = None
    for line in table.splitlines():
        row = re.fullmatch(r"\s*(?:(\d{4})[- ])?([A-Za-z]+)\.?\s*(?:[pre]\s+)?\s*((?:"+number+r"\s+(?:[pre]\s+)?){8}"+number+r")\s*",line)
        if not row or row[2][:3].lower() not in months:
            continue
        year = row[1] or year
        if not year:
            raise ValueError("Missing accounting year in PDF table")
        ym = f"{year}-{months[row[2][:3].lower()]:02d}"
        if ym in found:
            raise ValueError("Duplicate monthly PDF row")
        ns = re.findall(number,row[3])
        if len(ns)!=9:
            raise ValueError("PDF column count differs")
        found[ym]=[Decimal(ns[i].replace(",","")) for i in [6,5]]
    return found

def check(directory, event, collecting):
    day=event["release"];compact=day.replace("-","")
    native=helper["native"]; board=helper["BOARD"]
    page,receipt=native(directory,compact,board+compact+"/",False)
    if receipt["sha256"]!=event["raw"]:
        raise ValueError("Different HTML release")
    names=set(re.findall(rb'href=["\'](h6\.pdf)["\']',page,re.I))
    if len(names)>1:
        raise ValueError("Ambiguous native PDF")
    if not names and day >= "2021-02-23":
        # An unlinked March URL serves the final February 11 weekly PDF. Use a
        # separate Board table and its post-May-2020 statutory M2 identity instead.
        html=page.decode()
        tables=list(re.finditer(r"<table\b.*?</table>",html,re.I|re.S))
        overall=[]
        for table in tables:
            title=helper["clean"](html[max(0,table.start()-400):table.start()])
            if re.search(r"Table 1 Money Stock Measures\. Billions of dollars(?: unless otherwise noted)?\.\s*$",title,re.I):
                parser=helper["Rows"]()
                parser.feed(table[0])
                overall.append(parser.rows)
        if len(overall)!=1 or overall[0][0][:3]!=["Date","Seasonally adjusted","Not seasonally adjusted"]:
            raise ValueError("Expected Board Table 1 with the correct adjustment basis "+day)
        if not all(re.fullmatch(s,field) for s,field in zip((r"M1(?: \d+)?",r"M2(?: \d+)?"),overall[0][1][:2])):
            raise ValueError("Expected the official M1 and M2 balances")
        checks=[]
        for period,key in ((event["period"],"current"),(helper["prior_month"](event["period"]),"previous")):
            matches=[]
            for row in overall[0]:
                named=re.fullmatch(r"([A-Za-z]+)\.? (\d{4})",row[0])
                if named and named[1][:3].lower() in months and f"{named[2]}-{months[named[1][:3].lower()]:02d}"==period:
                    matches.append(row)
            if len(matches)!=1:
                raise ValueError("Expected one original Table 1 row "+day)
            m1,m2=(Decimal(x.replace(",","")) for x in matches[0][1:3])
            delta=m2-m1-sum(Decimal(x) for x in event[key])
            if abs(delta)>Decimal("0.2"):
                raise ValueError("Published M2 - M1 disagrees with retail funds plus small deposits "+day)
            checks.append({"month":period,"roundingDifference":str(delta)})
        return {"date":day,"html":event["raw"],"pdf":None,"boardAggregateReconciliation":checks}
    name=names.pop().decode() if names else "h6.pdf"
    pdf,meta=native(directory,"pdf-"+compact,board+compact+"/"+name,collecting,1_500_000)
    if not pdf.startswith(b"%PDF-"):
        raise ValueError("Unexpected native document "+day)
    text=subprocess.run(["pdftotext","-layout","-","-"],input=pdf,capture_output=True,timeout=10,check=True).stdout.decode()
    date=dt.date.fromisoformat(day)
    printed=rf"{calendar.month_name[date.month]}\s+{date.day},\s+{date.year}"
    if not re.search(printed,text[:4800],re.I):
        raise ValueError("Native PDF clock differs "+day)
    found=rendered_pairs(text)
    previous=helper["prior_month"](event["period"])
    for ym,key in ((event["period"],"current"),(previous,"previous")):
        if found.get(ym)!=[Decimal(x) for x in event[key]]:
            raise ValueError("Native PDF component values or reference period disagree "+day+" "+ym)
    return {"date":day,"html":event["raw"],"pdf":meta["sha256"],"checkedMonthPair":[previous,event["period"]]}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect",action="store_true")
    parser.add_argument("--directory",type=Path,default=root)
    args=parser.parse_args()
    os.umask(0o077)
    source=helper["owner_json"](args.directory/"board-first-months.json")
    with ThreadPoolExecutor(max_workers=3) as pool:
        checked=list(pool.map(lambda e:check(args.directory,e,args.collect),[e for e in source["months"] if "release" in e]))
    proof={"source":helper["sha"]((args.directory/"board-first-months.json").read_bytes()),"rows":checked}
    print(json.dumps({"verifiedPDFs":sum(bool(r["pdf"]) for r in checked),"verifiedBoardTablePairs":sum(bool(r.get("boardAggregateReconciliation")) for r in checked),"originals":len(checked),
                      "sha256":helper["seal"](args.directory/"board-renderings.json",proof)}))

if __name__=="__main__":
    main()
