import { createHash } from "node:crypto";
import { join } from "node:path";
import { immutableSourceReceipt } from "../publication-storage.ts";
import type { PublicDocument } from "./calendars.ts";
import type { Signal } from "./types.ts";

export const FLOW_FUNDS = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
type Fund = typeof FLOW_FUNDS[number];
type Category = "Stocks" | "Bonds";
type Peer = [ticker: string, direction: number];
type VerifiedRow = { ticker: string; category: Category | null; status: string; flowUsd: number | null; flowPct: number | null; navDate: string | null };
type Amount = { fund: Fund; category: Category; usd: number; percent: number; navDate: string };
type Basket = { asOf: string; sha256: string; peers: Record<Category, Peer[]>; funds: Amount[] };
type Confirmation = { fund: Fund; asOf: string; navDate: string; usd: number; sha256: string };
type Capture<T> = { value: T; at: string };
export type FlowPeers = { category: Category; creations: number; redemptions: number; flat: number; navDate: string;
  url: string; historySha256: string; observedThrough: string; seal: string };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hashPattern = /^[0-9a-f]{64}$/;
const categoryFor = (fund: Fund): Category => fund === "TLT" ? "Bonds" : "Stocks";
const historyURL = (fund: Fund) => "https://etfiq.com/data/flows/funds/" + fund.toLowerCase() + ".json";
const issuers: Record<Fund, [issuer: string, series: string | null]> = {
  SPY: ["State Street", null], QQQ: ["Invesco", "S000101292"], IWM: ["iShares", "S000004344"],
  DIA: ["State Street", null], TLT: ["iShares", "S000004360"],
};
const dailyKeys = new Set(["d", "flow", "navDate", "src", "house", "status", "held", "spans", "spansSessions",
  "spanDays", "why", "heartbeat", "split"]);
const directory = (root: string, sha: string) => join(root, ".consensus/private-etfiq-flow-peers/v1", sha);
function checkedPath(root: string, sha: string) {
  if (!hashPattern.test(sha)) throw Error("Invalid ETFIQ aggregate hash");
  return directory(root, sha);
}
function ensureDocument(doc: PublicDocument, cutoff: string) {
  if (!canonical(doc.retrievedAt) || doc.retrievedAt > cutoff || hash(doc.text) !== doc.sha256)
    throw Error("Unverified ETFIQ response clock or bytes");
}

/** Keep only permitted computed flows, signs, categories and observation identities. */
function project(asOf: string, sha256: string, rows: VerifiedRow[]): Basket {
  const peers: Record<Category, Peer[]> = { Stocks: [], Bonds: [] };
  const funds: Amount[] = [];
  for (const row of rows) {
    if (row.status !== "ok" || !row.category || row.flowUsd === null) continue;
    peers[row.category].push([row.ticker, Math.sign(row.flowUsd)]);
    const fund = FLOW_FUNDS.find(symbol => symbol === row.ticker);
    if (fund && row.category === categoryFor(fund) && row.navDate && row.flowPct !== null)
      funds.push({ fund, category: row.category, usd: row.flowUsd, percent: row.flowPct, navDate: row.navDate });
  }
  for (const peersOfCategory of Object.values(peers)) peersOfCategory.sort(([a], [b]) => a.localeCompare(b, "en"));
  return { asOf, sha256, peers, funds };
}

function matchHistory(doc: PublicDocument, asOf: string, row: Amount, license: string) {
  if (Buffer.byteLength(doc.text) > 700_000) throw Error("Oversized ETFIQ fund history");
  const body = JSON.parse(doc.text);
  const [issuer, series] = issuers[row.fund];
  if (body?.schemaVersion !== 3 || body.ticker !== row.fund || body.category !== row.category ||
    body.issuer !== issuer || body.seriesId !== series || body.coverage !== "daily" ||
    body.asOf !== asOf || body.cite?.publisher !== "ETFIQ" || body.cite.class !== "ETFIQ-computed" ||
    body.cite.license !== license || body.cite.as_of !== asOf ||
    body.cite.page !== "https://etfiq.com/funds/" + row.fund.toLowerCase() ||
    !Array.isArray(body.daily) || body.daily.length > 5000)
    throw Error("ETFIQ fund history has a different identity, licence or vintage");
  const matches = body.daily.filter((day: { d?: unknown } | null) => day?.d === asOf);
  const day = matches[0];
  if (matches.length !== 1 || day.flow !== row.usd || day.navDate !== row.navDate || day.house !== issuer ||
    body.daily.filter((item: {navDate?: unknown} | null) => item?.navDate === row.navDate).length !== 1 ||
    !["history", "capture"].includes(day.src) || Object.keys(day).some(key => !dailyKeys.has(key)) ||
    day.held || day.spans || day.spansSessions || (day.spanDays !== undefined && day.spanDays !== 1) ||
    (day.why != null && day.why !== "") || (day.status !== undefined && day.status !== "ok"))
    throw Error("ETFIQ fund history disagrees with its single-session aggregate");
  return { fund: row.fund, asOf, navDate: day.navDate as string, usd: day.flow as number, sha256: doc.sha256 };
}

async function save<T>(path: string, name: string, value: T, at: string, now: string) {
  return immutableSourceReceipt<Capture<T>>(path, name, async () => ({ value, at }), saved => {
    if (!canonical(saved.at) || saved.at > now || JSON.stringify(saved.value) !== JSON.stringify(value))
      throw Error("ETFIQ source receipt differs from the verified response");
  });
}

