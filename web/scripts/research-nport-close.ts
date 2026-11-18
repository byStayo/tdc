import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { collectKibotSeries, KIBOT_PRICE_CITATION, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { historicalResearchSession, HISTORICAL_RESEARCH_CALENDAR } from "../lib/consensus/research-session-calendar.ts";
import { sourceChunk, sourceResponse } from "../lib/consensus/source-failure.ts";

const REPORT_DATE = "2025-11-30";
const REVIEWED_SESSION = "2025-11-28";
const MAX_XML_BYTES = 1_000_000;
// The existing CTA and Kibot/issuer reviews use this same close tolerance.
const CLOSE_TOLERANCE_BPS = 15;
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-nport-close");
const CUSIPS = { SPY: "78462F103", QQQ: "46090E103", IWM: "464287655", DIA: "78467X109", TLT: "464287432" } as const;
type ETF = keyof typeof CUSIPS;
type Source = {
  accession: string; cik: string; seriesId: string; reportDate: string;
  holdings: Partial<Record<ETF, number>>; url: string; sha256: string;
  policy: { url: string; asOf: string; basis: string } | null;
};

/** Pinned originals, not a general N-PORT feed or an approved daily-price adapter. */
export const NPORT_CLOSE_SOURCES = [
  {
    accession: "000091047226000698", cik: "0001545440", seriesId: "S000077993", shares: 15117,
    reportDate: REPORT_DATE, holdings: { DIA: 15117, QQQ: 11000, TLT: 5861 },
    url: "https://www.sec.gov/Archives/edgar/data/1545440/000091047226000698/primary_doc.xml",
    sha256: "e90937ac926e0941d736e1ad51c59acc3372b73abe67d63b5e9accb5471b435e",
    policy: {
      url: "https://www.sec.gov/Archives/edgar/data/1545440/000158064226000820/umt_ncsr.htm",
      asOf: "2025-11-30",
      basis: "ETFs: primary-exchange last sale at regular close; mean quote if no last sale; unavailable or unreliable quotes may use Level 2/3 fair value.",
    },
  },
  {
    accession: "000091047226000995", cik: "0001924447", seriesId: "S000086677", shares: 167103,
    reportDate: REPORT_DATE, holdings: { DIA: 167103, SPY: 116889, QQQ: 1810 },
    url: "https://www.sec.gov/Archives/edgar/data/1924447/000091047226000995/primary_doc.xml",
    sha256: "1d8dcb93d21c44b9c0add30fcf6c4185c2ff964adc41481f9d5741098b8a1e9a",
    policy: {
      url: "https://www.sec.gov/Archives/edgar/data/1924447/000158064225007078/thor_ncsr.htm",
      asOf: "2025-08-31",
      basis: "Exchange-listed securities: last regular-session sale, or NASDAQ official close; no-sale midpoint and fair-value exceptions. The notes also contain separate underlying-fund NAV language.",
    },
  },
  {
    accession: "000089418926002155", cik: "0001683471", seriesId: "S000072266", shares: 13609,
    reportDate: REPORT_DATE, holdings: { DIA: 13609, QQQ: 7161 },
    url: "https://www.sec.gov/Archives/edgar/data/1683471/000089418926002155/primary_doc.xml",
    sha256: "15e1e6221c8922f466d29e74601bf288af68c1308d72579dd7a1adb03ffc7c68",
    policy: {
      url: "https://www.sec.gov/Archives/edgar/data/1683471/000113322826001485/asar-efp22145_ncsrs.htm",
      asOf: "2025-11-30",
      basis: "Exchange-traded equity: primary-market official closing or last trading price; NASDAQ official close where applicable. Early market closings can trigger discretionary fair valuation.",
    },
  },
] as const;

export const NPORT_ALL_CLOSE_SOURCES = [...NPORT_CLOSE_SOURCES, {
  accession: "000159290026000210", cik: "0001592900", seriesId: "S000088135",
  reportDate: REVIEWED_SESSION, holdings: { SPY: 2723, IWM: 262 },
  url: "https://www.sec.gov/Archives/edgar/data/1592900/000159290026000210/primary_doc.xml",
  sha256: "d0ab00ff727dcae2420b75a83e0fcc025ee2cf4afb2a5e77d336ae0911670f8b",
  policy: null,
}] as const;
export interface NportCloseMark {
  instrument: ETF;
  accession: string;
  source: string;
  sha256: string;
  reportDate: string;
  fiscalYearEnd: string;
  registrant: string;
  seriesName: string;
  seriesId: string;
  cusip: string;
  shares: number;
  valueUSD: string;
  currency: "USD";
  units: "NS";
  fairValueLevel: 1;
  impliedClose: number;
}

// Python's standard-library namespace-aware XML parser avoids adding a dependency.
// Disable DTD/entities before invoking it; read only direct investment records.
const XML_FIELDS = String.raw`
import json, sys, xml.etree.ElementTree as E
n = '{http://www.sec.gov/edgar/nport}'
def one(parent, name):
    found = parent.findall(n + name)
    if len(found) != 1: raise ValueError('nonunique field')
    return found[0]
def text(parent, name):
    node = one(parent, name)
    if len(node): raise ValueError('non-scalar field')
    value = (node.text or '').strip()
    if not value or len(value) > 256: raise ValueError('invalid field')
    return value
r = E.fromstring(sys.stdin.read())
if r.tag != n + 'edgarSubmission': raise ValueError('namespace')
h = one(r, 'headerData'); f = one(r, 'formData'); g = one(f, 'genInfo')
holdings = []
for item in one(f, 'invstOrSecs').findall(n + 'invstOrSec'):
    if any((c.text or '').strip() == sys.argv[1] for c in item.findall(n + 'cusip')):
        holdings.append({k: text(item, k) for k in [
            'cusip', 'balance', 'units', 'curCd', 'valUSD', 'fairValLevel',
            'payoffProfile', 'assetCat', 'issuerCat', 'invCountry', 'isRestrictedSec']})
print(json.dumps({
  'submissionType': text(h, 'submissionType'), 'isConfidential': text(h, 'isConfidential'),
  'general': {k: text(g, k) for k in ['regName', 'regCik', 'seriesName', 'seriesId', 'repPdDate', 'repPdEnd']},
  'holdings': holdings
}))
`;

export function parseNportClose(bytes: Uint8Array, source: Source, instrument: ETF = "DIA"): NportCloseMark {
  const shares = source.holdings[instrument], cusip = CUSIPS[instrument];
  if (!shares || !cusip) throw new Error("N-PORT holding is outside the reviewed source scope");
  if (!bytes.byteLength || bytes.byteLength > MAX_XML_BYTES) throw new Error("N-PORT original exceeds the bounded XML size");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("N-PORT DTD/entity declarations are prohibited");
  const parsed = spawnSync("python3", ["-c", XML_FIELDS, cusip], {
    input: xml, encoding: "utf8", timeout: 5_000, maxBuffer: 64_000,
  });
  if (parsed.error || parsed.status !== 0) throw new Error("Invalid or nonunique N-PORT XML fields");
  const result = JSON.parse(parsed.stdout) as {
    submissionType: string; isConfidential: string;
    general: Record<string, string>; holdings: Record<string, string>[];
  };
  const g = result.general, holdings = result.holdings;
  if (result.submissionType !== "NPORT-P" || result.isConfidential !== "false" ||
      g.regCik !== source.cik || g.seriesId !== source.seriesId || g.repPdDate !== source.reportDate ||
      !/^\d{4}-\d{2}-\d{2}$/.test(g.repPdEnd) ||
      new Date(g.repPdEnd + "T00:00:00Z").toISOString().slice(0, 10) !== g.repPdEnd || holdings.length !== 1)
    throw new Error("N-PORT source identity, report date or direct holding differs");
  const h = holdings[0];
  if (h.cusip !== cusip || h.curCd !== "USD" || h.units !== "NS" || h.fairValLevel !== "1" ||
      h.payoffProfile !== "Long" || h.assetCat !== "EC" || h.issuerCat !== "RF" ||
      h.invCountry !== "US" || h.isRestrictedSec !== "N" ||
      !/^\d{1,12}(?:\.0{1,12})?$/.test(h.balance) || Number(h.balance) !== shares ||
      !/^\d{1,12}(?:\.\d{1,12})?$/.test(h.valUSD) || Number(h.valUSD) <= 0)
    throw new Error("N-PORT identity, USD shares, quantity or Level 1 basis differs");
  // All three reviewed originals contain exact cents, unlike their rounded HTML schedules.
  const [whole, fraction = ""] = h.valUSD.split(".");
  const numerator = BigInt(whole + fraction) * 100n;
  const denominator = 10n ** BigInt(fraction.length) * BigInt(shares);
  if (numerator % denominator !== 0n) throw new Error("N-PORT value is not an exact cent-per-share mark");
  const impliedClose = Number(numerator / denominator) / 100;
  if (!Number.isFinite(impliedClose) || impliedClose <= 0) throw new Error("Invalid N-PORT implied close");
  return {
    instrument, accession: source.accession, source: source.url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    reportDate: g.repPdDate, fiscalYearEnd: g.repPdEnd, registrant: g.regName,
    seriesName: g.seriesName, seriesId: g.seriesId, cusip: h.cusip, shares,
    valueUSD: h.valUSD, currency: "USD", units: "NS", fairValueLevel: 1, impliedClose,
  };
}

export function nportMonthEndBinding(reportDate: string) {
  if (reportDate !== REPORT_DATE) throw new Error("N-PORT date differs from the reviewed month-end");
  let day = reportDate;
  for (let i = 0; i < 7; i++) {
    const bounds = historicalResearchSession(day);
    if (bounds) {
      if (bounds.session !== REVIEWED_SESSION || bounds.closeAt !== "2025-11-28T18:00:00.000Z")
        throw new Error("N-PORT reviewed month-end session binding differs");
      return {
        reportDate, session: bounds.session, scheduledOpenAt: bounds.openAt,
        scheduledCloseAt: bounds.closeAt, auctionExecutionAt: null,
        calendar: HISTORICAL_RESEARCH_CALENDAR.id,
        calendarSources: HISTORICAL_RESEARCH_CALENDAR.sources,
        basis: "month-end-level-1-listing-valuation" as const,
      };
    }
    day = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
  }
  throw new Error("N-PORT reviewed month-end has no preceding session");
}

export function compareNportClose(marks: NportCloseMark[], rawKibotClose: number) {
  if (marks.length !== NPORT_CLOSE_SOURCES.length ||
      new Set(marks.map(mark => mark.accession)).size !== NPORT_CLOSE_SOURCES.length ||
      NPORT_CLOSE_SOURCES.some(source => !marks.some(mark => mark.accession === source.accession &&
        mark.instrument === "DIA" && mark.seriesId === source.seriesId && mark.shares === source.shares && mark.reportDate === REPORT_DATE)))
    throw new Error("N-PORT comparison requires the three distinct reviewed originals");
  const consensusClose = marks[0].impliedClose;
  if (!(consensusClose > 0) || !Number.isFinite(consensusClose) || marks.some(mark => mark.impliedClose !== consensusClose))
    throw new Error("N-PORT original marks disagree");
  if (!(rawKibotClose > 0) || !Number.isFinite(rawKibotClose)) throw new Error("Invalid raw Kibot close");
  const difference = (consensusClose / rawKibotClose - 1) * 10_000;
  return {
    independentFilings: marks.length, consensusClose,
    closeDifferenceBps: Number(difference.toFixed(4)), closeToleranceBps: CLOSE_TOLERANCE_BPS,
    closeDifferenceBasis: "(reference / rawKibot - 1) * 10000",
    rawKibotDifferenceFromReferenceBps: Number(((rawKibotClose / consensusClose - 1) * 10_000).toFixed(4)),
    closePass: Math.abs(difference) <= CLOSE_TOLERANCE_BPS,
  };
}

export function corroborateNportCloses(marks: NportCloseMark[]) {
  const expected = new Map(NPORT_ALL_CLOSE_SOURCES.flatMap(source => Object.entries(source.holdings)
    .map(([instrument, shares]) => [source.accession + ":" + instrument, { source, instrument, shares }] as const)));
  if (marks.length !== expected.size || new Set(marks.map(mark => mark.accession + ":" + mark.instrument)).size !== expected.size ||
      marks.some(mark => {
        const row = expected.get(mark.accession + ":" + mark.instrument);
        return !row || mark.source !== row.source.url || mark.reportDate !== row.source.reportDate ||
          mark.seriesId !== row.source.seriesId || mark.shares !== row.shares ||
          mark.cusip !== CUSIPS[mark.instrument] || mark.currency !== "USD" || mark.units !== "NS" || mark.fairValueLevel !== 1;
      })) throw new Error("N-PORT evidence differs from the exact reviewed holdings");
  return (Object.keys(CUSIPS) as ETF[]).map(instrument => {
    const rows = marks.filter(mark => mark.instrument === instrument), consensusClose = rows[0].impliedClose;
    if (!(consensusClose > 0) || !Number.isFinite(consensusClose) || rows.some(mark => mark.impliedClose !== consensusClose))
      throw new Error("N-PORT original marks disagree for " + instrument);
    return {
      instrument, consensusClose, filingMarks: rows.length,
      reportDates: [...new Set(rows.map(mark => mark.reportDate))].sort(),
      session: REVIEWED_SESSION, auctionExecutionAt: null,
    };
  });
}

export function readSavedKibotReference(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_XML_BYTES) throw new Error("Invalid private Kibot review size");
  const saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const raw = saved?.rawKibot, binding = nportMonthEndBinding(REPORT_DATE);
  if (saved?.schemaVersion !== 1 || saved.purpose !== "private-month-end-close-reference" || saved.instrument !== "DIA" ||
      !Number.isFinite(Date.parse(saved.evaluatedAt)) || Date.parse(saved.evaluatedAt) < Date.parse(binding.scheduledCloseAt) ||
      Date.parse(saved.evaluatedAt) > Date.now() || saved.binding?.session !== binding.session ||
      saved.binding?.calendar !== binding.calendar || saved.binding?.scheduledCloseAt !== binding.scheduledCloseAt ||
      raw?.source !== KIBOT_PRICE_CITATION || !["guest-unadjusted", "preserved-csv", "preserved-review"].includes(raw.mode) ||
      raw.session !== REVIEWED_SESSION || typeof raw.close !== "number" || !Number.isFinite(raw.close) || raw.close <= 0 ||
      !/^[a-f0-9]{64}$/.test(raw.sha256) || raw.clockBasis !== "reviewed-calendar-annotation-not-provider-auction-evidence")
    throw new Error("Invalid private unadjusted Kibot review provenance");
  return {
    source: KIBOT_PRICE_CITATION, mode: "preserved-review", session: raw.session as string, close: raw.close as number,
    sha256: raw.sha256 as string, clockBasis: raw.clockBasis as string,
    reviewSha256: createHash("sha256").update(bytes).digest("hex"), reviewEvaluatedAt: saved.evaluatedAt as string,
  };
}

