"""Qualify original listing prints in lawfully held September 21 samples, offline."""
import argparse
import csv
import gzip
import hashlib
import io
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from listing_auction_packets import (NS, capture_data, cta_messages, cta_timestamp,
                                    datagrams, local_file, require, uint, utp_messages)

SESSION = "2026-09-21"
SYMBOL_LINES = {"DIA": 1, "IWM": 5, "SPY": 8, "QQQ": 5, "TLT": 6}
CTA_FUNDS = ("DIA", "IWM", "SPY")
UTP_FUNDS = ("QQQ", "TLT")
PATHS = {"cta-a": CTA_FUNDS, "cta-b": CTA_FUNDS, "utp-a": UTP_FUNDS}
CROSS_URL = "https://www.nasdaqtrader.com/files/crosses/CrossStats20260921.txt"
MARKERS = "OQ6M9"


def multicast(symbol, path):
    require(path in PATHS and symbol in PATHS[path], "Fund is not listed on the selected tape or path")
    line = SYMBOL_LINES[symbol]
    if path == "utp-a":
        return (233, 46, 176, 7 + line), 55639 + line
    first = 31 if path == "cta-a" else 159
    return (224, 0, 202, first + line), 45000 + line


def bell_nanos(session, edge):
    require(session == SESSION and edge in ("open", "close"), "Only the reviewed ordinary session is supported")
    hour = 13 if edge == "open" else 20
    minute = 30 if edge == "open" else 0
    return int(datetime(2026, 9, 21, hour, minute, tzinfo=timezone.utc).timestamp()) * NS


@dataclass(frozen=True)
class Print:
    symbol: str
    venue: str
    code: str
    identity: tuple
    microdollars: int
    microshares: int
    participant: int
    sip: int
    digest: str


def condition(flags):
    codes = [c for c in flags if c in MARKERS]
    if not codes:
        return None
    require(len(codes) == 1, "Conflicting auction sale conditions")
    return codes[0]


def cta_print(msg, sip):
    kind = msg[2:4]
    if msg[4:5] != b"P" or kind not in (b"TR", b"TL", b"TH", b"TT", b"TE", b"TO", b"TX", b"TC"):
        return None
    body = msg[26:]
    short = kind in (b"TH", b"TT")
    symbol = body[:5 if short else 11].decode("ascii").strip()
    if symbol not in CTA_FUNDS:
        return None
    if kind in (b"TE", b"TO"):
        offset = 36 if kind == b"TE" else 45
        require(len(body) >= offset + 8, "Truncated fractional CTA adjustment")
        identity = (uint(body[offset:offset + 8]),)
        return Print(symbol, "P", "void", identity, 0, 0, 0, sip, "")
    require(kind not in (b"TX", b"TC"), "Unreviewed legacy CTA correction for sample fund")
    sizes = {b"TR": 50, b"TL": 46, b"TH": 16, b"TT": 14}
    require(len(body) == sizes[kind], "Unexpected CTA trade body length")
    listing_at = {b"TR": 45, b"TL": 41, b"TH": 13, b"TT": 11}[kind]
    if body[listing_at:listing_at + 1] != b"P":
        return None
    flags = body[5:6] if short else body[12:16]
    code = condition(flags.decode("ascii"))
    if not code:
        return None
    require(kind == b"TR" and flags.strip() == code.encode("ascii"), "Unreviewed CTA sample sale condition")
    return Print(symbol, "P", code, (uint(msg[18:26]),), int.from_bytes(body[16:24], "big", signed=True),
                 int.from_bytes(body[24:32], "big", signed=True),
                 cta_timestamp(msg[5:13]), sip, hashlib.sha256(msg).hexdigest())


def utp_print(msg, sip):
    kind = msg[:3]
    if msg[3:4] != b"Q" or kind not in (b"1TM", b"1TN", b"1TO", b"1TP"):
        return None
    short = kind == b"1TM"
    symbol = msg[37:42 if short else 48].decode("ascii").strip()
    if symbol not in UTP_FUNDS:
        return None
    if kind in (b"1TO", b"1TP"):
        at = 49 if kind == b"1TO" else 48
        require(len(msg) >= at + 8, "Truncated Nasdaq adjustment")
        return Print(symbol, "Q", "void", (msg[4], uint(msg[at:at + 8])), 0, 0, 0, sip, "")
    require(len(msg) == (67 if short else 81), "Unexpected UTDF trade body length")
    flags = msg[60:64] if short else msg[72:76]
    code = condition(flags.decode("ascii"))
    if not code:
        return None
    reviewed = (b"@O X", b"@6 X", b"@  Q", b"@  M")
    require(code == "9" or flags in reviewed, "Unreviewed Nasdaq sample sale condition")
    price = uint(msg[50:52]) * 10000 if short else int.from_bytes(msg[56:64], "big", signed=True)
    shares = int.from_bytes(msg[52:60] if short else msg[64:72], "big", signed=True)
    trade_id = uint(msg[42:50] if short else msg[48:56])
    return Print(symbol, "Q", code, (msg[4], trade_id), price, shares, uint(msg[13:21]), sip,
                 hashlib.sha256(msg).hexdigest())


