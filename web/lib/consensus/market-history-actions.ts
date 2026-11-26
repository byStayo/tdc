import { authenticatedFreeMarketHistoryResponse } from "./market-history-hourly-access.ts";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { publicDate } from "../public-normalization.ts";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import type { CashDistribution } from "./corporate-adjustment.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { freeMarketHistoryBalance, type MarketHistoryETF } from "./market-history-boundaries.ts";
import { marketHistoryPreview } from "./market-history-preview.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk } from "./source-failure.ts";

const authority = "https://getmarkethistory.com";
const identity = {
  SPY: ["78462F103", "ssga", "ARCA"], QQQ: ["46090E103", "invesco", "NASDAQ"],
  IWM: ["464287655", "ishares", "ARCA"], DIA: ["78467X109", "ssga", "ARCA"], TLT: ["464287432", "ishares", "NASDAQ"],
} as const;
const retainedHeaders = ["content-type", "date", "x-row-count", "x-bars-charged", "x-bars-paid-remaining",
  "x-bars-remaining", "x-cap-remaining", "x-next-cursor", "x-limit-clamped", "link"];
const components = ["dividend_rate", "short_term_rate", "long_term_rate", "return_of_capital_rate"];
const maximumBytes = 350_000;
const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const instant = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const equalCash = (left: number, right: number) =>
  Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(Math.abs(left), Math.abs(right));
class CashDifference extends Error {}

export type MarketHistoryActionCapture = {
  source: string; status?: 200; receivedAt: string; headers: Record<string, string>; sha256: string; raw: string;
};
export type MarketHistoryActionProof = {
  provider: "market-history"; scope: "issuer-cash-vs-corporate-actions"; symbol: MarketHistoryETF;
  from: string; through: string; sha256: string; primaryCount: number; issuerMirrorCount: number;
};
type Stored = ReturnType<typeof sealMarketHistoryActionCapture>;
type Options = { asOf?: string; fetcher?: typeof fetch; environmentKey?: string; signal?: AbortSignal };

function requireRange(symbol: MarketHistoryETF, from: string, through: string) {
  if (!Object.hasOwn(identity, symbol) || publicDate(from) !== from || publicDate(through) !== through ||
      from > through || Date.parse(through) - Date.parse(from) > 35 * 86_400_000)
    throw Error("Invalid bounded ETF corporate-action range");
}
function location(symbol: MarketHistoryETF, from: string, through: string) {
  return authority + "/query/v1/corporate-actions?" + new URLSearchParams({ dataset: "stocks/us", ticker: symbol, start: from, end: through, format: "jsonl" });
}
export function marketHistoryActionCachePath(root: string, symbol: MarketHistoryETF, from: string, through: string) {
  requireRange(symbol, from, through);
  return resolve(root, ".consensus/private-market-history/firstrate-actions", [symbol, from, through].join("-") + ".json");
}
export function sealMarketHistoryActionCapture(capture: MarketHistoryActionCapture) {
  if (!capture || !["headers raw receivedAt sha256 source", "headers raw receivedAt sha256 source status"].includes(Object.keys(capture).sort().join(" ")) ||
      (Object.hasOwn(capture, "status") && capture.status !== 200) ||
      !capture.headers || Object.keys(capture.headers).some(k => !retainedHeaders.includes(k)))
    throw Error("Unexpected fields in the private corporate-action original");
  return { schemaVersion: 1 as const, capture, sha256: digest(capture) };
}

function expectedCash(rows: CashDistribution[], from: string, through: string) {
  const expected = new Map<string, number>();
  for (const row of rows) {
    if (!row || publicDate(row.session) !== row.session || !Number.isFinite(row.amount) || row.amount <= 0)
      throw Error("Invalid original issuer distribution");
    if (row.session < from || row.session > through) continue;
    if (!exchangeSession(row.session) || expected.has(row.session)) throw Error("Ambiguous issuer distribution date");
    expected.set(row.session, row.amount);
  }
  return new Map([...expected].sort(([a], [b]) => a.localeCompare(b)));
}

