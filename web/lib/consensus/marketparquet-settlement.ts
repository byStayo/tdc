import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import type { CashDistribution } from "./corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { loadFirstRatePrices } from "./firstrate.ts";
import { digest } from "./history.ts";
import { collectKibotSeries, KIBOT_PRICE_CITATION, MAX_KIBOT_RANGE_MS, MAX_KIBOT_RESPONSE_BYTES, parseKibotDaily } from "./kibot.ts";
import { ETF_SYMBOLS, marketParquetEvidence, reconcileMarketParquet, type MarketParquetDay, type ReferenceBars } from "./marketparquet.ts";
import { readResearchReceipt } from "./research-price-capture.ts";

type ETF = typeof ETF_SYMBOLS[number];
const origin = "https://marketparquet.com";
const ssga = "https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary&product=etfs&ticker=";
const issuerUrls: Record<ETF, string> = {
  SPY: ssga + "SPY", DIA: ssga + "DIA",
  QQQ: "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103/distribution?idType=cusip&productType=ETF",
  IWM: "https://www.ishares.com/us/products/239710/ishare",
  TLT: "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd",
};
export type LicensedCapture = {
  entitlement: { source: string; capturedAt: string; document: string; sha256: string };
  downloads: { session: string; source: string; objectHost: string; authorizedAt: string; retrievedAt: string;
    size: number; sha256: string; authorizationSha256: string; pricesSha256: string }[];
};
type Issuer = { symbol: ETF; source: string; responseUrl: string; capturedAt: string; sha256: string; actionsSha256: string; cash: CashDistribution[] };
type Ledger = { schemaVersion: number; capturedAt: string; expectedSessions: string[]; bars: MarketParquetDay[];
  distributions: Issuer[]; licensedCapture: LicensedCapture };
type ControlResponses = { hashes: Record<string, string>; csv: Record<ETF, string> };
type ControlCapture = { source: string; capturedAt: string };
export type LicensedControlChunk = ControlResponses & { from: string; through: string; capturedAt: string };
export type LicensedSettlement = { mode: string; through: string; reconciledAt: string; ledgerSha256: string;
  ledgerText: string; earlyClosesVerified: string[] } & (
  { schemaVersion: 1; reference: ControlCapture & ControlResponses } |
  { schemaVersion: 2; reference: ControlCapture & { chunks: LicensedControlChunk[] } });
const CONTROL_CHUNK_SESSIONS = 120;
type Pointer = { schemaVersion: number; through: string; reviewedAt: string; sha256: string };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const ordered = (...clocks: string[]) => clocks.every((at, i) => instant(at) && (!i || clocks[i - 1] <= at));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keys = (set: object) => same(Object.keys(set).sort(), [...ETF_SYMBOLS].sort());

function extractedPrices(file: MarketParquetDay) {
  const bytes = Buffer.alloc(16 * ETF_SYMBOLS.length);
  [...ETF_SYMBOLS].sort().forEach((s, i) => {
    const bar = file.bars[s];
    if (!bar || !same(Object.keys(bar).sort(), ["close", "open"]) ||
        ![bar.open, bar.close].every(value => Number.isFinite(value) && value > 0))
      throw new Error("Invalid captured price fields");
    bytes.writeDoubleBE(bar.open, 16 * i);
    bytes.writeDoubleBE(bar.close, 16 * i + 8);
  });
  return hash(bytes);
}

function issuerLocation(issuer: Issuer) {
  if (issuer.source !== issuerUrls[issuer.symbol]) return false;
  if (issuer.responseUrl === issuer.source) return true;
  if (issuer.symbol !== "IWM" && issuer.symbol !== "TLT") return false;
  const final = new URL(issuer.responseUrl);
  const id = issuer.symbol === "IWM" ? "239710" : "239454";
  return final.origin === "https://www.ishares.com" && !final.username && !final.password && final.pathname.startsWith(`/us/products/${id}/`);
}

function issuerActionsHash(actions: CashDistribution[]) {
  const result = createHash("sha256");
  for (const row of actions) {
    const amount = Buffer.alloc(8);
    amount.writeDoubleBE(row.amount);
    result.update(row.session).update(amount);
  }
  return result.digest("hex");
}

