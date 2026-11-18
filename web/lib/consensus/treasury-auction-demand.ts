import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";

export const TREASURY_AUCTION_DATASET = "https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/";
const LEGACY_QUERY = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
const RESULT_DIRECTORY = "https://www.treasurydirect.gov/xml/";
const FIRST_RESEARCH_DATE = "2022-01-01";
const LAST_RESEARCH_DATE = "2025-12-31";
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 96 * 1024;
const PAGE_SIZE = 200;

const fields = [
  "record_date", "cusip", "security_type", "security_term", "original_security_term",
  "auction_date", "issue_date", "closing_time_comp", "reopening", "inflation_index_security",
  "bid_to_cover_ratio", "comp_accepted", "indirect_bidder_accepted", "direct_bidder_accepted",
  "primary_dealer_accepted", "xml_filenm_comp_results",
] as const;

type AuctionTenor = 10 | 20 | 30;
type CatalogRow = Record<typeof fields[number], string>;
export interface TreasuryAuctionDocument {
  body: string;
  retrievedAt: string;
  url: string;
  lastModified?: string | null;
}
type DocumentSource = { url: string; sha256: string; retrievedAt: string };

export interface TreasuryAuctionDemand {
  auctionDate: string;
  issueDate: string;
  cusip: string;
  tenor: AuctionTenor;
  securityTerm: string;
  reopened: boolean;
  competitiveCloseAt: string;
  competitiveAccepted: number;
  indirectAccepted: number;
  directAccepted: number;
  dealerAccepted: number;
  indirectShare: number;
  bidToCoverRatio: number;
  datasetRecordDate: string;
  resultXmlUrl: string | null;
  source: DocumentSource;
  release: { status: "dated-only"; source?: DocumentSource } |
    { status: "timestamped"; availableAt: string; basis: "xml-release-minute" | "result-last-modified"; source: DocumentSource };
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && publicDate(value) === value;
}

function isoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function localAuctionTime(day: string, time: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error("Invalid Treasury auction time");
  const result = newYorkTimestamp(day.replaceAll("-", "") + "T" + match[1] + match[2] + "00");
  if (!result) throw new Error("Invalid Treasury auction local timestamp");
  return result;
}

