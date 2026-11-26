"""Native packets and quoted amounts in these fixtures are entirely synthetic."""
import csv
import hashlib
import io
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from listing_auction_packets import NS, cta_messages, datagrams, from_zip, utp_messages
from qualify_listing_auctions import (CROSS_URL, PATHS, SESSION, bell_nanos, cta_print,
                                     multicast, observations, replay, select_pair, utp_print)

SHARES = 17
MICRODOLLARS = 5_125_000
PCAP_HEADER = struct.pack("<IHHIIII", 0xA1B23C4D, 2, 4, 0, 0, 262144, 1)


def number(n, size):
    return n.to_bytes(size, "big")


def cta_clock(nanos):
    return struct.pack(">II", *divmod(nanos, NS))


def cta_trade(symbol, code, key, clock):
    msg = bytearray(76)
    msg[:5] = number(len(msg), 2) + b"TRP"
    msg[5:13] = cta_clock(clock)
    msg[18:26] = number(key, 8)
    msg[26:37] = symbol.encode().ljust(11)
    msg[38:42] = (" " + code + "  " if code in "O6" else "   " + code).encode()
    msg[42:50] = number(MICRODOLLARS, 8)
    msg[50:58] = number(SHARES * 1_000_000, 8)
    msg[71] = ord("P")
    return bytes(msg)


def cta_block(clock, messages):
    block = bytearray(20)
    block[0] = 2
    block[3:5] = b"TO"
    block[9] = len(messages)
    block[10:18] = cta_clock(clock)
    block += b"".join(messages)
    if len(block) % 2:
        block += b"\x00"
    block[1:3] = number(len(block), 2)
    block[18:20] = number(sum(block) % 65536, 2)
    return bytes(block)


def utp_trade(symbol, code, key, clock, short=False):
    msg = bytearray(67 if short else 81)
    msg[:5] = (b"1TM" if short else b"1TN") + b"Q "
    msg[5:13] = number(clock + 100, 8)
    msg[13:21] = number(clock, 8)
    msg[37:42 if short else 48] = symbol.encode().ljust(5 if short else 11)
    flags = (f"@{code} X" if code in "O6" else f"@  {code}").encode()
    if short:
        msg[42:50], msg[50:52] = number(key, 8), number(513, 2)
        msg[52:60], msg[60:64] = number(SHARES * 1_000_000, 8), flags
    else:
        msg[48:56], msg[56:64] = number(key, 8), number(MICRODOLLARS, 8)
        msg[64:72], msg[72:76] = number(SHARES * 1_000_000, 8), flags
    return bytes(msg)


def utp_block(messages):
    return b"123456789T" + bytes(8) + number(len(messages), 2) + b"".join(number(len(m), 2) + m for m in messages)


def frame(clock, destination, port, payload):
    udp = struct.pack(">HHHH", 12000, port, len(payload) + 8, 0) + payload
    ip = bytearray(20)
    ip[0], ip[9] = 0x45, 17
    ip[2:4], ip[16:20] = number(len(udp) + 20, 2), bytes(destination)
    packet = bytes(12) + b"\x08\x00" + ip + udp
    return struct.pack("<IIII", *divmod(clock, NS), len(packet), len(packet)) + packet


def pcap(path, edge, wrong_channel=False):
    raw = bytearray(PCAP_HEADER)
    bell = bell_nanos(SESSION, edge)
    codes = "OQ" if edge == "open" else "6M"
    for symbol in PATHS[path]:
        if path == "utp-a":
            block = utp_block([utp_trade(symbol, c, i, bell + i) for i, c in enumerate(codes, 1)])
        else:
            trades = [cta_trade(symbol, c, i, bell + i) for i, c in enumerate(codes, 1)]
            block = cta_block(bell + 100, trades)
        ip, port = multicast("IWM" if wrong_channel else symbol, path)
        raw.extend(frame(bell + 200, ip, port, block))
    return bytes(raw)


