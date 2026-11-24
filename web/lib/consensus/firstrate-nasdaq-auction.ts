import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { durableJSON } from "../publication-storage.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";

type Stamp = { source: string; sha256: string; capturedAt: string };
type Capture = Stamp & { body: string };
export type QqqAuction = { session: string; officialClose: number; crossShares: number; nocp: Stamp; cross: Stamp };
type Fetcher = Parameters<typeof sourceResponse>[0];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const labelDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", year: "numeric" });
const MAX_NOCP = 150_000, MAX_CROSS = 1_000_000;

export function qqqAuctionUrls(day: string) {
  if (!exchangeSession(day)) throw new Error("Nasdaq auction requires a reviewed session");
  const prior = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
  return { nocp: "https://api.nasdaq.com/api/company/QQQ/historical-nocp?assetclass=etf&fromdate=" + prior + "&todate=" + day + "&limit=10",
    cross: "https://www.nasdaqtrader.com/files/crosses/CrossStats" + day.replaceAll("-", "") + ".txt" };
}

function validStamp(stamp: Stamp, url: string, closeAt: string, asOf?: string) {
  return stamp?.source === url && /^[a-f0-9]{64}$/.test(stamp.sha256) && Number.isFinite(Date.parse(stamp.capturedAt)) &&
    new Date(stamp.capturedAt).toISOString() === stamp.capturedAt && stamp.capturedAt >= closeAt && (!asOf || stamp.capturedAt <= asOf);
}

export function validQqqAuction(auction: QqqAuction, asOf?: string) {
  const urls = qqqAuctionUrls(auction.session);
  const closeAt = exchangeSession(auction.session)!.closeAt;
  // Nasdaq Equity 4 4754(b)(4): a sub-round-lot ETF cross may receive a calculated close.
  return Number.isFinite(auction.officialClose) && auction.officialClose > 0 &&
    Number.isSafeInteger(auction.crossShares) && auction.crossShares >= 100 &&
    validStamp(auction.nocp, urls.nocp, closeAt, asOf) && validStamp(auction.cross, urls.cross, closeAt, asOf);
}

async function capture(url: string, limit: number, fetcher: Fetcher, now: () => string): Promise<Capture> {
  const response = await sourceResponse(fetcher, url, { redirect: "error", signal: AbortSignal.timeout(12000),
    headers: { Accept: "*/*", "User-Agent": "DailyConsensus ETF historical verification" } });
  const reader = response.body!.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error("Oversized Nasdaq auction response");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(parts);
  return { source: url, capturedAt: now(), sha256: sha(bytes), body: bytes.toString("base64") };
}

function decoded(capture: Capture, url: string, limit: number, closeAt: string, asOf: string) {
  if (!validStamp(capture, url, closeAt, asOf)) throw new Error("Invalid Nasdaq auction receipt");
  const bytes = Buffer.from(capture.body, "base64");
  if (!bytes.length || bytes.length > limit || sha(bytes) !== capture.sha256) throw new Error("Changed Nasdaq auction receipt");
  return bytes.toString("utf8");
}

function officialClose(text: string, day: string, usDay: string) {
  const { data, status } = JSON.parse(text);
  const table = data?.nocp?.nocpTable, chart = data?.nocp?.nocpChart;
  if (status?.rCode !== 200 || data?.headers?.date !== "Trade Date" || data.headers.price !== "Nasdaq Closing Price" ||
      !Array.isArray(table) || !Array.isArray(chart) || table.length > 400 || chart.length > 400)
    throw new Error("Nasdaq closing price definition changed");
  const rows = table.filter(row => row?.date === usDay);
  const points = chart.filter(point => point?.x === Date.parse(day) / 1000);
  const value = rows[0]?.price;
  if (rows.length !== 1 || points.length !== 1 || typeof value !== "string" || !/^\$\d+(?:,\d{3})*(?:\.\d+)?$/.test(value) ||
      points[0].y !== value.replace(/[$,]/g, "") || points[0].z?.details !== "QQQ Close Price: " + value ||
      points[0].z?.date?.replace(/\s+,/g, ",") !== labelDate.format(Date.parse(day)))
    throw new Error("Nasdaq official price, symbol or session could not be confirmed");
  return Number(value.replace(/[$,]/g, ""));
}

function closingCrossShares(text: string, usDay: string) {
  const [header, ...lines] = text.trimEnd().split(/\r?\n/);
  if (header.split(",").map(s => s.trim()).join(",") !== "Date,Symbol,ListingMarket,OpeningCross,ClosingCross,IntradayCross,")
    throw new Error("Nasdaq closing cross fields changed");
  const selected = lines.map(line => line.split(",").map(field => field.trim())).filter(fields => fields[1] === "QQQ");
  if (selected.length !== 1 || selected[0].length !== 7 || selected[0][0] !== usDay || !/^\d+$/.test(selected[0][4]))
    throw new Error("Nasdaq closing cross does not uniquely identify this session and ETF");
  return Number(selected[0][4]);
}

/** Two exchange records distinguish the official auction from the earlier continuous endpoint. Store both privately. */
export async function readQqqAuction(directory: string, day: string, cachedOnly: boolean, fetcher: Fetcher = fetch,
  now = () => new Date().toISOString()): Promise<QqqAuction | null> {
  const urls = qqqAuctionUrls(day), closeAt = exchangeSession(day)!.closeAt;
  const path = resolve(directory, "nasdaq-QQQ-auction-" + day + ".json");
  const retained = await readResearchReceipt<{ nocp: Capture; cross: Capture }>(path);
  let captures = retained;
  if (!captures) {
    if (cachedOnly || now() < closeAt) return null;
    const [nocp, cross] = await Promise.all([capture(urls.nocp, MAX_NOCP, fetcher, now), capture(urls.cross, MAX_CROSS, fetcher, now)]);
    captures = { nocp, cross };
  }
  const asOf = now(), usDay = day.slice(5, 7) + "/" + day.slice(8) + "/" + day.slice(0, 4);
  const nocp = decoded(captures.nocp, urls.nocp, MAX_NOCP, closeAt, asOf);
  const cross = decoded(captures.cross, urls.cross, MAX_CROSS, closeAt, asOf);
  const stamp = ({ source, sha256, capturedAt }: Capture): Stamp => ({ source, sha256, capturedAt });
  const result = { session: day, officialClose: officialClose(nocp, day, usDay), crossShares: closingCrossShares(cross, usDay),
    nocp: stamp(captures.nocp), cross: stamp(captures.cross) };
  if (!validQqqAuction(result, asOf)) throw new Error("Nasdaq official close lacks a confirmed full-lot closing cross");
  if (!retained) await durableJSON(path, captures, true);
  return result;
}