// The provider's rate is the entire payment. Its optional tax breakdown describes that amount once.
function verifyCashRow(a: Record<string, unknown>, symbol: MarketHistoryETF) {
  if (a.type !== "cash_dividends" && a.type !== "capital_gains_distributions") throw Error("Unsupported stock or corporate action");
  if (!Number.isFinite(a.rate) || (a.rate as number) <= 0 || a.old_rate != null || a.new_rate != null ||
      (a.currency != null && a.currency !== "USD") ||
      (a.foreign != null && a.foreign !== false) || (a.special != null && typeof a.special !== "boolean") ||
      (a.due_bill_redemption_date != null && a.due_bill_redemption_date !== a.ex_date))
    throw Error("Corporate action has an unverified share, currency or ex-date basis");
  const origin = a.source;
  if (origin !== null && origin !== "" && origin !== "issuer:" + identity[symbol][1])
    throw Error("Unverified corporate-action origin");
  if (a.extra != null) {
    const extra = typeof a.extra === "string" ? JSON.parse(a.extra) : a.extra;
    if (typeof extra !== "object" || !extra || Array.isArray(extra) || Object.keys(extra).some(k => k !== "currency" && !components.includes(k)) ||
        (extra.currency != null && extra.currency !== "USD")) throw Error("Unknown corporate-action breakdown");
    const pieces = components.flatMap(k => extra[k] == null ? [] : [extra[k]]);
    if (pieces.length && (pieces.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0) ||
        !equalCash(pieces.reduce((n, v) => n + v, 0), a.rate as number))) throw Error("Tax components differ from total cash per share");
  }
  return origin ? "issuer" : "primary";
}

function verify(symbol: MarketHistoryETF, from: string, through: string, expected: Map<string, number>, stored: Stored, asOf: string): MarketHistoryActionProof {
  const c = stored?.capture;
  if (!c || stored.schemaVersion !== 1 || stored.sha256 !== sealMarketHistoryActionCapture(c).sha256 || typeof c.raw !== "string" ||
      Buffer.byteLength(c.raw) > maximumBytes || c.sha256 !== hash(c.raw)) throw Error("Corporate-action original or seal differs");
  const q = new URL(c.source).searchParams, start = q.get("start") ?? "", end = q.get("end") ?? "";
  requireRange(symbol, start, end);
  const h = c.headers, server = Date.parse(h.date), close = exchangeSession(through)?.closeAt;
  if (c.source !== location(symbol, start, end) || start > from || end < through || !close || !instant(c.receivedAt) ||
      !instant(asOf) || c.receivedAt > asOf || !Number.isFinite(server) || new Date(server).toUTCString() !== h.date ||
      server <= Date.parse(close) || server > Date.parse(c.receivedAt) || Date.parse(c.receivedAt) > Date.now() ||
      h["content-type"]?.split(";")[0].trim() !== "application/x-ndjson" || h["x-bars-paid-remaining"] !== "0" ||
      h["x-next-cursor"] || h["x-limit-clamped"] || /rel\s*=\s*"?next/i.test(h.link ?? "") ||
      Object.keys(h).some(k => !retainedHeaders.includes(k))) throw Error("Corporate-action scope, serving clock or entitlement differs");
  if (h["x-bars-remaining"] !== undefined) freeMarketHistoryBalance(new Headers(h));
  const lines = c.raw.trim() ? c.raw.trim().split(/\r?\n/) : [];
  const charged = h["x-bars-charged"];
  if (lines.length > 1000 || h["x-row-count"] !== String(lines.length) ||
      !(lines.length ? [String(Math.ceil(lines.length / 100) * 100), "1000"].includes(charged) : charged === "0"))
    throw Error("Corporate-action native row count or charge differs");
  const totals = new Map<string, number>(), seenIds = new Set<string>(), identities = new Set<string>();
  let primaryCount = 0, issuerMirrorCount = 0;
  for (const line of lines) {
    const a = JSON.parse(line) as Record<string, unknown>;
    const day = a.ex_date ?? a.process_date;
    if (a.symbol !== symbol || a.cusip !== identity[symbol][0] || typeof a.id !== "string" || !a.id || seenIds.has(a.id) ||
        typeof day !== "string" || publicDate(day) !== day || day < start || day > end) throw Error("Corporate-action security, date or ID differs");
    seenIds.add(a.id);
    if (day < from || day > through) continue;
    if (a.ex_date !== day || !exchangeSession(day)) throw Error("Unverified exchange ex-date");
    const origin = verifyCashRow(a, symbol);
    // The provider already deduplicates payments. Separate regular, special or capital-gain rows may coexist.
    const eventKey = [day, a.type, a.special === true ? "special" : "ordinary"].join("/");
    if (identities.has(eventKey)) throw Error("Ambiguous repeated corporate-action payment");
    identities.add(eventKey);
    totals.set(day, (totals.get(day) ?? 0) + (a.rate as number));
    if (origin === "issuer") issuerMirrorCount++; else primaryCount++;
  }
  if (totals.size !== expected.size || [...expected].some(([day, amount]) => !equalCash(amount, totals.get(day) ?? 0)))
    throw new CashDifference("Provider corporate actions differ from issuer ex-dates or amounts");
  return { provider: "market-history", scope: "issuer-cash-vs-corporate-actions", symbol, from, through, primaryCount, issuerMirrorCount,
    sha256: digest({ symbol, from, through, source: stored.sha256, issuerCash: [...expected] }) };
}

