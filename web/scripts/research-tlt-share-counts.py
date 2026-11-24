"""Privately compare fund-level share changes and ETFIQ flow signs on two distinct issuer clocks."""
import argparse
import base64
from contextlib import contextmanager
import http.cookiejar
from html.parser import HTMLParser
import importlib.util
import json
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
import re
import signal
import subprocess
import sys
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import build_opener, HTTPRedirectHandler, HTTPCookieProcessor, Request

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('flow_comparison', HERE.with_name('reconcile-sec-etfiq-flows.py'))
flows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flows)
sec = flows.sec
PRIVATE = HERE.parents[1] / '.consensus/private-tlt-share-counts/v1'
METHOD = 'tlt-issuer-fund-share-direction-two-published-clocks-v1'
DIRECTORY = 'https://www.ishares.com/us/library/financial-legal-tax'
TERMS = 'https://www.ishares.com/us/literature/holdings/fdf-terms-of-use.pdf'
TERMS_SHA = 'a8f1246c2b1267233921d12bc67895f0507b5828a029349ced9d5adfbf383e60'
PORTAL = 'https://filetransfer.blackrock.com/'
KINDS = ('DELIVERABLE', 'PRICING')
IDENTITY = {'Name': 'iShares 20+ Year Treasury Bond ETF', 'marketTicker': 'TLT', 'ISIN': 'US4642874329'}
COUNT_FIELDS = {'sharesPerUnit': 'sharesPerUnit', 'Units Outstanding': 'unitsOutstanding', 'Shares Outstanding': 'sharesOutstanding'}
DATE_FIELDS = {'Nav Date': 'navDate', 'Trade Date': 'tradeDate', 'Settlement Date': 'settlementDate'}
HEADERS = {*IDENTITY, *COUNT_FIELDS, *DATE_FIELDS, 'Basket Type', 'Publication Time'}
FILENAME = re.compile(r'TLT_(DELIVERABLE|PRICING)_(\d{8})\.pdf')


class Pending(Exception):
    pass


@contextmanager
def budget(seconds):
    def expired(*unused):
        raise TimeoutError('Private share-count collection reached its time budget')

    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('Unexpected redirection from the issuer')


class AdvertisedAccount(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.words = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.active = dict(attrs).get('href', '').rstrip('/') == PORTAL.rstrip('/')

    def handle_endtag(self, tag):
        if tag == 'a':
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.words.append(data)


def get(opener, request, limit):
    with opener.open(request, timeout=15) as response:
        raw = response.read(limit + 1)
        if response.status != 200 or not 0 < len(raw) <= limit:
            raise ValueError('Unexpected or oversized issuer response')
        return raw


def connect():
    opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect())
    if flows.sha(get(opener, TERMS, 500_000)) != TERMS_SHA:
        raise ValueError('The reviewed nonpricing FTP terms have changed')
    page = AdvertisedAccount()
    page.feed(get(opener, DIRECTORY, 1_000_000).decode())
    account = re.findall(r'User ID:\s*(\S+)\s+Password:\s*(\S+)', ' '.join(page.words))
    if len(account) != 1:
        raise ValueError('The issuer has not advertised the reviewed public account')
    authorization = base64.b64encode(':'.join(account[0]).encode()).decode()
    get(opener, Request(PORTAL, headers={'Authorization': 'Basic ' + authorization}), 1024)
    return opener


def pdf_bytes(opener, filename):
    if not FILENAME.fullmatch(filename):
        raise ValueError('Unreviewed issuer filename')
    url = PORTAL + 'baskets/' + filename
    try:
        raw = get(opener, url, 100_000)
    except HTTPError as err:
        if err.code in (404, 410):
            raise Pending('Dated issuer basket unavailable: ' + filename) from None
        raise
    if not raw.startswith(b'%PDF-'):
        if len(raw) > 5_000:
            raise ValueError('Unexpected issuer download page')
        form = raw.decode()
        action = re.search(r'''form\.setAttribute\(['"]action['"],\s*['"]([^'"]*)['"]\)''', form)
        verb = re.search(r'''form\.setAttribute\(['"]method['"],\s*['"]POST['"]\)''', form)
        fields = re.findall(r'''hiddenField\.setAttribute\(['"]name['"],\s*['"]([^'"]+)['"]\);\s*hiddenField\.setAttribute\(['"]value['"],\s*['"]([^'"]+)['"]\)''', form)
        if ('New Token Landing Page' not in form or not verb or not action
                or urljoin(url, action[1].replace(r'\/', '/')) != url
                or len(fields) != 2 or fields[0][0] != 'csrfToken'):
            raise ValueError('Unrecognized issuer download navigation')
        request = Request(url, data=urlencode(fields).encode(), headers={'Referer': url, 'Origin': PORTAL.rstrip('/')})
        try:
            raw = get(opener, request, 100_000)
        except HTTPError as err:
            if err.code in (404, 410):
                raise Pending('Dated issuer basket unavailable: ' + filename) from None
            raise
    if not raw.startswith(b'%PDF-') or b'%%EOF' not in raw[-1024:]:
        raise ValueError('The issuer has not delivered a complete dated PDF')
    return raw