class PacketCase(unittest.TestCase):
    def test_only_reviewed_date_and_symbol_lines(self):
        self.assertEqual(multicast("IWM", "cta-b"), ((224, 0, 202, 164), 45005))
        self.assertEqual(multicast("QQQ", "utp-a"), ((233, 46, 176, 12), 55644))
        for inputs in (("TLT", "cta-a"), ("SPY", "utp-a"), ("DIA", "cta-c")):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                multicast(*inputs)
        for other in ("2026-09-18", "2026-11-23", "2026-11-27"):
            with self.subTest(other=other), self.assertRaises(ValueError):
                bell_nanos(other, "open")

    def test_wire_channel_date_and_capture_clock(self):
        for path in PATHS:
            data = pcap(path, "open")
            rows = observations(data, SESSION, path, "open")
            for symbol, r in rows.items():
                e, q = select_pair(r, "open", bell_nanos(SESSION, "open"))
                self.assertEqual((e.symbol, q.symbol), (symbol, symbol))
            with self.assertRaisesRegex(ValueError, "different time window"):
                observations(data, SESSION, path, "close")
        with self.assertRaisesRegex(ValueError, "wrong symbol line"):
            observations(pcap("cta-a", "open", wrong_channel=True), SESSION, "cta-a", "open")

    def test_only_an_intentionally_partial_capture_can_end_inside_a_record(self):
        raw = pcap("cta-a", "open")
        for damaged in (raw[:-1], raw + bytes(7)):
            with self.subTest(size=len(damaged)), self.assertRaisesRegex(ValueError, "Truncated"):
                list(datagrams(damaged))
            self.assertGreater(len(list(datagrams(damaged, allow_partial=True))), 0)

    def test_negative_native_price_is_invalid(self):
        bell = bell_nanos(SESSION, "open")
        rows = []
        for i, code in enumerate("OQ", 1):
            data = bytearray(cta_trade("SPY", code, i, bell + i))
            data[42:50] = (-1).to_bytes(8, "big", signed=True)
            rows.append(cta_print(bytes(data), bell + 100))
        with self.assertRaisesRegex(ValueError, "Price or shares"):
            select_pair(rows, "open", bell)

    def test_marker_alone_disagreement_collision_and_local_correction(self):
        bell = bell_nanos(SESSION, "close")
        for path, symbol in (("cta-a", "DIA"), ("utp-a", "TLT")):
            rows = observations(pcap(path, "close"), SESSION, path, "close")[symbol]
            e, q = select_pair(rows, "close", bell, SHARES)
            for variant in ([q], [e], [e, e, q], [e, replace(q, microshares=q.microshares + 1)],
                            [e, replace(q, microdollars=q.microdollars + 1)], [e, replace(q, identity=e.identity)],
                            [e, replace(q, digest=e.digest)], [e, replace(q, participant=bell - 1)],
                            [e, replace(q, venue="X")], [e, q, replace(e, code="void")], [e, q, replace(q, code="9")]):
                with self.subTest(path=path, variant=[r.code for r in variant]), self.assertRaises(ValueError):
                    select_pair(variant, "close", bell)
            with self.assertRaisesRegex(ValueError, "cross shares differ"):
                select_pair(rows, "close", bell, SHARES + 1)

    def test_adjustments_use_original_participant_identifier(self):
        for typ, at in ((b"TE", 36), (b"TO", 45)):
            msg = bytearray(200)
            msg[2:5], msg[26:37] = typ + b"P", b"DIA".ljust(11)
            msg[26 + at:34 + at] = number(994, 8)
            e = cta_print(bytes(msg), 10)
            self.assertEqual((e.code, e.identity), ("void", (994,)))
        for typ, at in ((b"1TO", 49), (b"1TP", 48)):
            msg = bytearray(200)
            msg[:5], msg[37:48] = typ + b"Q ", b"QQQ".ljust(11)
            msg[at:at + 8] = number(995, 8)
            e = utp_print(bytes(msg), 10)
            self.assertEqual((e.code, e.identity), ("void", (32, 995)))

    def test_cts_checksum_padding_and_mold_lengths(self):
        clock = bell_nanos(SESSION, "open")
        odd = number(27, 2) + b"CT" + bytes(23)
        self.assertEqual(list(cta_messages(cta_block(clock, [odd]))), [(clock, odd)])
        dirty = bytearray(cta_block(clock, [odd]))
        dirty[-1] ^= 1
        with self.assertRaisesRegex(ValueError, "checksum"):
            list(cta_messages(dirty))
        dirty[18:20] = number((sum(dirty[:18]) + sum(dirty[20:])) % 65536, 2)
        with self.assertRaisesRegex(ValueError, "pad"):
            list(cta_messages(dirty))
        msg = utp_trade("QQQ", "O", 9, clock, short=True)
        sip, original = next(utp_messages(utp_block([msg])))
        self.assertEqual(utp_print(original, sip).microdollars, 5_130_000)
        with self.assertRaisesRegex(ValueError, "message length"):
            list(utp_messages(utp_block([msg])[:-1]))

    def test_as_traded_execution_must_come_from_listing_venue(self):
        clock = bell_nanos(SESSION, "open")
        for index in (4, 71):
            msg = bytearray(cta_trade("DIA", "O", 10, clock))
            msg[index] = ord("N")
            self.assertIsNone(cta_print(bytes(msg), clock))
        msg = bytearray(utp_trade("TLT", "O", 10, clock))
        msg[3] = ord("P")
        self.assertIsNone(utp_print(bytes(msg), clock))

    @unittest.skipUnless(shutil.which("zstd"), "Local zstd needed for compressed sample")
    def test_all_five_from_hashed_http_ranges_and_zip_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = make_manifest(root)
            result = replay(manifest)
            self.assertEqual((result["funds"], result["listingExecutions"], result["distinctOfficialMarks"]), (5, 10, 10))
            self.assertEqual((result["byteIdenticalCtaMessagesAcrossPaths"], result["nasdaqAuctionShareControls"]), (12, 4))
            self.assertEqual(result["productionAdmissions"], 0)
            z = root / "cta-a-close.json"
            receipt = json.loads(z.read_text())
            receipt["headers"]["etag"] = '"different"'
            z.write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, "ZIP versions differ"):
                replay(manifest)
            receipt["headers"]["etag"] = '"fixture"'
            receipt["sha256"] = "0" * 64
            z.write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, "digest differs"):
                replay(manifest)

    def test_absent_zip_member_or_wrong_offset(self):
        name = "sample.zst"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(name, b"example")
        data = buf.getvalue()
        end = data.index(b"PK\x01\x02")
        for member, offset in (("other.zst", 0), (name, 1)):
            with self.subTest(member=member), self.assertRaises(ValueError):
                from_zip(data[end:], end, len(data), data[:end], offset, member)


