"""Rebuild the TLT study's labels and fits independently from its owner-only native receipts."""
import argparse
import csv
import hashlib
import json
import math
import runpy
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import fmean
from zoneinfo import ZoneInfo

SCRIPTS = Path(__file__).resolve().parent
FIT = runpy.run_path(str(SCRIPTS / "verify-g17-manufacturing.py"))
RESULT = "263fa0a62b17744f36be161f9dfcddca349f3c474cc71882c57c20494863f18b"
SOURCE = "63821a4c810efb89b6eb912b5f32c5d7014e478e3fbe80f260c760dd5f97d449"
ORIGINAL_LOCK = "988a51cd48f470275c25765bfb2345e8a771ee49d0b6e41cf15704c36b7d4f37"
TRANSPORT_LOCK = "348ada90635145e9ae5a6c1f21ad5cb95c865546aced9e465d44a656facf8b81"
NY = ZoneInfo("America/New_York")


def check(condition, message):
    if not condition:
        raise ValueError(message)


def private_bytes(path, expected=None):
    check(path.is_file() and not path.is_symlink() and not path.stat().st_mode & 0o077,
          "Expected owner-only original: " + path.name)
    body = path.read_bytes()
    if expected:
        check(hashlib.sha256(body).hexdigest() == expected, "Original checksum differs: " + path.name)
    return body


def checked_native_prices(root, external, source, selected):
    key = source["key"]
    check(Path(key).name == key, "Invalid source file identity")
    if source["scope"] == "private-boc-decisions-tlt/prices":
        native = json.loads(private_bytes(root / "prices" / key))
        proof = native["proof"]
        body = native["csv"].encode()
    else:
        folders = {"external:private-tlt-fomc-dissent/price-originals": external / "private-tlt-fomc-dissent" / "price-originals",
                   "external:private-bls-payroll-news/prices": external / "private-bls-payroll-news" / "prices"}
        directory = folders[source["scope"]]
        proof = json.loads(private_bytes(directory / key))
        body = private_bytes(directory / Path(key).with_suffix(".csv"))
    check(proof["ticker"] == "TLT" and proof["basis"] in ("raw", "splits")
          and hashlib.sha256(body).hexdigest() == proof["sourceSHA256"] == source["digest"],
          "Private native receipt or declared price basis changed")
    rows = {}
    for fields in csv.reader(body.decode("utf-8").splitlines()):
        day = datetime.strptime(fields[0], "%m/%d/%Y").date().isoformat()
        check(proof["from"] <= day <= proof["through"] < "2022", "Native date outside source scope")
        if day not in selected:
            continue
        check(day not in rows and len(fields) == 6, "Duplicate quote or wrong field count")
        op, hi, lo, cl = map(float, fields[1:5])
        check(0 < lo <= min(op, cl) <= max(op, cl) <= hi and int(fields[5]) > 0, "Invalid adjusted or raw quote")
        rows[day] = math.log(cl / op)
    return proof["basis"],rows


