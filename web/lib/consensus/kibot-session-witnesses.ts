import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { collectCtaReference, CTA_REFERENCE_SYMBOLS, ctaReferenceUrl, parseCtaReference } from "./cta-reference.ts";
import { ETF_CASH_SOURCES, officialCashLocation, type CashDistribution } from "./corporate-adjustment.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { collectKibotSeries, isFullKibotSession, KIBOT_PRICE_CITATION, MAX_KIBOT_RESPONSE_BYTES, parseKibotDaily } from "./kibot.ts";
import type { SessionFundProof, Stamp } from "./kibot-after-close.ts";
import { durableDirectory, durableJSON, syncDirectory } from "../publication-storage.ts";
import { sourceChunk, SourceMissingError, sourceResponse, SourceTransportError } from "./source-failure.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import type { SessionPrice } from "./evaluation.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type ETF = SessionFundProof["symbol"];
export const STOCKLAKE_HISTORY = "https://api.stocklake.dev/mcp";
export function nasdaqDaily(symbol: ETF, day: string, fromdate = new Date(Date.parse(day + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10)) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${symbol}/historical`);
  url.search = new URLSearchParams({ assetclass: "etf", fromdate, todate: day, limit: "10" }).toString();
  return url.href;
}
type RawMeta = { url: string; sha256: string; capturedAt: string; responseUrl?: string };

async function ownerBytes(path: string, limit: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) || !stat.size || stat.size > limit) throw new Error("Invalid private source file");
  return readFile(path);
}
function checkStamp(stamp: Stamp, source: string, capturedAt: string, bytes: Buffer | string) {
  if (stamp.source !== source || stamp.capturedAt !== new Date(capturedAt).toISOString() || stamp.sha256 !== hash(bytes))
    throw new Error("Retained source bytes, identity or capture time differ");
}
function samePrice(bar: Pick<SessionPrice, "open" | "close"> | undefined, expected: SessionPrice) {
  if (!bar || bar.open !== expected.open || bar.close !== expected.close)
    throw new Error("Decoded source prices differ from the comparison");
}

type Fetcher = Parameters<typeof sourceResponse>[0];
type NasdaqMeta = RawMeta & { symbol: ETF; kind: string; requestedAt: string; body: string; status: number };

async function issuerActions(root: string, directory: string, symbol: ETF, day: string,
  expected: SessionFundProof["sources"]["issuer"] | undefined, collect: boolean) {
  const scripts = resolve(root, "scripts"), captured = resolve(directory, "issuer-post-close");
  async function decode(folder: string) {
    const file = resolve(folder, "issuer-" + symbol);
    const meta = await readResearchReceipt<RawMeta>(file + ".json");
    if (!meta || (expected && meta.sha256 !== expected.sha256)) return null;
    const capturedAt = new Date(meta.capturedAt).toISOString();
    if (capturedAt <= exchangeSession(day)!.closeAt) return null;
    if (meta.responseUrl !== undefined && !officialCashLocation(symbol, meta.url, meta.responseUrl))
      throw new Error("Issuer response changed fund or host");
    const stamp = { source: ETF_CASH_SOURCES[symbol], capturedAt, sha256: meta.sha256,
      ...(meta.responseUrl !== undefined ? { responseUrl: meta.responseUrl } : {}) };
    const raw = await ownerBytes(file + ".bin", 4_000_000);
    checkStamp(expected ?? stamp, meta.url, meta.capturedAt, raw);
    const code = "import json,sys\nfrom pathlib import Path\nfrom issuer_corporate_actions import issuer_cash\n" +
      "print(json.dumps(issuer_cash(sys.argv[1],Path(sys.argv[2]).read_bytes()),allow_nan=False))";
    const { stdout } = await promisify(execFile)("python3", ["-B", "-c", code, symbol, file + ".bin"], { cwd: scripts, timeout: 10000 });
    const result = JSON.parse(stdout);
    const targetExDates = result.cash.filter((r: CashDistribution) => r.session === day);
    if (result.symbol !== symbol || result.source !== stamp.source || result.sha256 !== stamp.sha256 ||
        (expected && digest(targetExDates) !== digest(expected.targetExDates)))
      throw new Error("Official distribution history differs from the proof");
    return { ...stamp, targetExDates };
  }
  const destination = resolve(captured, symbol);
  for (const folder of [directory, destination, captured, resolve(root, ".consensus/private-firstrate/captures", day)]) {
    const evidence = await decode(folder);
    if (evidence) return evidence;
  }
  if (collect && !expected) {
    await durableDirectory(captured, 0o700);
    await promisify(execFile)("python3", ["-B", resolve(scripts, "capture-kibot-issuer.py"), symbol, captured],
      { cwd: scripts, timeout: 20000 });
    const row = await decode(destination);
    if (row) return row;
  }
  throw new Error("Missing retained post-close issuer response");
}

async function ctaReport(directory: string, day: string, collect: boolean, fetcher: Fetcher) {
  const path = resolve(directory, "cta.json");
  let meta = await readResearchReceipt<{ source: string; capturedAt: string; sha256: string }>(path);
  if (!meta && collect) {
    const { reference, bytes } = await collectCtaReference(day, { fetcher });
    const candidate = { source: reference.source, capturedAt: new Date().toISOString(), sha256: reference.sha256 };
    const gz = resolve(directory, "cta-" + reference.sha256 + ".csv.gz");
    await durableDirectory(directory, 0o700);
    const temp = gz + "." + randomUUID() + ".tmp";
    const file = await open(temp, "wx", 0o600);
    try {
      try { await file.writeFile(gzipSync(bytes, { level: 1 })); await file.sync(); } finally { await file.close(); }
      try { await link(temp, gz); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    } finally { await unlink(temp); }
    const checked = gunzipSync(await ownerBytes(gz, 80_000_000), { maxOutputLength: 80_000_000 });
    if (hash(checked) !== candidate.sha256) throw new Error("Retained CTA archive changed");
    await syncDirectory(directory);
    await durableJSON(path, candidate, true);
    return { ...reference, capturedAt: candidate.capturedAt };
  }
  if (!meta || !/^[a-f0-9]{64}$/.test(meta.sha256) || meta.source !== ctaReferenceUrl(day))
    throw new Error("Missing dated final CTA source");
  const bytes = gunzipSync(await ownerBytes(resolve(directory, "cta-" + meta.sha256 + ".csv.gz"), 80_000_000),
    { maxOutputLength: 80_000_000 });
  const report = parseCtaReference(bytes, exchangeSession(day)!);
  if (report.sha256 !== meta.sha256 || report.source !== meta.source) throw new Error("CTA capture changed");
  return { ...report, capturedAt: meta.capturedAt };
}

function decodeNasdaq(meta: NasdaqMeta, symbol: ETF, day: string, stamp: Stamp) {
  if (!meta || meta.status !== 200 || meta.kind !== "daily" || meta.symbol !== symbol ||
      ![nasdaqDaily(symbol, day), nasdaqDaily(symbol, day, day)].includes(meta.url) || !Number.isFinite(Date.parse(meta.requestedAt)) ||
      new Date(meta.requestedAt).toISOString() !== meta.requestedAt ||
      meta.requestedAt < exchangeSession(day)!.closeAt || meta.requestedAt > meta.capturedAt)
    throw new Error("Missing dated Nasdaq ETF historical response");
  const bytes = Buffer.from(meta.body, "base64");
  if (!bytes.length || bytes.length > 100_000) throw new Error("Invalid Nasdaq history response size");
  checkStamp(stamp, meta.url, meta.capturedAt, bytes);
  if (meta.sha256 !== stamp.sha256) throw new Error("Nasdaq receipt hash changed");
  const { data, status } = JSON.parse(bytes.toString("utf8"));
  const table = data?.tradesTable;
  if (status?.rCode === 200 && (data === null || (data?.symbol === symbol && (table?.rows === null || (Array.isArray(table?.rows) && table.rows.length === 0)))))
    throw new SourceMissingError("Nasdaq has no historical ETF row for this date yet");
  if (status?.rCode !== 200 || data?.symbol !== symbol || table?.headers?.date !== "Date" ||
      table.headers.open !== "Open" || table.headers.close !== "Close/Last" || table.headers.low !== "Low" ||
      table.headers.high !== "High" || !Array.isArray(table.rows) || table.rows.length > 2)
    throw new Error("Nasdaq historical date, fund or price definition differs");
  const from = new URL(meta.url).searchParams.get("fromdate")!;
  const byDay = new Map<string, Record<string, unknown>>();
  for (const row of table.rows) {
    const parts = typeof row?.date === "string" && /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.date);
    if (!parts) throw new Error("Invalid Nasdaq historical row date");
    const session = `${parts[3]}-${parts[1]}-${parts[2]}`;
    if ((session !== from && session !== day) || !exchangeSession(session) || byDay.has(session))
      throw new Error("Duplicate or out-of-range Nasdaq historical row");
    byDay.set(session, row);
  }
  const target = byDay.get(day);
  if (!target) throw new SourceMissingError("Nasdaq has no historical ETF row for this date yet");
  const price = (field: string) => {
    const value = target[field];
    if (typeof value !== "string" || !/^\$?\d+(?:,\d{3})*(?:\.\d+)?$/.test(value))
      throw new Error("Invalid Nasdaq ETF price");
    return Number(value.replace(/[$,]/g, ""));
  };
  const open = price("open"), close = price("close"), low = price("low"), high = price("high");
  if (![open, close, low, high].every(n => Number.isFinite(n) && n > 0) || low > Math.min(open, close) || high < Math.max(open, close))
    throw new Error("Invalid Nasdaq daily range");
  return { open, close };
}

async function nasdaqControl(directory: string, symbol: ETF, day: string, collect: boolean, fetcher: Fetcher) {
  const path = resolve(directory, symbol + "-daily.json"), url = nasdaqDaily(symbol, day);
  let meta = await readResearchReceipt<NasdaqMeta>(path);
  if (!meta && collect) {
    const requestedAt = new Date().toISOString();
    const response = await sourceResponse(fetcher, url, { redirect: "error", signal: AbortSignal.timeout(12000),
      headers: { Accept: "application/json", "User-Agent": "DailyConsensus ETF historical verification" } });
    const reader = response.body!.getReader(), parts: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await sourceChunk(reader);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 100000) throw new Error("Invalid Nasdaq history response size");
        parts.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = Buffer.concat(parts);
    meta = { requestedAt, capturedAt: new Date().toISOString(), sha256: hash(bytes), body: bytes.toString("base64"),
      kind: "daily", url, status: response.status, symbol };
    decodeNasdaq(meta, symbol, day, { ...meta, source: url });
    await durableDirectory(directory, 0o700);
    await durableJSON(path, meta, true);
  }
  if (!meta) throw new Error("Missing dated Nasdaq ETF historical response");
  const stamp = { source: meta.url, capturedAt: meta.capturedAt, sha256: meta.sha256, basis: "Nasdaq historical Open and Close/Last" };
  return { stamp, prices: decodeNasdaq(meta, symbol, day, stamp) };
}

async function stocklakeControl(directory: string, symbol: ETF, day: string) {
  const meta = await readResearchReceipt<RawMeta & { status: number; provider: string; rawText: string }>(
    resolve(directory, "stocklake-" + symbol + ".json"));
  if (!meta || meta.status !== 200 || meta.provider !== "stocklake" || meta.url !== STOCKLAKE_HISTORY ||
      typeof meta.rawText !== "string" || Buffer.byteLength(meta.rawText) > 125_000) throw new Error("Missing secondary daily response");
  const stamp = { source: STOCKLAKE_HISTORY, capturedAt: meta.capturedAt, sha256: meta.sha256,
    basis: "provider daily OHLCV; venue, eligible trade and adjustment method unspecified" };
  checkStamp(stamp, meta.url, meta.capturedAt, meta.rawText);
  const packets = meta.rawText.startsWith("event:") ?
    meta.rawText.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))) :
    [JSON.parse(meta.rawText)];
  if (packets.length !== 1 || packets[0]?.result?.isError || packets[0]?.result?.content?.length !== 1)
    throw new Error("Invalid secondary history response");
  const body = JSON.parse(packets[0].result.content[0].text);
  const bar = body.history?.[0];
  if (body.symbol !== symbol || body.count !== 1 || body.history.length !== 1 || bar?.date !== day ||
      ![bar.open, bar.close, bar.low, bar.high].every(p => Number.isFinite(p) && p > 0) ||
      bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) ||
      !Number.isSafeInteger(bar.volume) || bar.volume < 1) throw new Error("Secondary history differs from the target");
  return { stamp, prices: { open: bar.open as number, close: bar.close as number } };
}

async function nativeCapture(directory: string, symbol: ETF, day: string, collect: boolean, fetcher: Fetcher) {
  const path = resolve(directory, symbol + "-kibot.json");
  let native = await readResearchReceipt<{ source: string; capturedAt: string; sha256: string; csv: string;
    symbol: ETF; unadjusted: boolean; first: string; through: string }>(path);
  if (!native && collect) {
    let csv = "";
    const data = await collectKibotSeries(symbol, [day], { unadjusted: true, fetcher, onVerifiedResponse: value => { csv = value; } });
    native = { source: KIBOT_PRICE_CITATION, capturedAt: new Date().toISOString(), sha256: data.sha256, csv,
      symbol, unadjusted: true, first: day, through: day };
    await durableDirectory(directory, 0o700);
    await durableJSON(path, native, true);
  }
  if (!native || native.symbol !== symbol || native.first !== day || native.through !== day || native.unadjusted !== true ||
      native.source !== KIBOT_PRICE_CITATION || typeof native.csv !== "string" || Buffer.byteLength(native.csv) > MAX_KIBOT_RESPONSE_BYTES ||
      hash(native.csv) !== native.sha256) throw new Error("Missing native Kibot capture for the fund and target day");
  return { stamp: { source: native.source, capturedAt: native.capturedAt, sha256: native.sha256,
    basis: "as-traded regular-session first and last trade" }, bar: parseKibotDaily(native.csv, [day])[0] };
}

function readSessionPrices(sourceRoot: string, day: string, collect: boolean, fetcher: Fetcher) {
  const directory = resolve(sourceRoot, day), market = exchangeSession(day);
  if (!market || !isFullKibotSession(market.openAt, market.closeAt) || (collect && Date.now() <= Date.parse(market.closeAt)))
    throw new Error("Collection requires a completed full exchange session");
  let cta: ReturnType<typeof ctaReport> | undefined;
  type ControlKind = "listing" | "historical" | "secondary";
  async function readControl(symbol: ETF, kind: ControlKind) {
    let control;
    if (kind === "listing") {
      cta ??= ctaReport(directory, day, collect, fetcher);
      const report = await cta;
      const bar = report.rows.find(row => row.symbol === symbol);
      if (!bar || report.capturedAt < bar.summaryAt) throw new Error("CTA capture precedes its final report");
      control = { stamp: { source: report.source, capturedAt: report.capturedAt, sha256: report.sha256,
        basis: report.basis, summaryAt: bar.summaryAt }, prices: bar };
    } else if (kind === "historical") control = await nasdaqControl(directory, symbol, day, collect, fetcher);
    else control = await stocklakeControl(directory, symbol, day);
    return { independent: { ...market!, open: control.prices.open, close: control.prices.close }, controlSource: control.stamp, kind };
  }
  async function independentPrice(symbol: ETF, declared?: SessionFundProof) {
    if (declared) {
      const kind = declared.sources.listing ? "listing" : declared.sources.historical ? "historical" : "secondary";
      return readControl(symbol, kind);
    }
    const arca = CTA_REFERENCE_SYMBOLS.some(fund => fund === symbol);
    const primaryKind = arca ? "listing" : "historical";
    const primary = await readResearchReceipt(resolve(directory, arca ? "cta.json" : symbol + "-daily.json"));
    if (primary) return readControl(symbol, primaryKind);
    const secondary = await readResearchReceipt(resolve(directory, "stocklake-" + symbol + ".json"));
    if (!secondary) return readControl(symbol, primaryKind);
    if (collect) {
      // A secondary bar can be delivered before the exchange's final price.
      // Preserve its original bytes and try the exchange again on the next collection.
      try { return await readControl(symbol, primaryKind); }
      catch (error) {
        if (!(error instanceof SourceMissingError || error instanceof SourceTransportError)) throw error;
      }
    }
    return readControl(symbol, "secondary");
  }
  return async (symbol: ETF, declared?: SessionFundProof) => {
    const [native, control] = await Promise.allSettled([
      nativeCapture(directory, symbol, day, collect, fetcher), independentPrice(symbol, declared),
    ]);
    if (native.status === "rejected") throw native.reason;
    if (control.status === "rejected") throw control.reason;
    return { native: native.value.bar, nativeSource: native.value.stamp, ...control.value };
  };
}

export async function retainedPriorPrices(sourceRoot: string, symbol: ETF, previous: string, collect: boolean) {
  const values = await readSessionPrices(sourceRoot, previous, collect, fetch)(symbol);
  const asOf = new Date().toISOString();
  if ([values.controlSource, values.nativeSource].some(({capturedAt: at}) => !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at || at <= exchangeSession(previous)!.closeAt || at > asOf))
    throw new Error("Missing dated previous session control");
  return values;
}

/** Derive the bundle from the dated original files, or compare an older immutable bundle back to them. */
export function retainedSessionWitnesses(root: string, sourceRoot: string, day: string, collect = false, fetcher: Fetcher = fetch) {
  const read = readSessionPrices(sourceRoot, day, collect, fetcher);
  return async (symbol: ETF, declared?: SessionFundProof): Promise<SessionFundProof> => {
    const [prices, distributions] = await Promise.allSettled([
      read(symbol, declared), issuerActions(root, resolve(sourceRoot, day), symbol, day, declared?.sources.issuer, collect),
    ]);
    if (prices.status === "rejected") throw prices.reason;
    if (distributions.status === "rejected") throw distributions.reason;
    const value = prices.value, issuer = distributions.value;
    if (declared) {
      const stamp = declared.sources[value.kind];
      if (declared.symbol !== symbol || !stamp || value.nativeSource.source !== declared.sources.kibot.source ||
          value.nativeSource.sha256 !== declared.sources.kibot.sha256 || value.nativeSource.capturedAt !== declared.sources.kibot.capturedAt ||
          stamp.source !== value.controlSource.source || stamp.sha256 !== value.controlSource.sha256 || stamp.capturedAt !== value.controlSource.capturedAt ||
          (value.kind === "listing" && stamp.summaryAt !== ("summaryAt" in value.controlSource ? value.controlSource.summaryAt : undefined)))
        throw new Error("Retained source lineage differs from the comparison");
      samePrice(value.native, declared.asTraded.at(-1)!);
      samePrice(value.independent, declared.selectedBars.at(-1)!);
      return declared;
    }
    return { symbol, asTraded: [value.native], selectedBars: [value.independent], sources: {
      kibot: value.nativeSource, issuer, [value.kind]: value.controlSource } };
  };
}
