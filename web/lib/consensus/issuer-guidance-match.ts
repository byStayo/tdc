import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicDate, secDocumentUrl } from "../public-normalization.ts";
import { REVIEWED_ISSUERS } from "./issuer-context.ts";
import { REVENUE_ISSUERS, filingIndex, matchGuidedQuarter, readIssuerReportedRevenue, readIssuerRevenue, resultsFilings, type RevenueIssuer, type ResultsFiling } from "./issuer-revenue.ts";
import { immutableSecReceipt, originalExhibit, verifySecDocument, type SecDocument, type SecReader } from "./issuer-results-source.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

type FilingProof = { accession: string; acceptedAt: string; filed: string; indexSHA256: string; url: string; sha256: string };
type FiledComparison = {
  ticker: RevenueIssuer; year: number; quarter: number; start: string; end: string;
  lowMillions: number; midpointMillions: number; highMillions: number; actualMillions: number;
  guidance: FilingProof; results: FilingProof; quarterly: FilingProof;
};
export type IssuerGuidanceMatch = FiledComparison & { firstEvidenceCompleteAt: string; publiclyKnownBy: string };
const METHOD = "Compares the original management revenue range with consolidated US GAAP revenue for the same fiscal quarter. Two SEC earnings exhibits establish guidance and reported revenue. The entity-wide USD fact in a separate Form 10-Q must match the reported amount. EDGAR supplies a filing day for public release. The end of that New York day or an earlier verified public capture bounds availability.";
const LIMIT = "This comparison covers one issuer. Independent analyst estimates and ETF returns require separate evidence.";
const ONE_DAY = 86_400_000, STALE_DAYS = 150;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const instant = (s: string) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const id = (ticker: RevenueIssuer) => `sec-issuer-guidance-${ticker.toLowerCase()}`;
const catalogURL = (ticker: RevenueIssuer) => `https://data.sec.gov/submissions/CIK${REVIEWED_ISSUERS[ticker].cik.padStart(10, "0")}.json`;
const nextDay = (day: string) => new Date(Date.parse(day) + ONE_DAY).toISOString().slice(0, 10);
const filingDay = (e: FiledComparison) => [e.guidance.filed, e.results.filed, e.quarterly.filed].sort().at(-1)!;
const eastern = (day: string, clock: string) => newYorkTimestamp(day.replaceAll("-", "") + "T" + clock)!;
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const quarterParser = fileURLToPath(new URL("../../scripts/read-issuer-quarter.py", import.meta.url));
class FilingReviewError extends Error {}

function exactKeys(value: object, keys: string) {
  return !!value && typeof value === "object" && Object.keys(value).sort().join(" ") === keys.split(" ").sort().join(" ");
}
function validFilingClock(acceptedAt: string, filed: string) {
  if (!instant(acceptedAt) || publicDate(filed) !== filed) return false;
  const lag = (Date.parse(filed) - Date.parse(newYorkDate(acceptedAt))) / ONE_DAY;
  return lag >= 0 && lag <= 7 && ![0,6].includes(new Date(filed).getUTCDay());
}
function earliestReceiptTime(acceptedAt: string, filed: string) {
  return filed > newYorkDate(acceptedAt) ? eastern(filed, "060000") : acceptedAt;
}
function withCapture(e: FiledComparison, firstEvidenceCompleteAt: string): IssuerGuidanceMatch {
  const afterFiledDay = eastern(nextDay(filingDay(e)), "000000");
  return { ...e, firstEvidenceCompleteAt, publiclyKnownBy: [afterFiledDay, firstEvidenceCompleteAt].sort()[0] };
}

function baseline(ticker: RevenueIssuer, checked: string): Signal {
  return { id: id(ticker), family: "earnings", title: `${ticker} · revenue against management guidance`, shortLabel: `${ticker} management range`,
    instruments: [...REVIEWED_ISSUERS[ticker].instruments], directionalInstruments: [], status: "unavailable",
    summary: `The latest ${ticker} quarter has no verified comparison.`, unit: "$m", staleAfterDays: STALE_DAYS,
    source: { name: `SEC EDGAR · ${ticker} filed revenue and management guidance`, url: catalogURL(ticker), frequency: "quarterly",
      attribution: `${REVIEWED_ISSUERS[ticker].name} filings on SEC EDGAR`, usage: "Factual amounts derived from cited public filings.",
      observedAt: null, releasedAt: null, retrievedAt: checked, sha256: null },
    methodology: METHOD, limitation: LIMIT, scores: { daily: null, weekly: null, monthly: null }, series: [], metrics: [] };
}

