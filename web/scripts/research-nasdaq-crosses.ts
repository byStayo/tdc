import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { collectKibotSeries } from "../lib/consensus/kibot.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { historicalResearchSession } from "../lib/consensus/research-session-calendar.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const day = "2025-11-28";
const source = "https://emi.nasdaq.com/ITCH/Nasdaq%20ITCH/S112825-v50.txt.gz";
const etag = '"eebc1df4e724dd1:0"';
const expectedBytes = 4_735_308_661;
const expectedSha256 = "e965ea6f9779c1b5d7b74de4549836ffe29a5f6ff64bb7894186a6f6404baaa4";
const directory = fileURLToPath(new URL("../.consensus/private-nasdaq-crosses/", import.meta.url));
const receipt = resolve(directory, `${day}-${expectedSha256.slice(0, 12)}.json`);
const symbols = ["QQQ", "TLT"] as const;
const session = historicalResearchSession(day)!;
const midnight = Date.parse(newYorkTimestamp("20251128T000000")!);
const boundaryNs = (timestamp: string) => (Date.parse(timestamp) - midnight) * 1_000_000;
const openNs = boundaryNs(session.openAt);
const closeNs = boundaryNs(session.closeAt);
const minuteNs = 60_000_000_000;

if (process.argv.slice(2).join(" ") !== "--download")
  throw new Error("Use npm run consensus:research-nasdaq-crosses -- --download for the pinned 4.7 GB archive");
if (await readResearchReceipt(receipt)) throw new Error(`Nasdaq archive receipt already exists at ${receipt}`);

type Cross = { type: "O" | "C"; ns: number; shares: string; price: number; match: string };
type Listing = { locate: number; market: string };
const listings = new Map<string, Listing>();
const crosses = new Map<string, Cross[]>(symbols.map(symbol => [symbol, []]));
const breaks = new Map<string, number>();
const events = new Map<string, number>();
let compressedBytes = 0;
let decompressedBytes = 0;
let messages = 0;
let emptyFrame = false;
let tail: Buffer = Buffer.alloc(0);
let nextProgress = 512 * 1024 * 1024;
const hash = createHash("sha256");

// BinaryFILE uses a two-byte big-endian length before each ITCH message.
function scan(chunk: Buffer) {
  decompressedBytes += chunk.length;
  if (decompressedBytes > 30_000_000_000) throw new Error("Nasdaq sample exceeded its decompressed size bound");
  const bytes = tail.length ? Buffer.concat([tail, chunk]) : chunk;
  let offset = 0;
  let frameCount = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes[offset] * 256 + bytes[offset + 1];
    const start = offset + 2;
    if (start + length > bytes.length) break;
    offset = start + length;
    if (emptyFrame || (events.has("C") && length !== 0)) throw new Error("Unexpected data after the Nasdaq session end");
    if (length === 0) {
      if (!events.has("C")) throw new Error("Nasdaq zero-length frame arrived before End of Messages");
      emptyFrame = true;
      continue;
    }
    if (length < 11) throw new Error("Truncated ITCH message");
    frameCount++;
    const type = bytes[start];
    if (type === 83 && length === 12) { // S: System Event
      const event = String.fromCharCode(bytes[start + 11]);
      if (events.has(event)) throw new Error("Duplicate Nasdaq session event");
      events.set(event, bytes.readUIntBE(start + 5, 6));
    } else if (type === 82 && length === 39) { // R: Stock Directory
      const symbol = bytes.toString("ascii", start + 11, start + 19).trimEnd();
      if (!crosses.has(symbol)) continue;
      const market = String.fromCharCode(bytes[start + 19]);
      if (!"QGS".includes(market) || listings.has(symbol)) throw new Error("Unexpected Nasdaq listing for " + symbol);
      listings.set(symbol, { market, locate: bytes.readUInt16BE(start + 1) });
    } else if (type === 81 && length === 40) { // Q: Cross Trade
      const crossType = String.fromCharCode(bytes[start + 39]);
      if (crossType !== "O" && crossType !== "C") continue;
      const symbol = bytes.toString("ascii", start + 19, start + 27).trimEnd();
      const rows = crosses.get(symbol);
      if (!rows) continue;
      if (listings.get(symbol)?.locate !== bytes.readUInt16BE(start + 1)) throw new Error("Nasdaq listing locate mismatch");
      rows.push({
        type: crossType,
        ns: bytes.readUIntBE(start + 5, 6),
        shares: bytes.readBigUInt64BE(start + 11).toString(),
        price: bytes.readUInt32BE(start + 27) / 10_000,
        match: bytes.readBigUInt64BE(start + 31).toString(),
      });
    } else if (type === 66 && length === 19) { // B: Broken Trade
      const match = bytes.readBigUInt64BE(start + 11).toString();
      breaks.set(match, bytes.readUIntBE(start + 5, 6));
    }
  }
  messages += frameCount;
  tail = bytes.subarray(offset);
}