function evidence(basket: Capture<Basket>, history: Capture<Confirmation>, amount: Amount): FlowPeers {
  const fund = amount.fund;
  const confirmations = history.value;
  if (confirmations.fund !== fund || confirmations.asOf !== basket.value.asOf || confirmations.usd !== amount.usd ||
      confirmations.navDate !== amount.navDate || amount.category !== categoryFor(fund)) throw Error("Inconsistent flow receipts");
  let creations = 0, redemptions = 0, flat = 0, self = 0;
  for (const [ticker, sign] of basket.value.peers[amount.category]) {
    if (ticker === fund) {
      if (sign !== Math.sign(amount.usd)) throw Error("Own ETFIQ flow sign differs");
      self++;
    } else if (sign === 1) creations++;
    else if (sign === -1) redemptions++;
    else if (sign === 0) flat++;
    else throw Error("Invalid peer flow sign");
  }
  if (self !== 1 || creations + redemptions + flat === 0) throw Error("No verified ETFIQ comparison group");
  return { category: amount.category, creations, redemptions, flat, navDate: amount.navDate, url: historyURL(fund),
    historySha256: confirmations.sha256, observedThrough: basket.at > history.at ? basket.at : history.at,
    seal: hash(JSON.stringify([basket, history])) };
}

export async function captureFlowPeers(root: string, doc: PublicDocument, asOf: string, rows: VerifiedRow[],
  read: (url: string) => Promise<PublicDocument>, license: string, now: () => string) {
  ensureDocument(doc, now());
  const path = checkedPath(root, doc.sha256), projection = project(asOf, doc.sha256, rows);
  const basket = await save(path, "aggregate.json", projection, doc.retrievedAt, now());
  const results = await Promise.allSettled(projection.funds.map(async row => {
    const history = await read(historyURL(row.fund));
    ensureDocument(history, now());
    const matched = matchHistory(history, asOf, row, license);
    const saved = await save(path, row.fund + "-" + history.sha256 + ".json", matched, history.retrievedAt, now());
    return [row.fund, evidence(basket, saved, row)] as const;
  }));
  const verified = new Map<Fund, FlowPeers>();
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") verified.set(...result.value);
    else console.warn("ETFIQ peer comparison unavailable for", projection.funds[index].fund, String(result.reason));
  }
  return verified;
}

export function validateFlowPeers(signal: Signal, cutoff: string) {
  const p = signal.etfFlowPeers;
  if (p === undefined) return;
  const fund = FLOW_FUNDS.find(ticker => signal.id === "etfiq-flow-" + ticker);
  if (!p || !fund || signal.status !== "available" || !signal.source.observedAt || !signal.source.sha256 ||
    Object.keys(p).sort().join() !== "category,creations,flat,historySha256,navDate,observedThrough,redemptions,seal,url" ||
    p.category !== categoryFor(fund) || p.url !== historyURL(fund) || !hashPattern.test(p.historySha256) || !hashPattern.test(p.seal) ||
    !canonical(p.observedThrough) || p.observedThrough > cutoff || p.observedThrough.slice(0,10) < signal.source.observedAt ||
    typeof p.navDate !== "string" || !canonical(p.navDate + "T00:00:00.000Z") || p.navDate > signal.source.observedAt ||
    ![p.creations, p.redemptions, p.flat].every(n => Number.isSafeInteger(n) && n >= 0) ||
    p.creations + p.redemptions + p.flat < 1 || p.creations + p.redemptions + p.flat >= 20_000 ||
    !signal.metrics.some(m => m.label === "Flow / previous net assets" && m.unit === "%"))
    throw Error("Invalid saved ETFIQ peer comparison");
}

/** Replay both privately sealed projections and match the as-issued public commitment. */
export async function replayFlowPeers(root: string, signal: Signal, fund: Fund, cutoff: string) {
  validateFlowPeers(signal, cutoff);
  const p = signal.etfFlowPeers;
  if (!p || signal.id !== "etfiq-flow-" + fund || !signal.source.sha256) throw Error("Missing as-issued ETFIQ comparison");
  const { readResearchReceipt } = await import("./research-price-capture.ts");
  const path = checkedPath(root, signal.source.sha256);
  const [basket, history] = await Promise.all([
    readResearchReceipt<Capture<Basket>>(join(path, "aggregate.json")),
    readResearchReceipt<Capture<Confirmation>>(join(path, fund + "-" + p.historySha256 + ".json")),
  ]);
  const row = basket?.value.funds.find(amount => amount.fund === fund);
  if (!basket || !history || !row || !canonical(basket.at) || !canonical(history.at) ||
    basket.value.sha256 !== signal.source.sha256 || basket.value.asOf !== signal.source.observedAt ||
    row.usd !== signal.series[0]?.value || row.percent !== signal.metrics.find(m => m.label === "Flow / previous net assets")?.value ||
    JSON.stringify(evidence(basket, history, row)) !== JSON.stringify(p))
    throw Error("ETFIQ private receipts differ from the issued comparison");
  return { candidate: row.percent, control: (p.creations - p.redemptions) / (p.creations + p.redemptions + p.flat) };
}