function published(ticker: RevenueIssuer, evidence: IssuerGuidanceMatch, checked: string): Signal {
  const base = baseline(ticker, checked), e = evidence, period = `FY${e.year} Q${e.quarter}`;
  const relation = e.actualMillions > e.highMillions ? `$${(e.actualMillions - e.highMillions).toLocaleString("en-US")}m above` :
    e.actualMillions < e.lowMillions ? `$${(e.lowMillions - e.actualMillions).toLocaleString("en-US")}m below` : "within";
  const format = (n: number) => (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const metrics = [["Original guidance low", e.lowMillions], ["Original guidance midpoint", e.midpointMillions],
    ["Original guidance high", e.highMillions], ["Filed quarterly revenue", e.actualMillions]] as const;
  return { ...base, issuerGuidance: e,
    status: Date.parse(checked) - Date.parse(e.end) > STALE_DAYS * ONE_DAY ? "stale" : "available",
    summary: `${ticker} filed $${format(e.actualMillions)}bn in revenue for ${period}, ${relation} its original $${format(e.lowMillions)}–$${format(e.highMillions)}bn management range.`,
    source: { ...base.source, url: secDocumentUrl(REVIEWED_ISSUERS[ticker].cik, e.quarterly.accession, e.quarterly.accession + "-index.htm")!,
      observedAt: e.end, releasedAt: filingDay(e), sha256: e.quarterly.indexSHA256 },
    series: [{ date: e.end, value: e.actualMillions }], metrics: metrics.map(([label, value]) => ({ label, value, unit: "$m", date: e.end })) };
}

export function validateIssuerGuidance(s: Signal, cutoff: string) {
  const ticker = REVENUE_ISSUERS.find(t => id(t) === s.id);
  if (!ticker) {
    if (s.issuerGuidance) throw new Error("Misplaced issuer guidance comparison");
    return;
  }
  const base = baseline(ticker, s.source.retrievedAt), e = s.issuerGuidance;
  if (s.family !== base.family || s.title !== base.title || s.shortLabel !== base.shortLabel ||
      s.instruments.join() !== base.instruments.join() || !Array.isArray(s.directionalInstruments) || s.directionalInstruments.length ||
      Object.values(s.scores).some(v => v !== null) || s.unit !== base.unit || s.methodology !== METHOD || s.limitation !== LIMIT ||
      s.staleAfterDays !== STALE_DAYS || !instant(s.source.retrievedAt) || s.source.retrievedAt > cutoff)
    throw new Error("Invalid issuer guidance observation scope or clock");
  if (!e) {
    if (!["unavailable", "not_formed"].includes(s.status) || s.series.length || s.metrics.length || fingerprint(s.source) !== fingerprint(base.source))
      throw new Error("Unconfirmed issuer guidance carries revenue");
    return;
  }
  if (!exactKeys(e, "ticker year quarter start end lowMillions midpointMillions highMillions actualMillions guidance results quarterly firstEvidenceCompleteAt publiclyKnownBy"))
    throw new Error("Unexpected fields in issuer guidance evidence");
  for (const item of [e.guidance, e.results, e.quarterly]) {
    if (!exactKeys(item, "accession acceptedAt filed indexSHA256 url sha256") || !validFilingClock(item.acceptedAt, item.filed) ||
        earliestReceiptTime(item.acceptedAt, item.filed) > e.firstEvidenceCompleteAt)
      throw new Error("Invalid SEC filing proof fields or filing chronology");
  }
  const amounts = [e.lowMillions, e.midpointMillions, e.highMillions, e.actualMillions];
  const duration = (Date.parse(e.end) - Date.parse(e.start)) / ONE_DAY;
  if (e.ticker !== ticker || !Number.isSafeInteger(e.year) || e.year < 2000 || ![1,2,3].includes(e.quarter) ||
      !instant(e.firstEvidenceCompleteAt) || e.firstEvidenceCompleteAt > s.source.retrievedAt ||
      !instant(e.publiclyKnownBy) || e.publiclyKnownBy !== withCapture(e, e.firstEvidenceCompleteAt).publiclyKnownBy ||
      publicDate(e.start) !== e.start || publicDate(e.end) !== e.end || duration < 75 || duration > 105 ||
      !amounts.every(v => Number.isFinite(v) && v > 0) || !Number.isSafeInteger(e.actualMillions) ||
      !(e.lowMillions < e.midpointMillions && e.midpointMillions < e.highMillions) ||
      Math.abs(e.highMillions + e.lowMillions - 2 * e.midpointMillions) > 1e-6 ||
      e.guidance.filed >= e.end || e.results.filed <= e.end || e.quarterly.filed <= e.end ||
      e.guidance.acceptedAt >= e.end || e.results.acceptedAt <= e.end || e.quarterly.acceptedAt <= e.end ||
      new Set([e.guidance.accession, e.results.accession, e.quarterly.accession]).size !== 3)
    throw new Error("Invalid issuer guidance fiscal period or amount");
  for (const [kind, item] of [["guidance", e.guidance], ["results", e.results], ["quarterly", e.quarterly]] as const) {
    const filename = item.url.split("/").at(-1);
    if (!accessionPattern.test(item.accession) || !instant(item.acceptedAt) || item.acceptedAt > e.firstEvidenceCompleteAt ||
        publicDate(item.filed) !== item.filed || !filename || !/^[\w.-]+$/.test(filename) ||
        !(kind === "quarterly" ? /_htm\.xml$/i : /\.htm$/i).test(filename) || item.url !== secDocumentUrl(REVIEWED_ISSUERS[ticker].cik, item.accession, filename) ||
        ![item.sha256, item.indexSHA256].every(h => /^[a-f\d]{64}$/.test(h))) throw new Error("Invalid issuer-specific filing proof");
  }
  const expected = published(ticker, e, s.source.retrievedAt);
  if (s.status !== expected.status || s.summary !== expected.summary || fingerprint(s.metrics) !== fingerprint(expected.metrics) ||
      fingerprint(s.series) !== fingerprint(expected.series) || fingerprint(s.source) !== fingerprint(expected.source))
    throw new Error("Issuer guidance fields differ from underlying comparison");
}

function checkIndex(filing: ResultsFiling, index: SecDocument) {
  const fields = new Map(Array.from(index.text.matchAll(/<div class="infoHead">([^<]+)<\/div>\s*<div class="info">([^<]+)<\/div>/g),
    m => [m[1], m[2]]));
  const accepted = fields.get("Accepted")?.replace(/[-:]/g, "").replace(" ", "T");
  if (!accepted || newYorkTimestamp(accepted) !== filing.acceptedAt || fields.get("Filing Date") !== filing.filingDate ||
      fields.get("Period of Report") !== filing.reportDate || !index.text.includes(filing.accession))
    throw new Error("SEC index disagrees with filing date, acceptance, accession or period");
}
function extractedURL(filing: ResultsFiling, index: SecDocument) {
  checkIndex(filing, index);
  const rows = Array.from(index.text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).filter(m => plain(m[1]).includes("EXTRACTED XBRL INSTANCE DOCUMENT"));
  const links = rows.length === 1 ? Array.from(rows[0][1].matchAll(/href="([^"]+)"/gi)) : [];
  if (links.length !== 1) throw new Error("Missing unique filed XBRL instance");
  const url = new URL(links[0][1], filingIndex(filing)).href, filename = url.split("/").at(-1)!;
  if (!/^[\w.-]+_htm\.xml$/i.test(filename) || url !== secDocumentUrl(REVIEWED_ISSUERS[filing.ticker].cik, filing.accession, filename))
    throw new Error("Unexpected filed XBRL document URL");
  return url;
}

type Catalog = { filings: { recent: Record<string, string[]> } };
function corroboratingFiling(ticker: RevenueIssuer, catalog: Catalog, results: ResultsFiling[], periodEnd: string, through: string): ResultsFiling | null {
  const c = catalog.filings.recent, n = c.form.length;
  if (![c.accessionNumber, c.acceptanceDateTime, c.filingDate, c.reportDate, c.items].every(v => Array.isArray(v) && v.length === n))
    throw new Error("Incomplete SEC filing catalog");
  const matches: ResultsFiling[] = [];
  for (let i = 0; i < n; i++) {
    if (!["8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A"].includes(c.form[i])) continue;
    const reportDate = publicDate(c.reportDate[i]), filed = publicDate(c.filingDate[i]), at = c.acceptanceDateTime[i], accession = c.accessionNumber[i];
    if (instant(at) && (at < results[0].acceptedAt || at > through)) continue;
    if (!reportDate || !filed || !validFilingClock(at, filed) || !accessionPattern.test(accession)) throw new Error("Malformed SEC filing identity");
    if (through < earliestReceiptTime(at, filed)) continue;
    if (c.form[i] === "8-K/A" && results.some(f => f.reportDate === reportDate) && (!c.items[i] || c.items[i].split(",").some(item => item.trim() === "2.02")))
      throw new FilingReviewError("An amended earnings filing requires reconciliation.");
    if (c.form[i] === "8-K/A") continue;
    if (reportDate > periodEnd) throw new FilingReviewError("A newer annual or quarterly filing supersedes the available earnings exhibits.");
    if (reportDate !== periodEnd) continue;
    if (c.form[i] === "10-Q/A" || c.form[i] === "10-K/A") throw new FilingReviewError("An amended quarterly result requires reconciliation.");
    if (c.form[i] === "10-Q") matches.push({ticker, accession, reportDate, filingDate: filed, acceptedAt: at});
  }
  if (matches.length > 1) throw new FilingReviewError("Multiple original 10-Q filings claim the same quarter.");
  return matches[0] ?? null;
}

const proof = (filing: ResultsFiling, index: SecDocument, document: SecDocument): FilingProof => ({
  accession: filing.accession, acceptedAt: filing.acceptedAt, filed: filing.filingDate,
  indexSHA256: index.sha256, url: document.url, sha256: document.sha256,
});

function filedRevenue(document: SecDocument, ticker: RevenueIssuer, start: string, end: string, year: number, quarter: number) {
  try {
    return Number(execFileSync("python3", [quarterParser, ticker, start, end, String(year), String(quarter)],
      { input: document.text, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, maxBuffer: 64_000, encoding: "utf8" }).trim());
  } catch { throw new FilingReviewError("The filed XBRL lacks a unique consolidated USD fact for this fiscal quarter."); }
}

export async function collectIssuerGuidance(ticker: RevenueIssuer, read: SecReader, now = () => new Date().toISOString(),
  directory?: string, previous?: Signal): Promise<Signal> {
  let newerResults = false;
  try {
    const source = await read(catalogURL(ticker));
    verifySecDocument(source, catalogURL(ticker), "2000-01-01T00:00:00.000Z");
    if (source.retrievedAt > now()) throw new Error("Future SEC submissions check");
    const catalog = JSON.parse(source.text) as Catalog;
    const from = new Date(Date.parse(source.retrievedAt) - 400 * ONE_DAY).toISOString().slice(0, 10);
    const filings = resultsFilings(ticker, catalog, from, source.retrievedAt).slice(-2);
    if (filings.length !== 2) throw new Error("Two original quarterly earnings exhibits are required");
    const last = filings[1], older = previous?.issuerGuidance;
    if (older && last.acceptedAt < older.results.acceptedAt) throw new Error("Latest results moved backwards");
    newerResults = !!older && older.results.accession !== last.accession;
    const receipts = [];
    for (const filing of filings) {
      if (!validFilingClock(filing.acceptedAt, filing.filingDate)) throw new FilingReviewError("The SEC acceptance and filed day do not reconcile.");
      if (source.retrievedAt < earliestReceiptTime(filing.acceptedAt, filing.filingDate))
        return { ...baseline(ticker, now()), status: "not_formed", summary: `The latest ${ticker} earnings exhibit is pending its SEC filing day.` };
      const receipt = await originalExhibit(filing, read, directory);
      checkIndex(filing, receipt.index);
      receipts.push(receipt);
    }
    const pair = matchGuidedQuarter(readIssuerRevenue(filings[0], receipts[0].original.text),
      readIssuerReportedRevenue(last, receipts[1].original.text));
    if (!pair) throw new Error("Original guidance does not target the latest reported fiscal quarter");
    const liveDir = directory && join(directory, "guidance-matches");
    if (liveDir) {
      const files = await readdir(liveDir).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return [];
        throw err;
      });
      if (files.some(f => f.startsWith(ticker + "-") && f.endsWith(".json") && f.slice(ticker.length + 1, -5) > pair.actual.periodEnd))
        throw new Error("SEC reporting period moved behind an earlier confirmed filing");
    }
    const filing = corroboratingFiling(ticker, catalog, filings, pair.actual.periodEnd, source.retrievedAt);
    if (!filing) return { ...baseline(ticker, now()), status: "not_formed",
      summary: `The ${ticker} earnings release covers the quarter ended ${pair.actual.periodEnd}. A matching original 10-Q is pending.` };
    const start = nextDay(pair.prior.periodEnd), end = pair.actual.periodEnd, { year, quarter } = pair.actual.period;
    let freshInstance: SecDocument | undefined;
    const report = await immutableSecReceipt(directory, filing.accession + "-quarter.json", async () => {
      const index = await read(filingIndex(filing));
      freshInstance = await read(extractedURL(filing, index));
      return { index, xml: freshInstance };
    }, r => {
      verifySecDocument(r.index, filingIndex(filing), filing.acceptedAt);
      verifySecDocument(r.xml, extractedURL(filing, r.index), filing.acceptedAt);
    });
    const usd = filedRevenue(report.xml, ticker, start, end, year, quarter);
    if (!Number.isSafeInteger(usd) || usd !== pair.actual.actualMillions * 1e6)
      throw new FilingReviewError("The earnings exhibit and filed consolidated quarter disagree.");
    // Keep the original accession and recheck the current SEC instance for silent corrections.
    const current = freshInstance ?? await read(report.xml.url);
    verifySecDocument(current, report.xml.url, filing.acceptedAt);
    if (current.retrievedAt > now()) throw new Error("Future SEC instance check");
    if (current.sha256 !== report.xml.sha256) {
      await immutableSecReceipt(directory, `${filing.accession}-instance-${current.sha256}.json`, async () => current,
        receipt => verifySecDocument(receipt, report.xml.url, filing.acceptedAt));
      if (filedRevenue(current, ticker, start, end, year, quarter) !== usd)
        throw new FilingReviewError("The current SEC instance changed the originally captured quarterly revenue.");
    }
    const evidence: FiledComparison = { ticker, year, quarter, start, end, lowMillions: pair.prior.guidance.lowMillions,
      midpointMillions: pair.prior.guidance.midpointMillions, highMillions: pair.prior.guidance.highMillions, actualMillions: pair.actual.actualMillions,
      guidance: proof(filings[0], receipts[0].index, receipts[0].original), results: proof(last, receipts[1].index, receipts[1].original),
      quarterly: proof(filing, report.index, report.xml) };
    const checked = now();
    const captured = [report.index, report.xml, ...receipts.flatMap(r => [r.index, r.original])].map(d => d.retrievedAt);
    if (captured.some(at => at > checked))
      throw new Error("SEC filing capture falls after the source check");
    for (const [i, r] of receipts.entries()) {
      const floor = earliestReceiptTime(filings[i].acceptedAt, filings[i].filingDate);
      if (r.index.retrievedAt < floor || r.original.retrievedAt < floor) throw new Error("SEC exhibit capture precedes its public filing day");
    }
    const reportFloor = earliestReceiptTime(filing.acceptedAt, filing.filingDate);
    if (report.index.retrievedAt < reportFloor || report.xml.retrievedAt < reportFloor) throw new Error("SEC quarterly capture precedes its public filing day");
    // Freeze the first catalogue that showed these filings. An unrelated later submission
    // or a routine recheck must never refresh the evidence's first usable capture.
    const first = await immutableSecReceipt(liveDir, `${ticker}-${end}.json`, async () => ({ catalog: source, evidence }), receipt => {
      verifySecDocument(receipt.catalog, catalogURL(ticker), "2000-01-01T00:00:00.000Z");
      if (fingerprint(receipt.evidence) !== fingerprint(evidence)) throw new Error("Private evidence differs from the earlier quarter comparison");
      validateIssuerGuidance(published(ticker, withCapture(evidence,
        [receipt.catalog.retrievedAt, ...captured].sort().at(-1)!), checked), checked);
    });
    const firstEvidenceCompleteAt = !liveDir && older?.end === end ? older.firstEvidenceCompleteAt :
      [first.catalog.retrievedAt, ...captured].sort().at(-1)!;
    const e = withCapture(evidence, firstEvidenceCompleteAt);
    if (older?.end === end && fingerprint(older) !== fingerprint(e)) throw new Error("An earlier confirmed comparison differs");
    const signal = published(ticker, e, checked);
    validateIssuerGuidance(signal, checked);
    return signal;
  } catch (error) {
    const kind = sourceFailureKind(error);
    return { ...baseline(ticker, now()), status: newerResults && kind === "transport" ? "not_formed" : "unavailable",
      failureKind: kind, ...(error instanceof FilingReviewError ? { collectionNote: error.message } : {}),
      summary: kind === "transport" ? `${ticker} filing retrieval was interrupted.` :
        `The latest ${ticker} filing comparison could not be verified.` };
  }
}
