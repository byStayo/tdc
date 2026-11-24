"""Recalculate the sealed DIA study in Python using the original owner-private feature and price receipts."""
import argparse
import datetime as dt
import hashlib
import itertools
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo

SOURCE = "a842d6890ccba86bcbf33b5a0125c458c8ed067192cbd4ca45c80e47afb74335"
OUTCOME = "8ec9a92a40c6805f87351a0dc60ff76355b8a6d517e6df1e340e2ef07876c82e"


def sealed(path, digest):
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError("Expected private original research evidence")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Saved source differs from its sealed fingerprint")
    return json.loads(raw)


def fit_and_predict(rows, width):
    train, valid, test = rows[:88], rows[88:117], rows[117:]
    n = len(train)
    means = [sum(row[0][i] for row in train) / n for i in range(width)]
    scales = [math.sqrt(sum((row[0][i] - means[i]) ** 2 for row in train) / n) or 1 for i in range(width)]

    def normalized(data):
        return [(tuple((x[i] - means[i]) / scales[i] for i in range(width)), y) for x, y in data]

    train, valid, test = map(normalized, (train, valid, test))

    def predict(bias, weights, x):
        return 1 / (1 + math.exp(-bias - sum(w * feature for w, feature in zip(weights, x))))

    def errors(bias, weights, data):
        return [(predict(bias, weights, x) - y) ** 2 for x, y in data]

    candidates = []
    for penalty in (.01, .1, 1, 10):
        bias, weights = 0., [0.] * width
        for _ in range(600):
            residuals = [predict(bias, weights, x) - y for x, y in train]
            bias -= .08 * sum(residuals) / n
            gradients = [sum(e * x[i] for e, (x, _) in zip(residuals, train)) for i in range(width)]
            weights = [w - .08 * (g + penalty * w) / n for w, g in zip(weights, gradients)]
        candidates.append((sum(errors(bias, weights, valid)), bias, weights))
    _, bias, weights = min(candidates, key=lambda record: record[0])
    return errors(bias, weights, test), weights[-1]


def uncertainty(differences):
    n = len(differences)
    seed = int("e6248d83", 16)
    bootstrap = []
    for _ in range(10000):
        draw = []
        for _ in range(0, n, 3):
            seed = (1664525 * seed + 1013904223) % 2**32
            k = int(seed / 2**32 * (n - 2))
            draw.extend(differences[k:k + 3])
        bootstrap.append(sum(draw) / n)
    bootstrap.sort()
    groups = [sum(differences[i:i + 3]) for i in range(0, n, 3)]
    values = [sum(s * v for s, v in zip(signs, groups))
              for signs in itertools.product((-1, 1), repeat=len(groups))]
    p = sum(value >= sum(differences) - 1e-12 for value in values) / len(values)
    return {"improvement": sum(differences) / n, "lower": bootstrap[249], "upper": bootstrap[9749],
            "oneSidedP": p, "bonferroni96P": min(1, 96 * p)}


def close_enough(a, b):
    if abs(a - b) > 1e-12:
        raise ValueError("Independent arithmetic disagrees with the exact frozen result")


def replay(study, controls):
    saved = sealed(study / "result.json", OUTCOME)
    selected = sealed(study / "maturity-source.json", SOURCE)
    prices = {"raw": {}, "splits": {}}
    for entry in saved["sourceHashes"]:
        name = entry["file"]
        year = int(name.split("-")[1])
        base = controls / ("private-ft900" if year < 2022 else "private-technical-momentum")
        data = sealed(base / name, entry["sha256"])
        if data["instrument"] != "DIA" or entry["native"] != data["sha256"]:
            raise ValueError("Wrong DIA price basis")
        prices[name.rsplit("-", 1)[1][:-5]].update({r["session"]: r for r in data["sessions"]})
    zone = ZoneInfo("America/New_York")
    rows = []
    for feature in selected["rows"]:
        session = feature["session"]
        at = dt.datetime.fromisoformat(feature["issue"].replace("Z", "+00:00")).astimezone(zone)
        known = dt.datetime.fromisoformat(feature["publishedBy"].replace("Z", "+00:00"))
        if known >= at or at.date().isoformat() != session or at.hour != 7 or at.minute != 48:
            raise ValueError("Actual source capture must precede forecast")
        pair = [prices[basis][session] for basis in ("raw", "splits")]
        for bar in pair:
            opened, closed = [dt.datetime.fromisoformat(bar[k].replace("Z", "+00:00")).astimezone(zone) for k in ("openAt", "closeAt")]
            if not (opened.date().isoformat() == session == closed.date().isoformat() and
                    opened.time() == dt.time(9, 30) and closed.time() == dt.time(16) and opened > at and
                    session <= "2026-11-02" and min(bar["open"], bar["close"]) > 0):
                raise ValueError("Invalid ordinary DIA price interval")
        returns = [bar["close"] - bar["open"] for bar in pair]
        if ((returns[0] > 0) != (returns[1] > 0)) or ((returns[0] < 0) != (returns[1] < 0)):
            raise ValueError("The two price bases disagree")
        rows.append((feature["features"], int(returns[0] > 0)))
    if len(rows) != 147:
        raise ValueError("Incomplete private cohort")
    full, coefficient = fit_and_predict(rows, 2)
    control, _ = fit_and_predict(rows, 1)
    rate = sum(y for _, y in rows[:88]) / 88
    base = [(rate - y) ** 2 for _, y in rows[117:]]
    metrics = {"combinedBrier": sum(full) / len(full), "controlBrier": sum(control) / len(control),
               "trainingBaseBrier": sum(base) / len(base), "coinBrier": .25, "coefficient": coefficient}
    for key, number in metrics.items():
        close_enough(number, saved[key])
    for title, losses in (("usStressOnly", control), ("trainingBase", base), ("coin", [.25] * len(base))):
        difference = [a - b for a, b in zip(losses, full)]
        calculated = uncertainty(difference)
        for key, number in calculated.items():
            close_enough(number, saved["intervals"][title][key])
    return {"rows": len(rows), "sampleSplit": [88, 29, 30], **metrics,
            "confirmedThreeUncertaintyIntervalsAndAdjustedTests": True, "receiptSHA256": OUTCOME}


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("study", type=Path)
    cli.add_argument("controls", type=Path)
    args = cli.parse_args()
    print(json.dumps(replay(args.study, args.controls), sort_keys=True))