def select_pair(rows, edge, bell, expected_shares=None):
    """A second possible execution, a correction or conflicting official print cannot qualify."""
    require(edge in ("open", "close"), "Unexpected auction edge")
    execution, official = ("O", "Q") if edge == "open" else ("6", "M")
    executions = [r for r in rows if r.code == execution]
    marks = [r for r in rows if r.code == official]
    require(len(executions) == len(marks) == 1, "Missing or ambiguous execution or official mark")
    e, q = executions[0], marks[0]
    require(e.symbol == q.symbol and e.venue == q.venue, "Source differs between execution and mark")
    require(e.identity != q.identity and e.digest != q.digest, "Official mark is not a separate message")
    require(e.microdollars == q.microdollars > 0 and e.microshares == q.microshares > 0, "Price or shares disagree")
    require(all(x.identity[-1] > 0 and bell <= x.participant <= x.sip < bell + 2 * NS for x in (e, q)), "Wrong auction clock or identity")
    require(0 <= q.participant - e.participant < NS and e.sip <= q.sip, "Inconsistent official-price chronology")
    require(not any(r.code == "9" or (r.code == "void" and r.identity in (e.identity, q.identity)) for r in rows), "Corrected within the packet window")
    if expected_shares is not None:
        require(expected_shares > 0 and e.microshares == expected_shares * 1_000_000, "Nasdaq dated cross shares differ")
    return e, q


def observations(raw, session, path, edge, allow_partial=False):
    bell = bell_nanos(session, edge)
    require(path in PATHS, "Unsupported production path")
    funds = PATHS[path]
    result = {s: [] for s in funds}
    channels = {multicast(s, path): s for s in funds}
    packet_reader, decode = (utp_messages, utp_print) if path == "utp-a" else (cta_messages, cta_print)
    for received, ip, port, payload in datagrams(raw, allow_partial):
        source = channels.get((ip, port))
        if not source:
            continue
        require(bell <= received < bell + 600 * NS, "Capture is from a different time window")
        for sip, msg in packet_reader(payload):
            row = decode(msg, sip)
            if row is None:
                continue
            require(row.symbol == source, "Listed fund appeared on the wrong symbol line")
            require(sip <= received and (row.code == "void" or row.participant <= sip), "Wire clock precedes source message")
            result[source].append(row)
    return result


def cross_shares(root, receipt_name):
    r = json.loads(local_file(root, receipt_name, 32768))
    require(r["source"] == CROSS_URL and r["http"] == 200 and r["complete"] is True, "Expected original dated Nasdaq CrossStats")
    data = local_file(root, r["object"], 2 * 1024**2)
    if data.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as handle:
            data = handle.read(4 * 1024**2 + 1)
    require(len(data) <= 4 * 1024**2 and hashlib.sha256(data).hexdigest() == r["sha256"], "Nasdaq CrossStats digest differs")
    rows = csv.reader(io.StringIO(data.decode("ascii")))
    require([v.strip() for v in next(rows)][:6] == ["Date", "Symbol", "ListingMarket", "OpeningCross", "ClosingCross", "IntradayCross"], "Unknown Nasdaq cross columns")
    counts = {}
    for row in rows:
        if len(row) != 7 or row[1].strip() not in UTP_FUNDS:
            continue
        symbol = row[1].strip()
        require(row[0] == "09/21/2026" and symbol not in counts, "Wrong Nasdaq cross date or duplicate")
        counts[symbol] = {"open": int(row[3]), "close": int(row[4])}
    require(set(counts) == set(UTP_FUNDS), "Missing Nasdaq cross-volume control")
    return counts


def replay(manifest_path):
    root = manifest_path.parent
    manifest = json.loads(local_file(root, manifest_path.name, 32768))
    session = manifest["session"]
    bell_nanos(session, "open")
    require(set(manifest["paths"]) == set(PATHS), "Both CTA multicast paths and the Nasdaq source are required")
    counts = cross_shares(root, manifest["nasdaqCrossStats"])
    verified = {}
    for path, symbols in PATHS.items():
        feed, side = path.split("-")
        for edge in ("open", "close"):
            raw, allow_partial = capture_data(root, feed, side, edge, manifest["paths"][path])
            by_symbol = observations(raw, session, path, edge, allow_partial)
            for symbol in symbols:
                controls = counts[symbol][edge] if symbol in counts else None
                pair = select_pair(by_symbol[symbol], edge, bell_nanos(session, edge), controls)
                if (symbol, edge) in verified:
                    require(verified[symbol, edge] == pair, "Redundant CTA carriage disagrees")
                verified[symbol, edge] = pair
    return {"session": session, "funds": len({s for s, _ in verified}), "listingExecutions": len(verified),
            "distinctOfficialMarks": len(verified), "byteIdenticalCtaMessagesAcrossPaths": 4 * len(CTA_FUNDS),
            "nasdaqAuctionShareControls": 2 * len(counts), "productionAdmissions": 0}


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("manifest", type=Path, help="Private local manifest. Only aggregate counts are printed.")
    print(json.dumps(replay(args.parse_args().manifest), sort_keys=True))
