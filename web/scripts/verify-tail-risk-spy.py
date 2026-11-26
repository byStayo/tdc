"""Reproduce the frozen TAIL/IEF/SPY comparison from its eighteen owner-private native originals."""
import argparse
import csv
import hashlib
import json
import math
import runpy
from datetime import date, datetime, time, timezone
from pathlib import Path
from statistics import fmean
from zoneinfo import ZoneInfo

SCRIPTS = Path(__file__).resolve().parent
FIT = runpy.run_path(str(SCRIPTS / 'verify-g17-manufacturing.py'))
NY = ZoneInfo('America/New_York')
SOURCED = '1dfc0e522e5be03989d678ba919c02ab575115b21b34d90966af06b744d3f32c'
RESULT = 'ea372ecadb1c6310df4c30815039eb95a40d222e4306353853e19b46d636320a'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def get(path, expected=None):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('A private regular original is required: ' + path.name)
    data = path.read_bytes()
    if expected is not None and sha(data) != expected:
        raise ValueError('Changed original: ' + path.name)
    return json.loads(data)


def iso(day, hour, minute):
    return datetime.combine(date.fromisoformat(day), time(hour, minute), NY).astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def market_data(root, fund, days, expected, recorded_at):
    records = {}
    for year in sorted({d[:4] for d in days}):
        dates = {day for day in days if day.startswith(year)}
        pairs = {}
        for basis in ('raw', 'splits'):
            name = f'{fund}-{year}-{basis}'
            capture = get(root / (name + '.json'))
            if (capture['sha256'] != expected[name] or capture['sha256'] != sha(capture['text'].encode())
                    or capture['receivedAt'] <= recorded_at):
                raise ValueError('Native price original differs: ' + name)
            accepted = {}
            for fields in csv.reader(capture['text'].splitlines()):
                day = datetime.strptime(fields[0], '%m/%d/%Y').date().isoformat()
                if day not in dates:
                    continue
                if day in accepted or len(fields) != 6:
                    raise ValueError('Duplicate or invalid eligible native record')
                op, hi, lo, cl = [float(f) for f in fields[1:5]]
                if not (0 < lo <= min(op, cl) <= max(op, cl) <= hi and int(fields[5]) > 0):
                    raise ValueError('Invalid value in eligible native record')
                accepted[day] = cl / op
            pairs[basis] = accepted
        for day, ratio in pairs['raw'].items():
            split = pairs['splits'].get(day)
            if split is not None and (ratio > 1) == (split > 1) and (ratio < 1) == (split < 1) and abs(ratio - split) <= .0001:
                records[day] = math.log(ratio)
    return records


def confidence(differences):
    n = len(differences)
    block = [[sum(row[j] for row in differences[k:k+3]) for j in range(3)] for k in range(n-2)]
    tail = n % 3
    partial = [[sum(row[j] for row in differences[k:k+tail]) for j in range(3)] for k in range(n-2)]
    all_differences = [[], [], []]
    state = 20261124
    for _ in range(100000):
        total = [0., 0., 0.]
        for position in range(0, n, 3):
            state = (state * 1664525 + 1013904223) % (2 ** 32)
            pick = state * (n-2) // (2 ** 32)
            chosen = partial[pick] if position + 3 > n else block[pick]
            for j in range(3):
                total[j] += chosen[j]
        for j in range(3):
            all_differences[j].append(total[j] / n)
    out = []
    for values in all_differences:
        values.sort()
        out.append([values[2499], values[97499], values[math.floor(len(values)*.05/(35*3))-1]])
    return out


def verify(root):
    stored = get(root/'result.json', RESULT)
    reservation = get(root/'reservation.json', SOURCED)
    data = reservation['data']
    if (data['method'] != stored['method'] or data['before'] != '2026-11-03T06:28:30.460Z' or
        sha((SCRIPTS/'tail-risk-spy-policy.json').read_bytes()) != data['policy'] or
        sha((SCRIPTS/'research-tail-risk-spy.ts').read_bytes()) != data['program']):
        raise ValueError('Study identity or registered implementation changed')
    features = {r['prior'] for r in data['rows']}
    targets = {r['day'] for r in data['rows']}
    earlier = {d for dates in data['rosters'].values() for d in dates}
    if earlier & (features | targets) or len(targets) != len(data['rows']):
        raise ValueError('Repeated or previously tested SPY input or target')
    all_values = {fund: market_data(root, fund, features | (targets if fund == 'SPY' else set()),
                                    stored['hashes'], reservation['recordedAt']) for fund in ('SPY', 'IEF', 'TAIL')}
    study_rows = []
    for r in data['rows']:
        day, source = r['day'], r['prior']
        if (not '2018-01-01' <= day < '2020-01-01' or r['issuedAt'] != iso(day, 7, 48) or
            r['labelKnownAt'] != iso(day, 16, 0) or r['labelKnownAt'] >= data['before'] or
            (datetime.fromisoformat(r['issuedAt'].replace('Z', '+00:00')) - datetime.fromisoformat(iso(source,16,0).replace('Z','+00:00'))).total_seconds() < 48 * 3600):
            raise ValueError('Invalid historical clock')
        if all(source in vals for vals in all_values.values()) and day in all_values['SPY']:
            study_rows.append(([all_values[s][source] for s in ('SPY', 'IEF', 'TAIL')], int(all_values['SPY'][day] > 0)))
    n = len(study_rows)
    a, b = math.floor(.6*n), math.floor(.8*n)
    train, validation, test = study_rows[:a], study_rows[a:b], study_rows[b:]
    reduced = lambda v: [(feat[:2], label) for feat,label in v]
    real = FIT['best'](train, validation)
    control = FIT['best'](reduced(train), reduced(validation))
    candidate = FIT['losses'](real,test)
    baseline = FIT['losses'](control,reduced(test))
    rate = fmean(y for _,y in train)
    base = [(y-rate)**2 for _,y in test]
    differences = [(c-m, b-m, .25-m) for c,b,m in zip(baseline,base,candidate)]
    bounds = confidence(differences)
    metrics = dict(model=fmean(candidate), control=fmean(baseline), baseRate=fmean(base), coin=.25, coefficient=real[0][-1])
    expected = stored['summary']
    assert all(math.isclose(expected[k], v, abs_tol=1e-12, rel_tol=0) for k,v in metrics.items())
    assert [len(train),len(validation),len(test)] == [expected[k] for k in ('training','validation','test')]
    for j, interval in enumerate(bounds):
        original = expected['intervals'][j]
        assert all(math.isclose(x,y,abs_tol=1e-12,rel_tol=0) for x,y in zip(interval, original['twoSided95']+[original['correctedLower']]))
    passed = (metrics['coefficient'] < 0 and min(metrics['control'],metrics['baseRate'],.25) - metrics['model'] > .01
              and min(interval[2] for interval in bounds) > 0)
    assert passed == expected['passes']
    return dict(pairs=n, excluded=len(targets)-n, split=[len(train),len(validation),len(test)], independentBrier=metrics['model'],
                matchedBrier=metrics['control'], expectedDirectionMatched=metrics['coefficient']<0, incremental95=bounds[0][:2],passed=passed)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    print(json.dumps(verify(parser.parse_args().directory)))
