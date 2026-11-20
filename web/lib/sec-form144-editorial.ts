import { normalizeCik, publicDate, secDocumentUrl } from "./public-normalization.ts";
import { REVIEWED_ISSUERS } from "./consensus/issuer-context.ts";
import { newYorkDate } from "./consensus/time.ts";
import type { EditorialEvidence, EditorialSource } from "../scripts/collect-editorial-evidence.ts";

export const FORM144_ISSUERS = { ...REVIEWED_ISSUERS, PLTR: { cik: "1321655" }, JPM: { cik: "19617" }, WMT: { cik: "104169" } };
type Stamp = { url: string; sha256: string; retrievedAt: string };
export type ProposedSale = { security: string; approxSaleDate: string; shares: number; marketValue: number };
export type OriginalNotice = { ticker: string; cik: string; accession: string; filingDate: string; acceptedAt: string;
  noticeDate: string; planAdoptionDates: string[]; proposals: ProposedSale[]; source: Stamp };
type NoticeData = Omit<OriginalNotice, "source"> & { cutoff: string; document: Stamp; catalog: Stamp };

const instant = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const day = (value: unknown): value is string => typeof value === "string" && publicDate(value) === value;
const safeAmount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const hasKeys = (value: unknown, keys: string[]) => value !== null && typeof value === "object" &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const stampKeys = ["url", "sha256", "retrievedAt"];
const sourceId = (ticker: string, accession: string) => `SEC144_${ticker}_${accession.replaceAll("-", "")}`;
const sourceTitle = (ticker: string, acceptedAt: string) => `${ticker} proposed sale · SEC Form 144 accepted ${newYorkDate(acceptedAt)}`;

export function validateForm144Source(source: EditorialSource): void {
  if (source.kind !== "sec_form144" && !source.id.startsWith("SEC144_")) return;
  const data = source.data as NoticeData | null;
  const invalid = () => { throw new Error("Invalid original SEC Form 144 editorial evidence"); };
  if (source.kind !== "sec_form144" || source.status !== "ok" || !data ||
      !hasKeys(data, ["ticker", "cik", "accession", "filingDate", "acceptedAt", "noticeDate", "planAdoptionDates", "proposals", "cutoff", "document", "catalog"]) ||
      !Object.hasOwn(FORM144_ISSUERS, data.ticker)) return invalid();
  const cik = normalizeCik(FORM144_ISSUERS[data.ticker as keyof typeof FORM144_ISSUERS].cik);
  if (data.cik !== cik || typeof data.accession !== "string" || !/^\d{10}-\d{2}-\d{6}$/.test(data.accession) ||
      source.id !== sourceId(data.ticker, data.accession) ||
      source.url !== secDocumentUrl(cik, data.accession, data.accession + "-index.htm") ||
      !instant(data.acceptedAt) || !instant(data.cutoff) || data.acceptedAt >= data.cutoff ||
      !day(data.filingDate) || data.filingDate > newYorkDate(data.cutoff) || !day(data.noticeDate) || data.noticeDate > data.filingDate ||
      source.observationDates.length !== 1 || source.observationDates[0] !== newYorkDate(data.acceptedAt) ||
      source.title !== sourceTitle(data.ticker, data.acceptedAt)) return invalid();
  for (const proof of [data.document, data.catalog]) {
    if (!hasKeys(proof, stampKeys) || !instant(proof.retrievedAt) || proof.retrievedAt < data.acceptedAt ||
        !/^[a-f0-9]{64}$/.test(proof.sha256) || typeof proof.url !== "string") return invalid();
  }
  const file = data.document.url.split("/").at(-1)!;
  if (!file.endsWith(".xml") || data.document.url !== secDocumentUrl(cik, data.accession, file) ||
      source.retrievalUrl !== data.document.url || data.catalog.retrievedAt < data.cutoff ||
      !new RegExp(`^https://data\\.sec\\.gov/submissions/CIK${cik}(?:-submissions-\\d+)?\\.json$`).test(data.catalog.url) ||
      source.retrievedAt !== [data.catalog.retrievedAt, data.document.retrievedAt].sort().at(-1) ||
      !Array.isArray(data.planAdoptionDates) || new Set(data.planAdoptionDates).size !== data.planAdoptionDates.length ||
      data.planAdoptionDates.some(value => !day(value) || value > data.noticeDate) ||
      !Array.isArray(data.proposals) || !data.proposals.length || data.proposals.length > 30 ||
      data.proposals.some(row => !hasKeys(row, ["security", "approxSaleDate", "shares", "marketValue"]) ||
        !day(row.approxSaleDate) || typeof row.security !== "string" || !row.security.trim() || row.security.length > 125 ||
        !safeAmount(row.shares) || !safeAmount(row.marketValue))) return invalid();
}

export function form144EditorialSource(notice: OriginalNotice, catalog: Stamp, cutoff: string): EditorialSource {
  const { ticker, cik, accession, filingDate, acceptedAt, noticeDate, planAdoptionDates, proposals, source: document } = notice;
  const source: EditorialSource = { id: sourceId(ticker, accession), kind: "sec_form144",
    title: sourceTitle(ticker, acceptedAt),
    url: secDocumentUrl(cik, accession, accession + "-index.htm")!, retrievalUrl: document.url,
    retrievedAt: [document.retrievedAt, catalog.retrievedAt].sort().at(-1)!,
    observationDates: [newYorkDate(acceptedAt)], status: "ok",
    data: { ticker, cik, accession, filingDate, acceptedAt, noticeDate, planAdoptionDates, proposals, cutoff,
      document: { url: document.url, retrievedAt: document.retrievedAt, sha256: document.sha256 },
      catalog: { url: catalog.url, retrievedAt: catalog.retrievedAt, sha256: catalog.sha256 } } satisfies NoticeData };
  validateForm144Source(source);
  return source;
}

export function attachForm144Sources(evidence: EditorialEvidence, notices: EditorialSource[] | null, assembledAt: string): EditorialEvidence {
  if (!instant(assembledAt) || assembledAt < evidence.collectedAt) throw new Error("Invalid evidence assembly time");
  const ordered = (notices ?? []).map(source => {
    validateForm144Source(source);
    if (source.kind !== "sec_form144" || source.retrievedAt > assembledAt) throw new Error("Invalid Form 144 collection time");
    return source;
  }).sort((a, b) => (b.data as NoticeData).acceptedAt.localeCompare((a.data as NoticeData).acceptedAt) || a.id.localeCompare(b.id));
  if (new Set(ordered.map(source => source.id)).size !== ordered.length) throw new Error("Duplicate SEC Form 144 accession");
  const newest = ordered.slice(0, Math.max(0, 30 - evidence.sources.length));
  const scope = notices === null ? "The Form 144 collection was unavailable for this preparation."
    : `The eight-issuer Form 144 check found ${ordered.length} original notices in the collection window. The evidence includes the ${newest.length} most recent. Each notice reports a proposed sale. EDGAR acceptance establishes when it became observable. Executions require a separate transaction report.`;
  return { ...evidence, collectedAt: assembledAt, sources: [...evidence.sources, ...newest], limitations: [...evidence.limitations, scope] };
}