/** Recompute a private comparison from an authenticated original retained by a reviewed collector. */
export function marketHistoryIssuerActionProofFromCapture(symbol: MarketHistoryETF, from: string, through: string,
  issuerCash: CashDistribution[], capture: MarketHistoryActionCapture, asOf: string) {
  requireRange(symbol, from, through);
  if (!exchangeSession(from)) throw Error("Invalid first exchange date for corporate-action review");
  return verify(symbol, from, through, expectedCash(issuerCash, from, through), sealMarketHistoryActionCapture(capture), asOf);
}

async function acquire(root: string, symbol: MarketHistoryETF, from: string, through: string, options: Options) {
  const fetcher = options.fetcher ?? fetch;
  const key = options.environmentKey ?? process.env.MARKET_HISTORY_KEY ?? (await readResearchReceipt<{ apiKey: string }>(
    resolve(root, ".consensus/private-market-history/credentials.json")))?.apiKey;
  if (!key || /[\r\n]/.test(key)) throw Error("Missing active free Market History account for corporate actions");
  const meta = JSON.parse((await marketHistoryPreview("stocks/us/" + symbol, fetcher)).text);
  const frames = meta.bars?.timeframes?.filter((f: { timeframe: string; feed: string; venue: string }) =>
    f.timeframe === "1m" && f.feed === "consolidated" && f.venue === "US consolidated tape");
  const close = Date.parse(exchangeSession(through)!.closeAt), cutoff = Date.parse(options.asOf ?? now());
  const last = Date.parse(frames?.[0]?.last);
  if (meta.ticker !== symbol || meta.dataset !== "stocks/us" || meta.contract?.status !== "active" || meta.contract.exchange !== identity[symbol][2] ||
      frames?.length !== 1 || !Number.isFinite(last) || last < close || last > cutoff) throw Error("ETF price catalogue has not verified the requested close");
  const authenticated = (url: string) => authenticatedFreeMarketHistoryResponse(url, key, fetcher, options.signal);
  const fee = await authenticated(authority + "/query/v1/fee-rules?dataset=stocks%2Fus&scheme=regulatory_levy&at=" + through);
  try {
    if (freeMarketHistoryBalance(fee.headers) < 1000) throw Error("Insufficient free bars for corporate actions");
  } finally { await fee.body?.cancel(); }
  const source = location(symbol, from, through), response = await authenticated(source);
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  try {
    if (response.status !== 200) throw Error("Incomplete Market History corporate-action response");
    freeMarketHistoryBalance(response.headers);
    let bytes = 0;
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > maximumBytes) throw Error("Corporate-action response exceeds its bound");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return sealMarketHistoryActionCapture({ source, status: 200, receivedAt: now(), raw, sha256: hash(raw),
    headers: Object.fromEntries(retainedHeaders.filter(k => response.headers.has(k)).map(k => [k, response.headers.get(k)!])) });
}

export async function firstRateIssuerActionProof(root: string, symbol: MarketHistoryETF, from: string, through: string,
  issuerCash: CashDistribution[], cachedOnly: boolean, options: Options = {}): Promise<MarketHistoryActionProof> {
  let path = marketHistoryActionCachePath(root, symbol, from, through);
  const close = exchangeSession(through)?.closeAt, cutoff = options.asOf ?? now();
  if (!exchangeSession(from) || !close || !instant(cutoff) || cutoff <= close) throw Error("Corporate-action check requires a completed exchange window");
  const expected = expectedCash(issuerCash, from, through);
  const inspect = (s: Stored) => verify(symbol, from, through, expected, s, options.asOf ?? now());
  const saved = await readResearchReceipt<Stored>(path);
  if (saved) {
    try { return inspect(saved); }
    catch (error) {
      if (!(error instanceof CashDifference)) throw error;
      // Preserve the earlier review if the issuer later changes its dividend instead of rewriting the receipt.
      path = path.replace(/\.json$/, "-" + digest([...expected]) + ".json");
      const revision = await readResearchReceipt<Stored>(path);
      if (revision) return inspect(revision);
    }
  }
  if (cachedOnly) throw Error("Missing verified corporate-action original for " + symbol + " through " + through);
  const fresh = await acquire(root, symbol, from, through, options);
  const proof = inspect(fresh);
  await durableDirectory(resolve(root, ".consensus/private-market-history/firstrate-actions"), 0o700);
  try { await durableJSON(path, fresh, true); return proof; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readResearchReceipt<Stored>(path);
    if (!winner) throw error;
    return inspect(winner);
  }
}