def put_range(root, name, url, data, start, total):
    (root / (name + ".bin")).write_bytes(data)
    stop = start + len(data) - 1
    receipt = {"object": name + ".bin", "source": url, "status": 206, "range": [start, stop],
               "sha256": hashlib.sha256(data).hexdigest(),
               "headers": {"content-range": f"bytes {start}-{stop}/{total}", "content-length": str(len(data)), "etag": '"fixture"'}}
    (root / (name + ".json")).write_text(json.dumps(receipt))
    return name + ".json"


def make_manifest(root):
    paths = {}
    for path in PATHS:
        feed, side = path.split("-")
        prefix = "ny4-" + ("cta-cts" if feed == "cta" else "utp-utdf") + f"-{side}-20260921"
        base = f"https://sample-pcaps-dl.databento.com/{feed}/20260921/{prefix}"
        packed = {}
        for edge in ("open", "close"):
            packed[edge] = subprocess.run(["zstd", "-qc"], input=pcap(path, edge), capture_output=True, check=True).stdout
        name = prefix + "T200000.pcap.zst"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(name, packed["close"])
        zip_bytes = buf.getvalue()
        central_at = zip_bytes.index(b"PK\x01\x02")
        paths[path] = {
            "open": put_range(root, path + "-open", base + "T133000.pcap.zst", packed["open"], 0, len(packed["open"])),
            "close": put_range(root, path + "-close", base + ".zip", zip_bytes[:central_at], 0, len(zip_bytes)),
            "directory": put_range(root, path + "-directory", base + ".zip", zip_bytes[central_at:], central_at, len(zip_bytes))}
    cross = io.StringIO()
    writer = csv.writer(cross)
    writer.writerow(["Date", "Symbol", "ListingMarket", "OpeningCross", "ClosingCross", "IntradayCross", ""])
    for symbol in ("QQQ", "TLT"):
        writer.writerow(["09/21/2026", symbol, "", SHARES, SHARES, 0, ""])
    body = cross.getvalue().encode("ascii")
    (root / "cross.txt").write_bytes(body)
    receipt = {"source": CROSS_URL, "http": 200, "complete": True, "object": "cross.txt", "sha256": hashlib.sha256(body).hexdigest()}
    (root / "cross.json").write_text(json.dumps(receipt))
    manifest = root / "manifest.json"
    manifest.write_text(json.dumps({"session": SESSION, "paths": paths, "nasdaqCrossStats": "cross.json"}))
    return manifest


if __name__ == "__main__":
    unittest.main()