def header(text, filename):
    """Project only fund identity, clocks and nonpricing counts. Discard all pricing and holdings."""
    match = FILENAME.fullmatch(filename)
    if not match:
        raise ValueError('Invalid native filename')
    fields = {}
    for line in text.splitlines():
        cells = re.split(r'\s{3,}', line.strip())
        if len(cells) == 2 and cells[0] in HEADERS:
            if cells[0] in fields:
                raise ValueError('Duplicate fund-level header')
            fields[cells[0]] = cells[1]
    if fields.keys() != HEADERS or any(fields[key] != value for key, value in IDENTITY.items()):
        raise ValueError('The exact TLT fund or nonpricing schema did not match')
    if match[1] not in fields['Basket Type'].upper():
        raise ValueError('The source basket type differs from its native filename')
    result = {'original': filename, 'publicationTimeAsPrinted': fields['Publication Time']}
    sec.timestamp(result['publicationTimeAsPrinted'])
    for label, target in DATE_FIELDS.items():
        dates = re.findall(r'\b\d{4}-\d{2}-\d{2}\b', fields[label])
        if len(dates) != 1:
            raise ValueError('Missing authoritative calendar date')
        result[target] = sec.iso_day(dates[0]).isoformat()
    if result['navDate'].replace('-', '') != match[2]:
        raise ValueError('The source date differs from its native filename')
    for label, target in COUNT_FIELDS.items():
        value = fields[label].replace(',', '')
        if not re.fullmatch(r'\d+(?:\.0+)?', value) or Decimal(value) <= 0:
            raise ValueError('Invalid fund share or unit count')
        result[target] = int(Decimal(value))
    return result


def expected(first, last):
    start, end = sec.iso_day(first), sec.iso_day(last)
    now = datetime.now(sec.NEW_YORK)
    if (not 1 <= (end - start).days <= 20 or end > now.date()
            or (end == now.date() and last > latest_window(now)[1])):
        raise ValueError('Supply a completed range of 2–11 exchange sessions')
    calendar = flows.calendar_for({'TLT': {'periodStart': first, 'periodEnd': last}})['days']
    days = [day for day in calendar if first <= day <= last]
    if not 2 <= len(days) <= 11 or days[0] != first or days[-1] != last:
        raise ValueError('Both boundaries must be exchange days within an 11-session range')
    return days, dict(zip(calendar, calendar[1:]))


def sign(amount):
    return (amount > 0) - (amount < 0)


def write_once(path, payload):
    sec.private_dir(path.parent)
    if path.exists():
        if read_seal(path) != payload:
            raise ValueError('Different content for an existing private receipt')
        return
    with NamedTemporaryFile(dir=path.parent, prefix='.partial-') as tmp:
        tmp.write(flows.packed({'payload': payload, 'sha256': flows.sha(flows.packed(payload))}))
        tmp.flush()
        os.fsync(tmp.fileno())
        os.link(tmp.name, path)


def read_seal(path):
    body = flows.decode(sec.protected(path, 40_000))
    if set(body) != {'payload', 'sha256'} or flows.sha(flows.packed(body['payload'])) != body['sha256']:
        raise ValueError('Invalid private cache seal')
    return body['payload']