function closeAt(day: string, value: string) {
  const match = /^(0[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/.exec(value);
  if (!match) throw new Error("Invalid Treasury competitive closing time");
  const hour = (Number(match[1]) % 12 + (match[3] === "PM" ? 12 : 0)).toString().padStart(2, "0");
  return localAuctionTime(day, hour + ":" + match[2]);
}

function amount(value: string) {
  if (!/^(0|[1-9]\d*)(?:\.0+)?$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid Treasury auction par amount");
  return Number(value);
}

function ratio(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0)
    throw new Error("Invalid Treasury auction bid-to-cover ratio");
  return Number(value);
}

export function treasuryAuctionDemandUrl(from: string, through: string) {
  if (!isoDate(from) || !isoDate(through) || from < FIRST_RESEARCH_DATE ||
      through > LAST_RESEARCH_DATE || through < from)
    throw new Error("Treasury auction research range must be within 2022–2025");
  const url = new URL(LEGACY_QUERY);
  url.search = new URLSearchParams({
    fields: fields.join(","),
    filter: `auction_date:gte:${from},auction_date:lte:${through},inflation_index_security:eq:No,original_security_term:in:(10-Year,20-Year,30-Year)`,
    sort: "auction_date,cusip,issue_date",
    "page[size]": PAGE_SIZE.toString(),
  }).toString();
  return url.href;
}

class TreasurySourceHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Treasury source returned HTTP ${status}`);
    this.status = status;
  }
}

async function readDocument(url: string, maximumBytes: number, fetchDocument = fetch): Promise<TreasuryAuctionDocument> {
  const response = await fetchDocument(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "The Daily Consensus research support@thedailyconsensus.com" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new TreasurySourceHttpError(response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("Treasury document exceeds the response limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return {
    url: response.url,
    retrievedAt: new Date().toISOString(),
    lastModified: response.headers.get("Last-Modified"),
    body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)),
  };
}

function documentSource(document: TreasuryAuctionDocument, expectedUrl: string, maximumBytes: number): DocumentSource {
  if (document.url !== expectedUrl || !isoInstant(document.retrievedAt) ||
      typeof document.body !== "string" || Buffer.byteLength(document.body) > maximumBytes)
    throw new Error("Invalid Treasury document source or size");
  return {
    url: document.url, retrievedAt: document.retrievedAt,
    sha256: createHash("sha256").update(document.body).digest("hex"),
  };
}

export function parseTreasuryAuctionDemand(
  body: string, from: string, through: string, source: Omit<TreasuryAuctionDocument, "body">,
): TreasuryAuctionDemand[] {
  const provenance = documentSource({ ...source, body }, treasuryAuctionDemandUrl(from, through), MAX_CATALOG_BYTES);
  const catalog = JSON.parse(body.trim()) as {
    data?: CatalogRow[];
    meta?: { count?: number; "total-count"?: number; "total-pages"?: number };
  };
  if (!Array.isArray(catalog?.data) || !catalog.data.length || catalog.data.length > PAGE_SIZE ||
      catalog.meta?.count !== catalog.data.length || catalog.meta["total-count"] !== catalog.data.length ||
      catalog.meta["total-pages"] !== 1)
    throw new Error("Incomplete Treasury auction catalog page");
  const seen = new Set<string>();
  return catalog.data.map(row => {
    if (!row || fields.some(field => typeof row[field] !== "string"))
      throw new Error("Incomplete Treasury auction row");
    const date = row.auction_date;
    const tenor = Number(/^((?:10|20|30))-Year$/.exec(row.original_security_term)?.[1]) as AuctionTenor;
    const reopened = row.reopening === "Yes";
    if (!isoDate(date) || date < from || date > through || !isoDate(row.issue_date) ||
        row.issue_date < date || !isoDate(row.record_date) || row.record_date < date ||
        !/^[0-9A-Z]{9}$/.test(row.cusip) || ![10, 20, 30].includes(tenor) ||
        row.security_type !== (tenor === 10 ? "Note" : "Bond") ||
        row.inflation_index_security !== "No" || (!reopened && row.reopening !== "No") ||
        !/^\d+-Year(?: \d+-Month)?$/.test(row.security_term) ||
        (!reopened && row.security_term !== row.original_security_term))
      throw new Error("Treasury auction identity is invalid or outside the nominal tenor scope");
    const key = `${date}:${row.cusip}:${row.issue_date}`;
    if (seen.has(key)) throw new Error("Duplicate Treasury auction");
    seen.add(key);
    const competitiveAccepted = amount(row.comp_accepted);
    const indirectAccepted = amount(row.indirect_bidder_accepted);
    const directAccepted = amount(row.direct_bidder_accepted);
    const dealerAccepted = amount(row.primary_dealer_accepted);
    if (!competitiveAccepted || indirectAccepted + directAccepted + dealerAccepted !== competitiveAccepted)
      throw new Error("Treasury auction awards fail competitive total reconciliation");
    const resultName = row.xml_filenm_comp_results;
    const prefix = "R_" + date.replaceAll("-", "") + "_";
    if (resultName !== "null" && (!resultName.startsWith(prefix) || !/^R_\d{8}_[1-9]\d*\.xml$/.test(resultName)))
      throw new Error("Treasury result filename differs from the auction date or format");
    return {
      auctionDate: date, issueDate: row.issue_date, cusip: row.cusip, tenor,
      securityTerm: row.security_term, reopened,
      competitiveCloseAt: closeAt(date, row.closing_time_comp),
      competitiveAccepted, indirectAccepted, directAccepted, dealerAccepted,
      indirectShare: indirectAccepted / competitiveAccepted, bidToCoverRatio: ratio(row.bid_to_cover_ratio),
      datasetRecordDate: row.record_date, resultXmlUrl: resultName === "null" ? null : RESULT_DIRECTORY + resultName,
      source: provenance, release: { status: "dated-only" as const },
    };
  }).sort((a, b) => a.auctionDate.localeCompare(b.auctionDate) || a.cusip.localeCompare(b.cusip));
}

export async function collectTreasuryAuctionDemand(
  from: string, through: string, read: (url: string) => Promise<TreasuryAuctionDocument> =
    url => readDocument(url, MAX_CATALOG_BYTES),
): Promise<TreasuryAuctionDemand[]> {
  const source = await read(treasuryAuctionDemandUrl(from, through));
  return parseTreasuryAuctionDemand(source.body, from, through, source);
}

function tags(xml: string, name: string) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^<>]*)?>([\\s\\S]*?)</${name}>`, "g"))]
    .map(match => match[1].trim());
}