async function* archiveRanges() {
  const rangeSize = 16 * 1024 * 1024;
  const concurrency = 4;
  const deadline = AbortSignal.timeout(18 * 60_000);
  for (let offset = 0; offset < expectedBytes; offset += concurrency * rangeSize) {
    const starts = Array.from({ length: concurrency }, (_, index) => offset + index * rangeSize)
      .filter(start => start < expectedBytes);
    const chunks = await Promise.all(starts.map(async start => {
      const end = Math.min(start + rangeSize, expectedBytes) - 1;
      const length = end - start + 1;
      const response = await fetch(source, {
        headers: { Range: `bytes=${start}-${end}`, "If-Match": etag, "Accept-Encoding": "identity" },
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(45_000)]),
      });
      if (response.status !== 206 || response.headers.get("etag") !== etag ||
          response.headers.get("content-range") !== `bytes ${start}-${end}/${expectedBytes}` ||
          Number(response.headers.get("content-length")) !== length || response.headers.has("content-encoding")) {
        await response.body?.cancel();
        throw new Error(`Nasdaq archive range at ${start} differs from the pinned release`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== length) throw new Error(`Incomplete Nasdaq archive range at ${start}`);
      return bytes;
    }));
    for (const chunk of chunks) yield chunk;
  }
}

await pipeline(archiveRanges(), new Transform({
  transform(chunk: Buffer, _encoding, done) {
    compressedBytes += chunk.length;
    if (compressedBytes > expectedBytes) { done(new Error("Nasdaq archive exceeded its pinned length")); return; }
    if (compressedBytes >= nextProgress) {
      console.error(`Read ${compressedBytes} of ${expectedBytes} compressed Nasdaq bytes`);
      nextProgress += 512 * 1024 * 1024;
    }
    hash.update(chunk);
    done(null, chunk);
  },
}), createGunzip({ chunkSize: 1_048_576 }), async (input: AsyncIterable<Buffer>) => {
  for await (const chunk of input) scan(chunk);
});

const systemOpen = events.get("Q");
const systemClose = events.get("M");
const sha256 = hash.digest("hex");
// This pinned sample ends with ITCH End of Messages. Its complete gzip and
// checksum establish the object boundary without a separate empty BinaryFILE frame.
if (tail.length || compressedBytes !== expectedBytes || sha256 !== expectedSha256 || !events.has("O") || !events.has("C") ||
    !systemOpen || Math.abs(systemOpen - openNs) >= minuteNs ||
    !systemClose || Math.abs(systemClose - closeNs) >= minuteNs || events.get("C")! <= systemClose)
  throw new Error("Nasdaq archive lacks a complete reviewed exchange session");

const comparison = await Promise.all(symbols.map(async symbol => {
  const rows = crosses.get(symbol)!;
  const survivors = rows.filter(row => !breaks.has(row.match));
  const open = survivors.find(row => row.type === "O");
  const close = survivors.find(row => row.type === "C");
  if (survivors.length !== 2 || !open || !close || !open.price || !close.price ||
      open.match === close.match || open.shares === "0" || close.shares === "0" ||
      open.ns < openNs || open.ns >= openNs + minuteNs || close.ns < closeNs || close.ns >= closeNs + minuteNs)
    throw new Error("Missing or ambiguous regular-session Nasdaq crosses for " + symbol);
  const { sessions: [raw], sha256 } = await collectKibotSeries(symbol, [day], { unadjusted: true, sessionClock: historicalResearchSession });
  const openBps = (open.price / raw.open - 1) * 10_000;
  const closeBps = (close.price / raw.close - 1) * 10_000;
  return {
    symbol, listing: listings.get(symbol), open, close, brokenCrosses: rows.filter(row => breaks.has(row.match)).length,
    comparisonSha256: sha256, openBps, closeBps,
    passed: Math.abs(openBps) <= 3 && Math.abs(closeBps) <= 15 &&
      Math.sign(close.price - open.price) === Math.sign(raw.close - raw.open),
  };
}));
await durableDirectory(directory, 0o700);
const fetchedAt = new Date().toISOString();
await durableJSON(receipt, {
  scope: "private-source-qualification", source, etag, sha256, day, fetchedAt, compressedBytes, decompressedBytes,
  messages, events: Object.fromEntries(events), binaryFileEndMarker: emptyFrame, brokenTrades: breaks.size, comparison,
}, true);
console.log(JSON.stringify({
  day, sha256, compressedBytes, decompressedBytes, messages, binaryFileEndMarker: emptyFrame, brokenTrades: breaks.size,
  comparisons: comparison.map(({ symbol, open, close, brokenCrosses, openBps, closeBps, passed }) => ({
    symbol, openDelayMs: (open.ns - openNs) / 1_000_000, closeDelayMs: (close.ns - closeNs) / 1_000_000,
    brokenCrosses, openBps, closeBps, passed,
  })),
}, null, 2));
if (comparison.some(row => !row.passed)) process.exitCode = 2;