def compare(evidence):
    if (set(evidence) != {'method', 'termsSha256', 'first', 'last', 'observedAt', 'originals', 'history'}
            or evidence['method'] != METHOD or evidence['termsSha256'] != TERMS_SHA):
        raise ValueError('Unrecognized private share-count study')
    seen = sec.timestamp(evidence['observedAt'])
    if seen > datetime.now(timezone.utc):
        raise ValueError('Future receipt')
    days, following = expected(evidence['first'], evidence['last'])
    history = evidence['history']
    flows.validate_projection(history, 'TLT', evidence['observedAt'])
    rows = {r['original']: r for r in evidence['originals']}
    if len(rows) != len(evidence['originals']) or len(rows) != 2 * len(days):
        raise ValueError('Missing or duplicated issuer basket')
    native = {}
    for day in days:
        pair = [rows['TLT_' + kind + '_' + day.replace('-', '') + '.pdf'] for kind in KINDS]
        for row in pair:
            if (set(row) != {'original', 'publicationTimeAsPrinted', *DATE_FIELDS.values(), *COUNT_FIELDS.values(), 'sha256', 'bytes'}
                    or not flows.FINGERPRINT.fullmatch(row['sha256']) or type(row['bytes']) is not int or not 0 < row['bytes'] <= 100_000
                    or any(type(row[key]) is not int or row[key] <= 0 for key in COUNT_FIELDS.values())
                    or row['navDate'] != day or row['tradeDate'] != following[day] or sec.iso_day(row['settlementDate']) < sec.iso_day(row['tradeDate'])
                    or not day <= sec.timestamp(row['publicationTimeAsPrinted']).astimezone(sec.NEW_YORK).date().isoformat()
                    or sec.timestamp(row['publicationTimeAsPrinted']) > seen):
                raise ValueError('Invalid native share or source clock')
        for key in (*DATE_FIELDS.values(), *COUNT_FIELDS.values()):
            if pair[0][key] != pair[1][key]:
                raise ValueError('Issuer basket variants disagree on original fund counts or dates')
        native[day] = pair[0]
    counts = {}
    for basis in ('navDate', 'tradeDate'):
        compared = matched = 0
        reasons, disagreements = {}, []
        for earlier, later in zip(days, days[1:]):
            order, count = native[earlier][basis], native[later][basis]
            checked = flows.observed_window(history, {order: count})
            if not checked['completeCalendarCoverage'] or checked['splitDays'] or checked['roundTripLegs']:
                issues = set(checked['exclusionsByOrder'].get(order, []))
                if checked['unexpectedCountDates']:
                    issues.add('unexpected-count-date')
                if checked['splitDays']:
                    issues.add('split')
                if checked['roundTripLegs']:
                    issues.add('round-trip')
                reasons[count] = sorted(issues)
                continue
            compared += 1
            agrees = sign(native[later]['sharesOutstanding'] - native[earlier]['sharesOutstanding']) == sign(checked['etfiqQuarterUsd'])
            matched += agrees
            if not agrees:
                disagreements.append(count)
        counts[basis] = {'compared': compared, 'matched': matched, 'different': disagreements, 'missingOrFlagged': reasons}
    return {'sourceDays': len(native), 'providerAsOf': history['asOf'], 'through': days[-1], 'clocks': counts}


def collect(first, last, directory):
    days, following = expected(first, last)
    opener = None
    originals = []
    for day in days:
        path = directory / 'issuer-dates' / (day + '.json')
        if path.exists():
            cached = read_seal(path)
            if (set(cached) != {'termsSha256', 'verifiedAt', 'originals'} or cached['termsSha256'] != TERMS_SHA
                    or sec.timestamp(cached['verifiedAt']) > datetime.now(timezone.utc)
                    or any(row['navDate'] != day for row in cached['originals'])):
                raise ValueError('Unexpected first-captured issuer evidence')
            originals.extend(cached['originals'])
            continue
        if opener is None:
            opener = connect()
        pair = []
        for kind in KINDS:
            filename = 'TLT_' + kind + '_' + day.replace('-', '') + '.pdf'
            raw = pdf_bytes(opener, filename)
            text = subprocess.run(['pdftotext', '-layout', '-', '-'], input=raw, capture_output=True, check=True, timeout=8).stdout.decode()
            pair.append({**header(text, filename), 'sha256': flows.sha(raw), 'bytes': len(raw)})
        if any(pair[0][k] != pair[1][k] for k in (*DATE_FIELDS.values(), *COUNT_FIELDS.values())):
            raise ValueError('Conflicting issuer share-count headers')
        now = datetime.now(timezone.utc)
        if pair[0]['tradeDate'] != following[day] or pair[0]['settlementDate'] < pair[0]['tradeDate']:
            raise ValueError('Issuer trading or settlement clocks differ from the expected sessions')
        for row in pair:
            issued = sec.timestamp(row['publicationTimeAsPrinted'])
            if issued > now or issued.astimezone(sec.NEW_YORK).date().isoformat() < day:
                raise ValueError('Invalid source publication time')
        write_once(path, {'termsSha256': TERMS_SHA, 'verifiedAt': now.isoformat(), 'originals': pair})
        originals.extend(pair)
    history = flows.project(flows.fetch('TLT'), 'TLT', {day: following[day] for day in days})
    evidence = {'method': METHOD, 'termsSha256': TERMS_SHA, 'first': first, 'last': last,
                'observedAt': datetime.now(timezone.utc).isoformat(), 'originals': originals, 'history': history}
    return evidence