function tag(xml: string, name: string, required = true) {
  const values = tags(xml, name);
  if (!required && values.length === 0) return null;
  if (values.length !== 1 || !values[0]) throw new Error(`Missing or ambiguous Treasury XML ${name}`);
  return values[0];
}

export function verifyTreasuryAuctionRelease(
  auction: TreasuryAuctionDemand, receipt: TreasuryAuctionDocument,
): TreasuryAuctionDemand {
  const source = documentSource(receipt, requireResultUrl(auction), MAX_RESULT_BYTES);
  const xml = receipt.body.replace(/^\s*(?:<\?xml(?:-|\s)[\s\S]*?\?>\s*)*/, "").trim();
  const root = /^<(td:)?AuctionData\b([^<>]*)>/.exec(xml);
  const treasuryNamespace = root?.[1] ? /\sxmlns:td=["']http:\/\/www\.treasurydirect\.gov\/["']/ :
    /\sxmlns=["']http:\/\/www\.treasurydirect\.gov\/["']/;
  if (!root || !treasuryNamespace.test(root[2]) ||
      !xml.endsWith("</" + (root[1] ?? "") + "AuctionData>") || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml))
    throw new Error("Unexpected Treasury legacy result XML format");
  const announcement = tag(xml, "AuctionAnnouncement")!;
  const results = tag(xml, "AuctionResults")!;
  if (tag(announcement, "CUSIP") !== auction.cusip ||
      tag(announcement, "AuctionDate") !== auction.auctionDate ||
      tag(announcement, "IssueDate") !== auction.issueDate ||
      localAuctionTime(auction.auctionDate, tag(announcement, "CompetitiveClosingTime")!) !== auction.competitiveCloseAt ||
      amount(tag(results, "CompetitiveAccepted")!) !== auction.competitiveAccepted ||
      amount(tag(results, "PrimaryDealerAccepted")!) !== auction.dealerAccepted ||
      amount(tag(results, "IndirectBidderAccepted")!) !== auction.indirectAccepted ||
      amount(tag(results, "DirectBidderAccepted")!) !== auction.directAccepted ||
      ratio(tag(results, "BidToCoverRatio")!) !== auction.bidToCoverRatio)
    throw new Error("Treasury primary result disagrees with the catalog row");

  const resultMinute = tag(results, "ReleaseTime", false);
  let availableAt: string | undefined;
  let basis: "xml-release-minute" | "result-last-modified" = "xml-release-minute";
  if (resultMinute) {
    const reportedAt = localAuctionTime(auction.auctionDate, resultMinute);
    if (reportedAt < auction.competitiveCloseAt) throw new Error("Treasury result is dated before auction close");
    // The archive reports minute precision. Do not assume an earlier second.
    availableAt = new Date(Date.parse(reportedAt) + 60_000).toISOString();
  }
  if (receipt.lastModified && Number.isFinite(Date.parse(receipt.lastModified))) {
    const modified = new Date(receipt.lastModified).toISOString();
    // Historical documents may have been migrated. Only a same-day timestamp
    // after the competitive close can corroborate the initial release window.
    if (newYorkDate(modified) === auction.auctionDate && modified >= auction.competitiveCloseAt &&
        (!availableAt || modified > availableAt)) {
      availableAt = modified;
      basis = "result-last-modified";
    }
  }
  if (availableAt && availableAt > receipt.retrievedAt)
    throw new Error("Treasury receipt predates the evidenced release");
  return {
    ...auction,
    release: availableAt ? { status: "timestamped", availableAt, basis, source } : { status: "dated-only", source },
  };
}

function requireResultUrl(auction: TreasuryAuctionDemand) {
  const url = auction.resultXmlUrl;
  if (!url || !/^https:\/\/www\.treasurydirect\.gov\/xml\/R_\d{8}_[1-9]\d*\.xml$/.test(url) ||
      !url.startsWith(RESULT_DIRECTORY + "R_" + auction.auctionDate.replaceAll("-", "") + "_"))
    throw new Error("Treasury auction has no supported result XML");
  return url;
}

export async function collectTreasuryAuctionRelease(auction: TreasuryAuctionDemand, fetchDocument = fetch) {
  if (!auction.resultXmlUrl) return auction;
  const url = requireResultUrl(auction);
  try {
    const receipt = await readDocument(url, MAX_RESULT_BYTES, fetchDocument);
    return verifyTreasuryAuctionRelease(auction, receipt);
  } catch (error) {
    if (error instanceof TreasurySourceHttpError && error.status === 404) return auction;
    throw error;
  }
}