def uncertainty(differences):
    n = len(differences)
    tail = n % 3
    blocks = [[sum(row[j] for row in differences[k:k+3]) for j in range(3)] for k in range(n-2)]
    parts = [[sum(row[j] for row in differences[k:k+tail]) for j in range(3)] for k in range(n-2)]
    losses = [[], [], []]
    state = 20261124
    for _ in range(100_000):
        totals = [0., 0., 0.]
        for position in range(0, n, 3):
            state = (state * 1664525 + 1013904223) % 2**32
            chosen = parts if position + 3 > n else blocks
            sampled = chosen[state * (n-2) // 2**32]
            for j, loss in enumerate(sampled):
                totals[j] += loss
        for j in range(3):
            losses[j].append(totals[j] / n)
    bounds = []
    corrected = math.floor(100_000 * .05 / (37 * 3)) - 1
    for values in losses:
        values.sort()
        bounds.append([values[2499], values[97499], values[corrected]])
    return bounds


def verify(root, external):
    result = json.loads(private_bytes(root / "result.json", RESULT))
    cohort = json.loads(private_bytes(root / "source-cohort.json", SOURCE))
    original = json.loads(private_bytes(root / "scoring-reservation.json", ORIGINAL_LOCK))
    delivery = json.loads(private_bytes(root / "scoring-archive-supplement.json", TRANSPORT_LOCK))
    check(original["data"]["cohort"] == delivery["data"]["cohort"] == SOURCE, "Source roster changed between reservations")
    check(original["recordedAt"] <= delivery["recordedAt"], "Transport qualification predates the original registration")
    check(original["data"]["learning"] == delivery["data"]["learning"], "Fitter changed")
    check(result["before"] == "2026-11-03T06:28:30.460Z", "Launch boundary changed")
    policy = json.loads((SCRIPTS / "boc-decisions-tlt-policy.json").read_bytes())
    check(policy["firstIssue"] == result["before"], "Historical clock does not match")
    eligible = cohort["eligible"]
    selected = set(row["day"] for row in eligible)
    excluded = set(row["target"] for row in cohort["excluded"])
    check(len(selected) == len(eligible) == 139 and len(excluded) == 13 and not selected & excluded,
          "Duplicated or previously used economic dates")
    check(len(cohort["strictEligible"]) == 88 and set(cohort["strictEligible"]) <= selected,
          "Original Valet-only observation subset changed")
    books = {"raw": {}, "splits": {}}
    for source in result["inputHashes"]:
        basis, bars = checked_native_prices(root, external, source, selected)
        prior = books[basis]
        check(all(day not in prior or abs(prior[day]-v)<1e-14 for day,v in bars.items()),
              "Two native deliveries disagree on a selected price")
        prior.update(bars)
    labelled = []
    for row in eligible:
        day = row["day"]
        issue = datetime.fromisoformat(row["issue"]).astimezone(NY)
        before = datetime.fromisoformat(row["availableBy"]).astimezone(NY)
        op = datetime.fromisoformat(row["open"]).astimezone(NY)
        cl = datetime.fromisoformat(row["close"]).astimezone(NY)
        check(before.date() == date.fromisoformat(row["sourceDay"]) + timedelta(days=1)
              and before.hour == 0 and before <= issue < op and issue.strftime("%H:%M") == "07:48"
              and op.strftime("%H:%M") == "09:30" and cl.strftime("%H:%M") == "16:00"
              and op.date().isoformat() == cl.date().isoformat() == day, "Point-in-time chronology changed")
        raw, splits = books["raw"].get(day), books["splits"].get(day)
        check(raw is not None and splits is not None and abs(raw - splits) <= .0001
              and (raw > 0) == (splits > 0) and (raw < 0) == (splits < 0), "A retained target lacks dual-basis agreement")
        labelled.append((row["features"], int(raw > 0)))
    n = len(labelled)
    a, b = n*6//10, n*8//10
    train, validation, test = labelled[:a], labelled[a:b], labelled[b:]
    check(eligible[a]["day"] == cohort["validationFrom"] and eligible[b]["day"] == cohort["testFrom"], "Fold boundaries changed")
    controls = lambda period: [(x[:2], y) for x,y in period]
    model = FIT["best"](train, validation)
    control = FIT["best"](controls(train), controls(validation))
    losses = FIT["losses"](model, test)
    baseline = FIT["losses"](control, controls(test))
    base = fmean(y for _,y in train)
    base_losses = [(y-base)**2 for _,y in test]
    differences = [(c-m, t-m, .25-m) for m,c,t in zip(losses,baseline,base_losses)]
    bands = uncertainty(differences)
    results = dict(model=fmean(losses),control=fmean(baseline),base=fmean(base_losses),
                   coin=.25,easingCoefficient=model[0][-1])
    check(all(math.isclose(value,result[key],abs_tol=1e-12,rel_tol=0) for key,value in results.items()),
          "Independent binary model, controls or baselines differ")
    for band,reference in zip(bands,result["uncertainty"]):
        check(all(math.isclose(x,y,abs_tol=1e-12,rel_tol=0) for x,y in zip(band,reference["twoSided95"]+[reference["adjustedLower"]])),
              "Independent block uncertainty differs")
    passed = results["easingCoefficient"] > 0 and min(results["control"],results["base"],.25)-results["model"] > .01 and all(x[2] > 0 for x in bands)
    check(passed == result["clear"], "Historical gate differs")
    return {"sample":n,"split":[len(train),len(validation),len(test)],"strictDaily":len(cohort["strictEligible"]),
            "scheduled":len(cohort["sourceChecks"]),"priorOverlap":len(excluded),"priceReceipts":len(result["inputHashes"]),
            "changedInEachFold":[sum(x[2]!=0 for x,_ in subset) for subset in (train,validation,test)],
            "marketChangeVsControl95":bands[0][:2],"passed":passed,**results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("private_study", type=Path)
    parser.add_argument("private_controls", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.private_study, args.private_controls), sort_keys=True))