def latest_window(now):
    day = now.astimezone(sec.NEW_YORK).date()
    program = """
import { exchangeSessions, exchangeSession } from './lib/consensus/exchange-calendar.ts';
const [first, last, clock] = process.argv.slice(1);
const closed = exchangeSessions(first, last).filter(day => Date.parse(exchangeSession(day).closeAt) <= Date.parse(clock));
console.log(JSON.stringify(closed.slice(-4)));
"""
    raw = subprocess.check_output(
        ['node', '--experimental-strip-types', '--input-type=module', '-e', program,
         (day - timedelta(days=13)).isoformat(), day.isoformat(), now.isoformat()], cwd=flows.WEB, timeout=8
    )
    dates = json.loads(raw)
    if len(dates) != 4:
        raise ValueError('Four completed reviewed exchange sessions are required')
    return dates[0], dates[-1]


def replay(identity):
    if not flows.FINGERPRINT.fullmatch(identity):
        raise ValueError('Expected a private receipt SHA-256')
    sealed = flows.decode(sec.protected(PRIVATE / (identity + '.json'), 1_000_000))
    evidence = sealed['evidence']
    body = {'evidence': evidence, 'firstComparedAt': sealed['firstComparedAt']}
    if (set(sealed) != {*body, 'receiptSha256'} or sealed['firstComparedAt'] != evidence['observedAt']
            or flows.sha(flows.packed(body)) != sealed['receiptSha256'] or flows.sha(flows.packed(evidence)) != identity):
        raise ValueError('The private study receipt changed')
    return evidence, compare(evidence)


def main():
    os.umask(0o077)
    cli = argparse.ArgumentParser(description=__doc__)
    mode = cli.add_mutually_exclusive_group(required=True)
    mode.add_argument('--collect', nargs=2, metavar=('FIRST', 'LAST'))
    mode.add_argument('--scheduled', action='store_true', help='Check the four most recent completed exchange sessions once per New York day and target window.')
    mode.add_argument('--replay', metavar='RECEIPT_SHA256')
    args = cli.parse_args()
    cached = False
    if args.collect or args.scheduled:
        sec.private_dir(PRIVATE)
        lock = sec.collector_lock(PRIVATE)
        try:
            with budget(60 if args.scheduled else 120):
                now = datetime.now(timezone.utc)
                first, last = latest_window(now) if args.scheduled else args.collect
                day = now.astimezone(sec.NEW_YORK).date().isoformat()
                checkpoint = PRIVATE / 'scheduled' / f'{day}_{first}_{last}.json'
                if args.scheduled and checkpoint.exists():
                    identity = read_seal(checkpoint)
                    evidence, result = replay(identity)
                    if (evidence['first'], evidence['last']) != (first, last):
                        raise ValueError('The saved scheduled receipt belongs to a different window')
                    cached = True
                else:
                    evidence = collect(first, last, PRIVATE)
                    result = compare(evidence)
                    identity = flows.persist(PRIVATE, evidence, evidence['observedAt'])
                    if args.scheduled:
                        write_once(checkpoint, identity)
        finally:
            os.close(lock)
    else:
        identity = args.replay
        evidence, result = replay(identity)
    clocks = result['clocks'].values()
    status = 'partial' if any(item['missingOrFlagged'] for item in clocks) else 'checked'
    print(json.dumps({'status': status, 'cached': cached, 'privateReceipt': identity, **result}))
    return 0 if any(item['compared'] for item in clocks) else 3


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Pending, BlockingIOError) as err:
        print(json.dumps({'status': 'pending', 'reason': str(err) if isinstance(err, Pending) else 'Private collection already running'}))
        sys.exit(3)
    except (HTTPError, URLError, TimeoutError, subprocess.SubprocessError, ValueError, KeyError, OSError) as err:
        reason = str(err) if isinstance(err, (ValueError, TimeoutError)) else type(err).__name__
        if isinstance(err, HTTPError):
            reason = 'Provider HTTP ' + str(err.code)
        print(json.dumps({'status': 'unavailable', 'reason': reason}))
        sys.exit(1)
