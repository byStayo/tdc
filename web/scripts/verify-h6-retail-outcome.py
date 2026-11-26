"""Independently reproduce the sealed H.6/IWM retrospective from the Board and Kibot originals."""
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import runpy
import subprocess
import sys
from decimal import Decimal
from pathlib import Path
from statistics import fmean
from zoneinfo import ZoneInfo

SCRIPTS = Path(__file__).resolve().parent
hashbytes = lambda b: hashlib.sha256(b).hexdigest()
NATIVE = "cbf12a1579fa765852c92b46f3d54002b1b35bb9e3d0348abe3ea5d9f4a85097"
RENDERING = "a9b56c0b90f38fb79bf33da31d04c46c62d0a171d2d9b0ee3df92e4b7ac1a177"
RESERVATION = "ef2f3b98b38fa6330ec21dc346729ca46f1d803172415f61e972e7434c83c5dd"
RESULT = "022d23d33b1643fdea09faa8309e1e25faea503d94c2bf8ef72176ba7c9c6370"
BEFORE = "2026-11-03T06:28:30.460Z"
NY = ZoneInfo("America/New_York")
fit = runpy.run_path(str(SCRIPTS / "verify-g17-manufacturing.py"))

def sealed(path, sha):
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError("Study receipt must be a private regular file")
    raw = path.read_bytes()
    if hashbytes(raw) != sha:
        raise ValueError("Pinned study receipt differs: " + path.name)
    return json.loads(raw)

def clock(day, hour, minute):
    at = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(hour, minute), NY)
    return at.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")

def at_fraction(v, q):
    return v[int(len(v)*q)-1]

def intervals(differences):
    n=len(differences)
    full=[[sum(x[j] for x in differences[i:i+3]) for j in range(3)] for i in range(n-2)]
    tail=len(differences)%3
    part=[[sum(x[j] for x in differences[i:i+tail]) for j in range(3)] for i in range(n-2)]
    samples=[[], [], []]
    state=20261124
    for _ in range(100_000):
        total=[0.,0.,0.]
        for pos in range(0,n,3):
            state=(state*1664525+1013904223)%(2**32)
            index=state*(n-2)//(2**32)
            group=part[index] if pos+3>n else full[index]
            for j in range(3):
                total[j]+=group[j]
        for j in range(3):
            samples[j].append(total[j]/n)
    stats=[]
    for j,ids in enumerate(samples):
        ids.sort()
        stats.append(dict(mean=fmean(x[j] for x in differences),interval95=[at_fraction(ids,.025),at_fraction(ids,.975)],
                          correctedLower=at_fraction(ids,.05/(33*3))))
    return stats

