"""Offline transport for the bounded September 21 CTS and UTDF public sample."""
import hashlib
import json
import re
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

DAY = "20260921"
MAX_RANGE = 5 * 1024**2
MAX_PCAP = 64 * 1024**2
NS = 1_000_000_000


def require(ok, message):
    if not ok:
        raise ValueError(message)


def uint(buf):
    return int.from_bytes(buf, "big")


def local_file(root, name, size):
    require(isinstance(name, str) and Path(name).name == name, "Expected a local filename")
    path = root / name
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= size, "Invalid private input")
    with path.open("rb") as handle:
        data = handle.read(size + 1)
    require(len(data) <= size, "Private input exceeds limit")
    return data


def byte_range(root, name, url):
    receipt = json.loads(local_file(root, name, 32_768))
    require(receipt["source"] == url and receipt["status"] == 206, "Unexpected range source or status")
    buf = local_file(root, receipt["object"], MAX_RANGE)
    require(hashlib.sha256(buf).hexdigest() == receipt["sha256"], "Native range digest differs")
    headers = receipt["headers"]
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", headers["content-range"])
    require(match is not None, "Missing verified HTTP range")
    lo, hi, total = map(int, match.groups())
    require(0 <= lo <= hi < total and [lo, hi] == receipt["range"], "Wrong range coordinates")
    require(len(buf) == hi - lo + 1 == int(headers["content-length"]), "Range length differs")
    etag = headers["etag"]
    require(isinstance(etag, str) and etag.startswith('"') and etag.endswith('"'), "Strong HTTP ETag required")
    return buf, lo, total, etag


def from_zip(tail, directory_start, object_size, buf, offset, member):
    end = tail.rfind(b"PK\x05\x06")
    require(end >= 0 and end + 22 == len(tail), "Missing single-disk ZIP directory")
    _, disk, start_disk, entries, total_entries, length, start, _ = struct.unpack_from("<4s4H2IH", tail, end)
    require(disk == start_disk == 0 and 0 < entries == total_entries <= 1000, "Unsupported ZIP directory")
    require(0 <= directory_start <= start and start + length == directory_start + end, "Wrong ZIP directory bounds")
    require(directory_start + len(tail) == object_size, "Wrong ZIP object size")
    at = start - directory_start
    selected = []
    for _ in range(entries):
        require(at + 46 <= end, "Truncated central directory entry")
        entry = struct.unpack_from("<4s6H3I5H2I", tail, at)
        require(entry[0] == b"PK\x01\x02", "Invalid central directory record")
        name = tail[at + 46:at + 46 + entry[10]]
        if name == member.encode("ascii"):
            selected.append(entry)
        at += 46 + sum(entry[10:13])
    require(at == end and len(selected) == 1, "Closing member missing or duplicated")
    entry = selected[0]
    require(entry[3] == entry[4] == 0 and offset == entry[16], "Expected named, stored ZIP member at exact offset")
    require(len(buf) >= 30 and offset + len(buf) <= object_size, "Invalid ZIP prefix")
    hdr = struct.unpack_from("<4s5H3I2H", buf)
    require(hdr[0] == b"PK\x03\x04" and hdr[2:4] == entry[3:5] and hdr[6:9] == entry[7:10], "ZIP headers disagree")
    require(buf[30:30 + hdr[9]] == member.encode("ascii"), "Unexpected local ZIP member")
    body = buf[30 + hdr[9] + hdr[10]:][:entry[8]]
    require(bool(body) and entry[8] == entry[9], "Incomplete or compressed ZIP member")
    if len(body) == entry[8]:
        require(zlib.crc32(body) == entry[7], "Complete member failed CRC")
    return body, len(body) < entry[8]


def expand_zstd(data, partial):
    require(data.startswith(b"\x28\xb5\x2f\xfd"), "Missing zstd frame")
    with tempfile.TemporaryFile() as inp, tempfile.TemporaryFile() as err:
        inp.write(data)
        inp.seek(0)
        with subprocess.Popen(["zstd", "-qdc"], stdin=inp, stdout=subprocess.PIPE, stderr=err) as proc:
            try:
                raw = proc.stdout.read(MAX_PCAP + 1)
                require(len(raw) <= MAX_PCAP, "Decompressed packet sample exceeds limit")
            except BaseException:
                proc.kill()
                raise
            finally:
                proc.stdout.close()
            code = proc.wait()
        err.seek(0)
        error = err.read(4096)
    require(code == 0 or (partial and code == 1 and b"premature end" in error), "Invalid zstd packet capture")
    return raw, code != 0