async function privateBytes(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.() ||
        !info.size || info.size > maxBytes) throw new Error("Private research input must be owner-only and bounded");
    const bytes = await file.readFile();
    if (bytes.length !== info.size) throw new Error("Private research input changed during reading");
    return bytes;
  } finally { await file.close(); }
}

async function fetchOriginal(source: Source) {
  const response = await sourceResponse(fetch, source.url, {
    redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "The Daily Consensus public research https://thedailyconsensus.com", Accept: "application/xml,text/xml" },
  });
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_XML_BYTES)) {
    await response.body!.cancel();
    throw new Error("N-PORT original exceeds the bounded XML size");
  }
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_XML_BYTES) throw new Error("N-PORT original exceeds the bounded XML size");
      chunks.push(part.value);
    }
    const encoding = response.headers.get("content-encoding");
    if (declared !== null && (!encoding || encoding === "identity") && Number(declared) !== length)
      throw new Error("N-PORT original is incomplete");
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

async function main() {
  let originals = resolve(directory, "originals"), kibotFile: string | undefined, kibotReview: string | undefined;
  const args = process.argv.slice(2), flags = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!["--originals", "--kibot-file", "--kibot-review"].includes(flag) || flags.has(flag) || !value || !isAbsolute(value))
      throw new Error("Usage: node --experimental-strip-types scripts/research-nport-close.ts [--originals /absolute/private/directory] [--kibot-file /absolute/private/raw.csv | --kibot-review /absolute/private/review.json]");
    flags.add(flag);
    if (flag === "--originals") originals = value;
    else if (flag === "--kibot-file") kibotFile = value;
    else kibotReview = value;
  }
  if (kibotFile && kibotReview) throw new Error("Invalid duplicate private Kibot input modes");
  const allMarks: NportCloseMark[] = [], modes: string[] = [];
  let fetched = 0;
  for (const source of NPORT_ALL_CLOSE_SOURCES) {
    let bytes: Uint8Array;
    try {
      bytes = await privateBytes(resolve(originals, source.accession + ".xml"), MAX_XML_BYTES);
      modes.push("preserved-original");
    } catch (error) {
      if (flags.has("--originals") || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (fetched++) await delay(1_000);
      bytes = await fetchOriginal(source); // At most one request per original; no access/rate-limit retries.
      modes.push("ordinary-sec-url");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
      throw new Error("N-PORT original differs from its reviewed source hash");
    for (const instrument of Object.keys(source.holdings) as ETF[]) allMarks.push(parseNportClose(bytes, source, instrument));
  }
  const marks = allMarks.filter(mark => mark.instrument === "DIA");
  const closingReferences = corroborateNportCloses(allMarks);
  const binding = nportMonthEndBinding(marks[0].reportDate);
  const rawKibot = kibotReview ? readSavedKibotReference(await privateBytes(kibotReview, MAX_XML_BYTES)) : await (async () => {
    const kibot = kibotFile ? await (async () => {
      const bytes = await privateBytes(kibotFile, 64 * 1024);
      return { sessions: parseKibotDaily(new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        [binding.session], historicalResearchSession), sha256: createHash("sha256").update(bytes).digest("hex") };
    })() : await collectKibotSeries("DIA", [binding.session], { unadjusted: true, sessionClock: historicalResearchSession });
    return { source: KIBOT_PRICE_CITATION, mode: kibotFile ? "preserved-csv" : "guest-unadjusted",
      session: binding.session, close: kibot.sessions[0].close, sha256: kibot.sha256,
      clockBasis: "reviewed-calendar-annotation-not-provider-auction-evidence" };
  })();
  const comparison = compareNportClose(marks, rawKibot.close);
  const evaluatedAt = new Date().toISOString();
  const artifact = {
    schemaVersion: 1, purpose: "private-month-end-close-reference", instrument: "DIA", evaluatedAt,
    binding, marks, allMarks, closingReferences, sourceModes: modes,
    valuationPolicies: NPORT_ALL_CLOSE_SOURCES.map(({ accession, policy }) => ({ accession,
      ...(policy ?? { status: "Cambria valuation policy not independently reviewed by this script" }) })),
    rawKibot,
    comparison,
    limitations: [
      "Three independently filed holdings corroborate one month-end valuation; independence of their pricing vendors is unverified.",
      "The four originals contain ten reviewed holdings: SPY has two filing marks, QQQ three, IWM one, DIA three and TLT one. Cambria reports November 28 directly; the other three report November 30.",
      "Cambria's valuation policy is outside this review; its IWM and SPY records establish Level 1 USD share marks, without an independently verified listing-close policy.",
      "Report dates and the reviewed calendar bind the mark to the last session; no filing supplies an auction execution timestamp.",
      "Valuation policies have no-sale midpoint and fair-value exceptions. Level 1 supports a quoted unadjusted mark; it is not a transaction audit.",
      "This bounded private comparison does not approve production prices, prospective labels, training, holdouts or public price redistribution.",
    ],
  };
  const destination = resolve(directory, "reviews", "DIA-" + binding.session + "-" + evaluatedAt.replaceAll(/[:.]/g, "-") + ".json");
  const release = await acquirePublicationLock(root, "private-nport-close-reference");
  let failure: { error: unknown } | undefined;
  try {
    await durableDirectory(directory, 0o700);
    await durableDirectory(resolve(directory, "reviews"), 0o700);
    await durableJSON(destination, artifact, true);
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
  console.log(JSON.stringify({
    scope: artifact.purpose, instrument: artifact.instrument, session: binding.session,
    reportDate: binding.reportDate, originalFilings: NPORT_ALL_CLOSE_SOURCES.length,
    reviewedHoldingMarks: allMarks.length, diaAgreeingMarks: marks.length,
    closeDifferenceBps: comparison.closeDifferenceBps, closeToleranceBps: comparison.closeToleranceBps,
    closeDifferenceBasis: comparison.closeDifferenceBasis,
    rawKibotDifferenceFromReferenceBps: comparison.rawKibotDifferenceFromReferenceBps,
    closePass: comparison.closePass, auctionTimingVerified: false,
    originalSources: NPORT_ALL_CLOSE_SOURCES.map(({ accession, reportDate, sha256 }) => ({ accession, reportDate, sha256 })),
    closingReferences: closingReferences.map(({ instrument, filingMarks, reportDates }) => ({ instrument, filingMarks, reportDates })),
    artifact: destination,
  }, null, 2));
  if (!comparison.closePass) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Never print response bodies, raw prices or arbitrary error objects.
    console.error(error instanceof Error && /^(?:N-PORT|Invalid|Private|Source HTTP|Usage:)/.test(error.message)
      ? error.message : "Private N-PORT close research failed.");
    process.exitCode = 1;
  });
}