export async function collectLicensedControls(dates: string[], fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
  if (!dates.length || !same(dates, exchangeSessions(dates[0], dates.at(-1)!)))
    throw new Error("Independent controls require the complete reviewed calendar");
  const chunks: LicensedControlChunk[] = [], reference = {} as ReferenceBars;
  for (const symbol of ETF_SYMBOLS) reference[symbol] = [];
  for (let start = 0; start < dates.length; start += CONTROL_CHUNK_SESSIONS) {
    const sessions = dates.slice(start, start + CONTROL_CHUNK_SESSIONS);
    const hashes: Record<string, string> = {}, csv = {} as Record<ETF, string>;
    for (const symbol of ETF_SYMBOLS) {
      const response = await collectKibotSeries(symbol, sessions, { unadjusted: true, fetcher,
        onVerifiedResponse: body => { csv[symbol] = body; } });
      reference[symbol].push(...response.sessions);
      hashes[symbol] = response.sha256;
    }
    chunks.push({ from: sessions[0], through: sessions.at(-1)!, capturedAt: new Date().toISOString(), hashes, csv });
  }
  return { chunks, reference };
}

function replayLicensedControls(review: LicensedSettlement, dates: string[], ledgerCapturedAt: string) {
  const control = review.reference;
  if (control.source !== KIBOT_PRICE_CITATION || !ordered(ledgerCapturedAt, control.capturedAt, review.reconciledAt))
    throw new Error("Invalid independent as-traded reference");
  const chunks = review.schemaVersion === 1
    ? [{ ...review.reference, from: dates[0], through: dates.at(-1)! }]
    : review.reference.chunks;
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > dates.length) throw new Error("Missing independent control chunks");
  const reference = {} as ReferenceBars;
  for (const symbol of ETF_SYMBOLS) reference[symbol] = [];
  let start = 0, precedingCapture = ledgerCapturedAt;
  for (const chunk of chunks) {
    const end = dates.indexOf(chunk.through, start);
    if (dates[start] !== chunk.from || end < start || Date.parse(chunk.through) - Date.parse(chunk.from) > MAX_KIBOT_RANGE_MS ||
        (review.schemaVersion === 2 && end - start + 1 > CONTROL_CHUNK_SESSIONS) || !keys(chunk.hashes) || !keys(chunk.csv) ||
        !ordered(precedingCapture, chunk.capturedAt, control.capturedAt))
      throw new Error("Independent control windows or capture times do not match the reviewed calendar");
    const sessions = dates.slice(start, end + 1);
    for (const symbol of ETF_SYMBOLS) {
      const csv = chunk.csv[symbol];
      if (typeof csv !== "string" || Buffer.byteLength(csv) > MAX_KIBOT_RESPONSE_BYTES || hash(csv) !== chunk.hashes[symbol])
        throw new Error("Independent reference differs from its capture");
      reference[symbol].push(...parseKibotDaily(csv, sessions));
    }
    start = end + 1;
    precedingCapture = chunk.capturedAt;
  }
  if (start !== dates.length) throw new Error("Independent control does not cover the final reviewed session");
  return reference;
}