def verify(directory):
    if directory.stat().st_mode & 0o077:
        raise ValueError("Private study input directory required")
    expected=sealed(directory/"result.json",RESULT)
    reg=sealed(directory/"reservation.json",RESERVATION)
    for name,field in (("research-h6-retail-iwm.ts","scriptSha256"),
                       ("research-h6-retail-originals.py","sourceScriptSha256"),
                       ("verify-h6-retail-pdfs.py","renditionsScriptSha256"),
                       ("h6-retail-iwm-policy.json","policySha256")):
        if hashbytes((SCRIPTS/name).read_bytes()) != reg[field]:
            raise ValueError("Registered program or policy differs: "+name)
    for name,key,value in (("research-h6-retail-originals.py","seal",NATIVE),("verify-h6-retail-pdfs.py","sha256",RENDERING)):
        run=subprocess.run([sys.executable,"-B",str(SCRIPTS/name),"--directory",str(directory)],
                           check=True,capture_output=True,timeout=100)
        if json.loads(run.stdout)[key]!=value:
            raise ValueError("Native feature verification differs")
    manifest=sealed(directory/"cohort.json",reg["cohortSha256"])
    boards=sealed(directory/"board-first-months.json",NATIVE)
    seal=sealed(directory/"board-renderings.json",RENDERING)
    if manifest["before"]!=BEFORE or manifest["source"]!=NATIVE or manifest["renderingHash"]!=RENDERING or seal["source"]!=NATIVE:
        raise ValueError("Detached native source proof")
    policy=json.loads((SCRIPTS/"h6-retail-iwm-policy.json").read_bytes())["sealedInputPolicy"]
    earlier=sealed(directory/"excluded-roster.json",policy["dolRoster"])
    excluded={r["day"] for r in earlier["releases"]}
    native={e["raw"]:e for e in boards["months"] if "release" in e}
    features={}
    for row in manifest["rows"]:
        src=native[row["original"]]
        day=row["day"]
        if (src["release"]!=row["release"] or src["period"]!=row["month"] or day in excluded or day in features
            or not(src["release"]<day<"2022") or clock(day,7,48)!=row["issuedAt"] or clock(day,9,30)!=row["openAt"]
            or clock(day,16,0)!=row["closeAt"] or row["closeAt"]>=BEFORE):
            raise ValueError("Source period, duplicated day, or protected clock differs")
        ratio=lambda i:-100*math.log(float(src["current"][i])/float(src["previous"][i]))/5
        calculated=[min(1.,max(-1.,ratio(i))) for i in range(2)]
        if any(abs(a-b)>1e-14 for a,b in zip(calculated,row["features"])):
            raise ValueError("Independent feature transform disagrees")
        features[day]=calculated
    permitted=set(features)
    signed={"raw":{}, "splits":{}}
    for name,digest in expected["sourceHashes"].items():
        receipt=sealed(directory/"prices"/name,digest)
        if receipt["receivedAt"]<=reg["frozenAt"] or hashbytes(receipt["csv"].encode())!=receipt["sha256"]:
            raise ValueError("Historical source timing or native Kibot bytes differ")
        for line in receipt["csv"].splitlines():
            day=dt.datetime.strptime(line[:10],"%m/%d/%Y").date().isoformat()
            if day not in permitted:
                continue  # Never decode the price of a previously used or unregistered IWM target.
            obs=list(csv.reader([line]))[0]
            opening,high,low,closing=(Decimal(x) for x in obs[1:5])
            if not(low<=min(opening,closing)<=max(opening,closing)<=high and low>0):
                raise ValueError("Invalid reserved native price")
            target=signed[receipt["basis"]]
            if day in target:
                raise ValueError("Duplicate native target")
            target[day]=(closing>opening)-(closing<opening)
    if set(signed["raw"])!=permitted or signed["raw"]!=signed["splits"]:
        raise ValueError("Required raw and split bases do not agree")
    days=sorted(permitted)
    n=len(days)
    folds=[days[:int(n*.6)],days[int(n*.6):int(n*.8)],days[int(n*.8):]]
    if folds!=[manifest[x] for x in ("train","validation","test")]:
        raise ValueError("Retrospective split differs from the prior reservation")
    allrows=[[(features[d],int(signed["raw"][d]>0)) for d in fold] for fold in folds]
    control=[[([xs[1]],v) for xs,v in fold] for fold in allrows]
    model=fit["best"](*allrows[:2]); baseline=fit["best"](*control[:2])
    losses=fit["losses"](model,allrows[2]); controls=fit["losses"](baseline,control[2])
    rate=fmean(v for _,v in allrows[0]); base=[(v-rate)**2 for _,v in allrows[2]]
    summary={"combined":fmean(losses),"control":fmean(controls),"trainingBase":fmean(base),"coin":.25,"coefficient":model[0][0]}
    for key,value in summary.items():
        if abs(value-expected[key])>1e-12: raise ValueError("Independent loss/fit differs: "+key)
    stats=intervals([[c-z,b-z,.25-z] for z,c,b in zip(losses,controls,base)])
    for a,b in zip(stats,expected["uncertainty"]):
        if any(abs(x-y)>1e-12 for x,y in zip([a["mean"],a["correctedLower"]]+a["interval95"],
                                               [b["mean"],b["correctedLower"]]+b["interval95"])):
            raise ValueError("Independently resampled paired uncertainty differs")
    passed=summary["coefficient"]>0 and all(s["mean"]>.01 and s["correctedLower"]>0 for s in stats)
    if passed!=expected["passed"] or expected["before"]!=BEFORE:
        raise ValueError("Independent registered conclusion differs")
    return {"method":expected["method"],"paired":n,"train":len(folds[0]),"validation":len(folds[1]),"test":len(folds[2]),
            "modelBrier":summary["combined"],"controlBrier":summary["control"],"baseRateBrier":summary["trainingBase"],
            "coinBrier":.25,"coefficient":summary["coefficient"],"controlInterval95":stats[0]["interval95"],
            "correctedControlLower":stats[0]["correctedLower"],"passed":passed,"sealedSHA256":RESULT}

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=Path)
    print(json.dumps(verify(parser.parse_args().directory)))
