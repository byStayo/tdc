"""Independently rebuild the DIA labels, chronological fits and moving-block interval from owner-private files."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import fmean

POLICY = "f689c4113b3dd75c31656e05e84976191801eeea9be2e0892060927c7c8603eb"
FEATURES = "120be9635947ed2f4d91ac09245d27f5faabcfbbdeecc8527885155101efaa15"


def sealed(path, digest):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Private frozen input differs: " + path.name)
    return json.loads(raw)


def probability(model, feature):
    weights, bias, means, scales = model
    value = bias + sum(w * (x - m) / s for x, w, m, s in zip(feature, weights, means, scales))
    return 1 / (1 + math.exp(-max(-30, min(30, value))))


def fit(data, ridge):
    cols = list(zip(*(features for features, _ in data)))
    means = [fmean(column) for column in cols]
    scales = [(fmean((x - m) ** 2 for x in column) ** .5) or 1 for m, column in zip(means, cols)]
    standardized = [([(x - m) / s for x, m, s in zip(features, means, scales)], up) for features, up in data]
    weights = [0.] * len(cols)
    bias = 0.
    n = len(data)
    for _ in range(600):
        bias_grad, weight_grads = 0., [0.] * len(cols)
        for features, truth in standardized:
            logit = bias + sum(x * w for x, w in zip(features, weights))
            err = 1 / (1 + math.exp(-max(-30., min(30., logit)))) - truth
            bias_grad += err
            weight_grads = [grad + err * x for grad, x in zip(weight_grads, features)]
        bias -= .08 * bias_grad / n
        weights = [w - .08 * (grad + ridge * w) / n for w, grad in zip(weights, weight_grads)]
    return weights, bias, means, scales


def losses(model, rows):
    return [(probability(model, xs) - up) ** 2 for xs, up in rows]


def best(train, validation):
    return min([fit(train, value) for value in [.01, .1, 1, 10]], key=lambda m: fmean(losses(m, validation)))


def interval(differences):
    state = int(POLICY[:8], 16)
    stats = []
    for _ in range(10000):
        sample = []
        while len(sample) < len(differences):
            state = (1664525 * state + 1013904223) % (2 ** 32)
            start = (state * (len(differences) - 2)) // 2 ** 32
            sample.extend(differences[start:start + 3])
        stats.append(fmean(sample[:len(differences)]))
    stats.sort()
    return [stats[249], stats[9749]]


def verify(directory, research_web):
    registration = sealed(directory / "registration.json", POLICY)
    manifest = sealed(directory / "features-sealed.json", FEATURES)
    if registration["id"] != "original-g17-manufacturing-dia-prelaunch-v1" or registration["before"] != manifest["before"]:
        raise ValueError("Invalid independent G.17 registration")
    expected = json.loads((directory / "g17-dia-result.json").read_bytes())
    bases = {}
    for basis in ("raw", "splits"):
        lookup = {}
        for year in range(2016, 2027):
            scope = "private-ft900" if year < 2022 else "private-technical-momentum"
            [filename] = (research_web / ".consensus" / scope).glob(f"DIA-{year}-*-{basis}.json")
            annual = json.loads(filename.read_bytes())
            if annual["instrument"] != "DIA" or [annual["sha256"], annual["priceDigest"]] != expected["confirmedPriceResponses"][basis][year - 2016]:
                raise ValueError("Independent price receipt differs")
            lookup.update((p["session"], p) for p in annual["sessions"])
        bases[basis] = lookup
    pairs = []
    for event in manifest["eligible"]:
        day = event["target"]
        price, split = bases["raw"].get(day), bases["splits"].get(day)
        if not price or not split:
            continue
        if not (event["releaseAt"] < event["decision"] < price["openAt"] == split["openAt"] == event["openAt"] <
                price["closeAt"] == split["closeAt"] == event["closeAt"] < manifest["before"]):
            raise ValueError("Invalid independent chronology")
        direction = lambda p: (p["close"] > p["open"]) - (p["close"] < p["open"])
        if direction(price) != direction(split):
            continue
        pairs.append((event["decision"], event["closeAt"], [event["control"], event["candidate"]], int(direction(price) > 0)))
    pairs.sort()
    n = len(pairs)
    if n < 120:
        raise ValueError("Insufficient authentic labelled events")
    val_start, test_start = pairs[int(.6 * n)][0], pairs[int(.8 * n)][0]
    split = [[(features, up) for issued, close, features, up in pairs if lo <= issued < hi and close < hi]
             for lo, hi in [("", val_start), (val_start, test_start), (test_start, manifest["before"])]]
    control = [[([event[0]], up) for event, up in fold] for fold in split]
    candidate_model, control_model = best(*split[:2]), best(*control[:2])
    truth = [up for _, up in split[2]]
    rate = fmean(up for _, up in split[0])
    candidate, reference = losses(candidate_model, split[2]), losses(control_model, control[2])
    values = {"candidate": fmean(candidate), "control": fmean(reference), "trainingRate": fmean((up - rate) ** 2 for up in truth),
              "coin": fmean((up - .5) ** 2 for up in truth), "manufacturingCoefficient": candidate_model[0][1]}
    summary = expected["summary"]
    for name, metric in values.items():
        if not math.isclose(summary[name], metric, rel_tol=0, abs_tol=1e-12):
            raise ValueError("Independent metric disagrees: " + name)
    calculated_interval = interval([r - c for c, r in zip(candidate, reference)])
    gate = values["manufacturingCoefficient"] > 0 and min(values["control"], values["trainingRate"], values["coin"]) - values["candidate"] > .01
    if (gate != summary["clearsRegisteredScreen"] or summary["paired"] != n or
            [len(fold) for fold in split] != [summary["split"][k] for k in ["train", "validation", "test"]] or
            any(abs(a - b) > 1e-12 for a, b in zip(calculated_interval, summary["difference95"]))):
        raise ValueError("Independent registered conclusion differs")
    return dict(paired=n, split=[len(fold) for fold in split], **values, difference95=calculated_interval, clearsRegisteredScreen=gate)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("research_web", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.directory, args.research_web)))