def capture_data(root, path, side, edge, files):
    require((path, side) in {("cta", "a"), ("cta", "b"), ("utp", "a")}, "Unsupported production multicast path")
    product = "cta-cts" if path == "cta" else "utp-utdf"
    name = f"ny4-{product}-{side}-{DAY}"
    base = f"https://sample-pcaps-dl.databento.com/{path}/{DAY}/{name}"
    if edge == "open":
        data, offset, total, _ = byte_range(root, files["open"], base + "T133000.pcap.zst")
        require(offset == 0, "Opening data must start at the frame header")
        partial = len(data) < total
    else:
        require(edge == "close", "Unsupported edge")
        tail, start, size, etag = byte_range(root, files["directory"], base + ".zip")
        buf, offset, second_size, second_etag = byte_range(root, files["close"], base + ".zip")
        require((size, etag) == (second_size, second_etag), "ZIP versions differ")
        data, partial = from_zip(tail, start, size, buf, offset, name + "T200000.pcap.zst")
    return expand_zstd(data, partial)


def datagrams(raw, allow_partial=False):
    expected = struct.pack("<IHHIIII", 0xA1B23C4D, 2, 4, 0, 0, 262144, 1)
    require(raw.startswith(expected), "Expected nanosecond Ethernet PCAP")
    pos = len(expected)
    while pos + 16 <= len(raw):
        sec, nsec, length, wire = struct.unpack_from("<IIII", raw, pos)
        pos += 16
        require(nsec < NS and 14 <= length == wire <= 262144, "Invalid capture record")
        if pos + length > len(raw):
            require(allow_partial, "Truncated packet in a complete capture")
            return
        frame = raw[pos:pos + length]
        pos += length
        size, proto = 14, uint(frame[12:14])
        while proto in (0x8100, 0x88a8):
            require(len(frame) >= size + 4, "Truncated VLAN tag")
            proto = uint(frame[size + 2:size + 4])
            size += 4
        if proto != 0x0800:
            continue
        ip = frame[size:]
        require(len(ip) >= 20 and ip[0] >> 4 == 4, "Invalid IPv4 datagram")
        header, total = (ip[0] & 15) * 4, uint(ip[2:4])
        require(20 <= header <= total <= len(ip), "Invalid IP length")
        if ip[9] != 17:
            continue
        require(not uint(ip[6:8]) & 0x3fff, "Fragmented UDP datagram")
        udp = ip[header:total]
        require(8 <= len(udp) == uint(udp[4:6]), "Invalid UDP length")
        yield sec * NS + nsec, tuple(ip[16:20]), uint(udp[2:4]), udp[8:]
    require(pos == len(raw) or allow_partial, "Truncated record header in a complete capture")


def cta_timestamp(buf):
    seconds, nanos = struct.unpack(">II", buf)
    require(nanos < NS, "Invalid SIP timestamp")
    return seconds * NS + nanos


def cta_messages(payload):
    require(len(payload) >= 20 and payload[0] == 2 and payload[3:4] == b"T", "Wrong CTS production framing")
    require(len(payload) == uint(payload[1:3]) and len(payload) % 2 == 0, "Invalid CTS block length")
    require((sum(payload[:18]) + sum(payload[20:])) % 65536 == uint(payload[18:20]), "CTS checksum differs")
    require(payload[4:5] == b"O", "Expected original CTS broadcast")
    at = 20
    sip = cta_timestamp(payload[10:18])
    for _ in range(payload[9]):
        size = uint(payload[at:at + 2])
        require(size >= 26 and at + size <= len(payload), "Invalid CTS message length")
        yield sip, payload[at:at + size]
        at += size
    require(payload[at:] == (b"\x00" if at % 2 else b""), "Invalid CTS pad byte")


def utp_messages(payload):
    require(len(payload) >= 20 and payload[9:10] == b"T", "Expected UTDF MoldUDP64 session")
    count = uint(payload[18:20])
    require(count != 65535, "Unexpected end-of-session packet")
    at = 20
    for _ in range(count):
        length = uint(payload[at:at + 2])
        at += 2
        require(length >= 3 and at + length <= len(payload), "Invalid UTDF message length")
        msg = payload[at:at + length]
        require(msg[:1] == b"1", "Unsupported UTDF message version")
        yield uint(msg[5:13]), msg
        at += length
    require(at == len(payload), "Extra UTDF payload bytes")
