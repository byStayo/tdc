import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import type { CashDistribution } from "./corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { loadFirstRatePrices } from "./firstrate.ts";
import { digest } from "./history.ts";
import { KIBOT_PRICE_CITATION, parseKibotDaily } from "./kibot.ts";
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
export type LicensedSettlement = { schemaVersion: number; mode: string; through: string; reconciledAt: string; ledgerSha256: string;
  ledgerText: string; earlyClosesVerified: string[]; reference: { source: string; capturedAt: string;
    hashes: Record<string, string>; csv: Record<ETF, string> } };
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

export function licensedSettlementPrices(review: LicensedSettlement, asOf: string) {
  if (review.schemaVersion !== 1 || review.mode !== "licensed" || typeof review.ledgerText !== "string" ||
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
  const control = review.reference;
  if (control.source !== KIBOT_PRICE_CITATION || !ordered(ledger.capturedAt, control.capturedAt, review.reconciledAt) ||
      !keys(control.hashes) || !keys(control.csv)) throw new Error("Invalid independent as-traded reference");
  const reference = {} as ReferenceBars;
  for (const symbol of ETF_SYMBOLS) {
    const csv = control.csv[symbol];
    if (typeof csv !== "string" || Buffer.byteLength(csv) > 65_536 || hash(csv) !== control.hashes[symbol])
      throw new Error("Independent reference differs from its capture");
    reference[symbol] = parseKibotDaily(csv, dates);
  }
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