export function licensedSettlementPrices(review: LicensedSettlement, asOf: string) {
  if (![1, 2].includes(review.schemaVersion) || review.mode !== "licensed" || typeof review.ledgerText !== "string" ||
      hash(review.ledgerText) !== review.ledgerSha256) throw new Error("Invalid licensed ledger fingerprint");
  const ledger: Ledger = JSON.parse(review.ledgerText);
  const dates = ledger.expectedSessions, first = dates[0], through = review.through;
  const close = exchangeSession(through)?.closeAt;
  if (ledger.schemaVersion !== 1 || !close || !same(dates, exchangeSessions(first, through)) || dates.at(-1) !== through ||
      !same(ledger.bars.map(row => row.session), dates) || !ordered(close, ledger.capturedAt, review.reconciledAt, asOf))
    throw new Error("Invalid licensed capture calendar or review time");

  const { entitlement, downloads } = ledger.licensedCapture;
  if (entitlement.source !== origin + "/api/v1/assets" || typeof entitlement.document !== "string" ||
      Buffer.byteLength(entitlement.document) > 128_000 || hash(entitlement.document) !== entitlement.sha256 ||
      !ordered(close, entitlement.capturedAt, ledger.capturedAt)) throw new Error("Invalid archive entitlement capture");
  const grant = JSON.parse(entitlement.document);
  if (grant.plan !== "full" || !Array.isArray(grant.assets) ||
      !grant.assets.some((asset: { asset_type?: string; access?: string }) => asset?.asset_type === "etf_daily" && asset.access === "full") ||
      !same(downloads.map(row => row.session), dates))
    throw new Error("Missing authenticated daily archive entitlement or downloads");
  for (const [i, file] of ledger.bars.entries()) {
    const download = downloads[i];
    if (download.source !== `${origin}/api/v1/download/etf_daily/${file.session}` ||
        !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(download.objectHost) ||
        !Number.isSafeInteger(download.size) || download.size < 8 || download.size > 4_000_000 ||
        !sha(file.sha256) || !sha(download.authorizationSha256) || file.sha256 !== download.sha256 ||
        !ordered(entitlement.capturedAt, download.authorizedAt, download.retrievedAt, ledger.capturedAt) ||
        !keys(file.bars) || extractedPrices(file) !== download.pricesSha256)
      throw new Error("Licensed download differs from its authorized capture");
  }
  if (!same(ledger.distributions.map(row => row.symbol).sort(), [...ETF_SYMBOLS].sort()) ||
      ledger.distributions.some(row => !sha(row.sha256) || !issuerLocation(row) ||
        !ordered(entitlement.capturedAt, row.capturedAt, ledger.capturedAt) || !Array.isArray(row.cash) ||
        new Set(row.cash.map(action => action.session)).size !== row.cash.length ||
        row.cash.some(action => !/^\d{4}-\d\d-\d\d$/.test(action.session) || !Number.isFinite(action.amount) || action.amount <= 0) ||
        issuerActionsHash(row.cash) !== row.actionsSha256))
    throw new Error("Invalid primary issuer capture");
  const cash = Object.fromEntries(ledger.distributions.map(row =>
    [row.symbol, row.cash.filter(action => action.session >= first && action.session <= through)])) as Record<ETF, CashDistribution[]>;
  const reference = replayLicensedControls(review, dates, ledger.capturedAt);
  const checked = reconcileMarketParquet(dates, ledger.bars, cash, reference, { openBps: 3, closeBps: 15 }, { requireDirection: true });
  if (!checked.passed || checked.verifiedThrough !== through || !same(checked.earlyClosesVerified, review.earlyClosesVerified))
    throw new Error("Licensed prices, distribution boundaries or scheduled closes did not reconcile");
  return marketParquetEvidence(dates, ledger.bars, cash);
}

/** Called only after an operator records a passing paid-source reconciliation under the publication lock. */
export async function recordLicensedSettlement(directory: string, receipt: LicensedSettlement, asOf: string) {
  licensedSettlementPrices(receipt, asOf);
  const sha256 = digest(receipt), store = resolve(directory, "settlements"), file = resolve(store, sha256 + ".json");
  const pointerPath = resolve(directory, "settlement-review.json");
  const latest = await readResearchReceipt<Pointer>(pointerPath);
  if (latest && (latest.through > receipt.through || latest.reviewedAt > receipt.reconciledAt))
    throw new Error("An older MarketParquet review cannot replace a later settlement");
  await durableDirectory(store, 0o700);
  const prior = await readResearchReceipt<LicensedSettlement>(file);
  if (prior && digest(prior) !== sha256) throw new Error("A saved settlement receipt changed");
  if (!prior) await durableJSON(file, receipt, true);
  await durableJSON(pointerPath,
    { schemaVersion: 1, through: receipt.through, reviewedAt: receipt.reconciledAt, sha256 } satisfies Pointer);
}

export async function loadLicensedSettlement(root: string, asOf: string) {
  const directory = resolve(root, ".consensus/private-marketparquet");
  const pointer = await readResearchReceipt<Pointer>(resolve(directory, "settlement-review.json"));
  if (!pointer) return [];
  if (pointer.schemaVersion !== 1 || !sha(pointer.sha256)) throw new Error("Invalid settlement pointer");
  const receipt = await readResearchReceipt<LicensedSettlement>(resolve(directory, "settlements", pointer.sha256 + ".json"));
  if (!receipt || digest(receipt) !== pointer.sha256 || receipt.through !== pointer.through || receipt.reconciledAt !== pointer.reviewedAt)
    throw new Error("Private settlement differs from its reviewed fingerprint");
  return licensedSettlementPrices(receipt, asOf);
}

export async function defaultEvaluationPrices(root: string, asOf: string, warn: (message: string) => void = console.error) {
  const firstRate = await loadFirstRatePrices(root);
  try { return [...firstRate, ...await loadLicensedSettlement(root, asOf)]; }
  catch {
    warn("Licensed MarketParquet settlement withheld. Its private capture or independent reconciliation could not be verified.");
    return firstRate;
  }
}
