import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { publicDate } from "../public-normalization.ts";
import { immutableSecReceipt } from "./issuer-results-source.ts";
import { sourceChunk, sourceFailureKind, sourceResponse } from "./source-failure.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const SCHWAB_RETAIL_FLOWS_ID = "schwab-retail-prime-flows";
const CIK = "0000857156";
const SERIES = "S000004508";
const CLASS = "C000012383";
const CATALOG = "https://data.sec.gov/submissions/CIK" + CIK + ".json";
const DAY = 86_400_000;
const MAX_XML = 40 * 1024 * 1024;
const usage =
  "Numerical aggregates derived from public Form N-MFP filings. The federal data catalog lists the Form N-MFP dataset as an open government data asset. https://catalog.data.gov/dataset/form-n-mfp-data-sets";
const method =
  "Use original Form N-MFP3 for Schwab Prime Advantage Money Fund Investor Shares (SWVXX). Reconcile class daily gross subscriptions and redemptions to the filed month totals and all classes to series net assets. Divide net monthly flow by this class’s month-end net assets.";
const limitation =
  "One retail prime money-market share class. Flows include reinvested dividends and may reflect share-class exchanges. The fund reports no destination for redeemed cash.";
class RetailEvidenceError extends Error {}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Filing = {
  accession: string;
  form: string;
  period: string;
  filed: string;
  accepted: string;
};
type FilingColumn = "form" | "accessionNumber" | "acceptanceDateTime" | "filingDate" | "reportDate";
const filingColumns: FilingColumn[] = [
  "form",
  "accessionNumber",
  "acceptanceDateTime",
  "filingDate",
  "reportDate",
];
export type SchwabRetailFlowsEvidence = {
  seriesId: typeof SERIES;
  classId: typeof CLASS;
  accession: string;
  filed: string;
  acceptedAt: string;
  firstVerifiedAt: string;
  publiclyKnownBy: string;
  days: number;
  netFlowCents: string;
  netAssetsCents: string;
  yieldFraction: string;
  indexSHA256: string;
  xmlSHA256: string;
};
type RetailSignal = Signal & { schwabRetailFlows?: SchwabRetailFlowsEvidence };
type BlobReceipt = { url: string; capturedAt: string; sha256: string; compressed: string };
const stamp = (day: string, clock: string) => newYorkTimestamp(day.replaceAll("-", "") + "T" + clock)!;
const plusDay = (day: string) => new Date(Date.parse(day) + DAY).toISOString().slice(0, 10);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const instant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hashValue = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
function endOfMonth(day: string) {
  return publicDate(day) === day && plusDay(day).endsWith("-01");
}
function folder(a: string) {
  return "https://www.sec.gov/Archives/edgar/data/857156/" + a.replaceAll("-", "") + "/";
}
function indexUrl(a: string) {
  return folder(a) + a + "-index.htm";
}
function baseline(now: string): RetailSignal {
  return {
    id: SCHWAB_RETAIL_FLOWS_ID,
    family: "retail",
    title: "Schwab retail money market flows",
    shortLabel: "Retail cash flows",
    instruments: ["MARKET"],
    directionalInstruments: [],
    status: "unavailable",
    summary: "A verified monthly retail money market filing is pending.",
    source: {
      name: "SEC EDGAR · Schwab Prime Advantage Money Fund",
      url: CATALOG,
      retrievedAt: now,
      observedAt: null,
      releasedAt: null,
      frequency: "monthly",
      attribution: "Schwab Prime Advantage Money Fund Investor Shares (SWVXX), Form N-MFP3, SEC EDGAR.",
      usage,
      sha256: null,
    },
    methodology: method,
    limitation,
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 70,
    unit: "%",
  };
}
async function fetchBytes(url: string, limit: number, fetcher: Fetcher) {
  const response = await sourceResponse(fetcher, url, {
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
    headers: {
      "User-Agent": "The Daily Consensus source research support@thedailyconsensus.com",
      Accept: "application/xml,application/json,text/html",
    },
  });
  if (response.url && response.url !== url) throw new RetailEvidenceError("SEC source URL changed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new RetailEvidenceError("SEC source exceeded its bounded size");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new RetailEvidenceError("Empty SEC original");
  return Buffer.concat(chunks);
}
async function original(
  url: string,
  name: string,
  limit: number,
  fetcher: Fetcher,
  now: () => string,
  dir?: string,
) {
  let verified: Buffer | undefined;
  const receipt = await immutableSecReceipt<BlobReceipt>(
    dir,
    name,
    async () => {
      const b = await fetchBytes(url, limit, fetcher);
      return { url, capturedAt: now(), sha256: sha(b), compressed: gzipSync(b).toString("base64") };
    },
    (r) => {
      if (r.url !== url || !instant(r.capturedAt) || r.capturedAt > now() || !hashValue(r.sha256))
        throw new RetailEvidenceError("Invalid private SEC capture identity or time");
      const b = gunzipSync(Buffer.from(r.compressed, "base64"), { maxOutputLength: limit });
      if (!b.length || sha(b) !== r.sha256) throw new RetailEvidenceError("Private SEC filing bytes changed");
      verified = b;
    },
  );
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(verified!),
    sha256: receipt.sha256,
    capturedAt: receipt.capturedAt,
  };
}
function listFilings(text: string, at: string): Filing[] {
  const catalog = JSON.parse(text);
  if (Number(catalog.cik) !== Number(CIK)) throw new RetailEvidenceError("Wrong SEC registrant");
  const columns = catalog.filings?.recent as Record<FilingColumn, string[]> | undefined;
  if (
    !columns ||
    !Array.isArray(columns.form) ||
    !filingColumns.every((key) => Array.isArray(columns[key]) && columns[key].length === columns.form.length)
  ) {
    throw new RetailEvidenceError("Incomplete SEC filing catalog");
  }
  const today = newYorkDate(at);
  const earliestDate = new Date(Date.parse(today) - 105 * DAY).toISOString().slice(0, 10);
  const filings: Filing[] = [];
  for (const [i, form] of columns.form.entries()) {
    if (form !== "N-MFP3" && form !== "N-MFP3/A") continue;
    const filed = columns.filingDate[i];
    const accepted = columns.acceptanceDateTime[i];
    if (filed < earliestDate || filed > today || accepted > at) continue;
    const accession = columns.accessionNumber[i];
    const period = columns.reportDate[i];
    if (
      !instant(accepted) ||
      publicDate(filed) !== filed ||
      !endOfMonth(period) ||
      period >= filed ||
      !accessionPattern.test(accession)
    ) {
      throw new RetailEvidenceError("Invalid SEC month or filing clock");
    }
    const lag = Date.parse(filed) - Date.parse(newYorkDate(accepted));
    if (lag < 0 || lag > 7 * DAY) throw new RetailEvidenceError("Inconsistent SEC filing and acceptance dates");
    filings.push({ accession, form, period, filed, accepted });
  }
  if (new Set(filings.map((filing) => filing.accession)).size !== filings.length) {
    throw new RetailEvidenceError("Duplicate accession");
  }
  return filings;
}
const plain = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
function belongs(f: Filing, html: string) {
  const field = (name: string) =>
    plain(
      html.match(new RegExp('class="infoHead">' + name + '</div>\\s*<div class="info">([^<]+)</div>', "i"))?.[1] ??
        "",
    );
  if (field("Filing Date") !== f.filed || field("Period of Report") !== f.period)
    throw new RetailEvidenceError("SEC accession report and filing date differ from catalog");
  const accepted = field("Accepted").match(/^(\d{4}-\d\d-\d\d) (\d\d):(\d\d):(\d\d)$/);
  if (!accepted || stamp(accepted[1], accepted.slice(2).join("")) !== f.accepted)
    throw new RetailEvidenceError("SEC accession acceptance differs from catalog");
  const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const series = rows.flatMap((row) => [...plain(row).matchAll(/\bSeries (S\d{9})\b/g)].map((m) => m[1]));
  if (series.length !== 1) throw new RetailEvidenceError("Ambiguous SEC money fund series");
  if (series[0] !== SERIES) return false;
  const share = rows.filter((row) => plain(row).includes("Class/Contract " + CLASS));
  if (share.length !== 1 || !/\bInvestor Shares SWVXX\b/.test(plain(share[0])))
    throw new RetailEvidenceError("Original index does not confirm the investor share class");
  const rawPath = new URL(folder(f.accession) + "primary_doc.xml").pathname;
  if (
    rows.filter((row) => row.includes('href="' + rawPath + '"') && plain(row).split(" ").includes(f.form))
      .length !== 1
  )
    throw new RetailEvidenceError("Original SEC XML missing from index");
  return true;
}
function pieces(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g"))].map((m) => m[1].trim());
}
function one(xml: string, tag: string) {
  const values = pieces(xml, tag);
  if (values.length !== 1 || !values[0]) throw new RetailEvidenceError("Missing or duplicate SEC field " + tag);
  return values[0];
}
function cents(s: string) {
  if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(s)) throw new RetailEvidenceError("Invalid reported dollar amount");
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function rate(s: string) {
  if (typeof s !== "string" || !/^-?(?:0|1)(?:\.\d{1,9})?$/.test(s) || Number(s) < -0.05 || Number(s) > 0.25)
    throw new RetailEvidenceError("Unrecognized class net yield");
  return s;
}
function uniqueDays(values: string[], period: string) {
  if (
    values.length < 15 ||
    values.length > 24 ||
    values.some(
      (v, i) =>
        publicDate(v) !== v || v.slice(0, 7) !== period.slice(0, 7) || v > period || (i > 0 && v <= values[i - 1]),
    )
  )
    throw new RetailEvidenceError("Invalid or duplicate monthly operating dates");
  return values;
}
export function parseSchwabRetailXml(xml: string, period: string) {
  const stop = xml.indexOf("<scheduleOfPortfolioSecuritiesInfo>");
  if (
    !endOfMonth(period) ||
    stop < 1 ||
    stop > 2_000_000 ||
    /<!(?:DOCTYPE|ENTITY|\[CDATA\[)|<!--/i.test(xml.slice(0, stop))
  )
    throw new RetailEvidenceError("Unsupported original N-MFP3 layout");
  const header = xml.slice(0, stop),
    general = one(header, "generalInfo"),
    series = one(header, "seriesLevelInfo");
  if (
    one(one(header, "headerData"), "submissionType") !== "N-MFP3" ||
    one(general, "reportDate") !== period ||
    one(general, "cik") !== CIK ||
    one(general, "seriesId") !== SERIES ||
    one(general, "finalFilingFlag") !== "N" ||
    one(general, "fundAcqrdOrMrgdWthAnthrFlag") !== "N" ||
    one(series, "fundRetailMoneyMarketFlag") !== "Y" ||
    one(series, "moneyMarketFundCategory") !== "Prime" ||
    one(series, "masterFundFlag") !== "N" ||
    one(series, "feederFundFlag") !== "N"
  )
    throw new RetailEvidenceError("Wrong or changed retail portfolio, filing or share structure");
  const classes = pieces(header, "classLevelInfo"),
    ids = classes.map((x) => one(x, "classesId"));
  if (
    classes.length !== Number(one(general, "totalShareClassesInSeries")) ||
    ids.length !== new Set(ids).size ||
    classes.reduce((sum, x) => sum + cents(one(x, "netAssetsOfClass")), 0n) !==
      cents(one(series, "netAssetOfSeries"))
  )
    throw new RetailEvidenceError("Share class net assets do not reconcile to the series");
  const item = classes[ids.indexOf(CLASS)];
  if (!item || one(item, "classFullName") !== "Investor Shares")
    throw new RetailEvidenceError("Wrong retail share class");
  const assets = cents(one(item, "netAssetsOfClass")),
    monthly = one(item, "monthlyShareholderFlowReported"),
    sub = cents(one(monthly, "totalGrossSubscriptions")),
    redeem = cents(one(monthly, "totalGrossRedemptions"));
  const daily = pieces(item, "dialyShareholderFlowReported"); // Exact SEC N-MFP3 element spelling.
  const days = uniqueDays(
    daily.map((v) => one(v, "dailyShareHolderFlowDate")),
    period,
  );
  const yields = pieces(item, "sevenDayNetYield"),
    yieldDays = yields.map((v) => one(v, "sevenDayNetYieldDate"));
  if (
    !assets ||
    days.join(",") !== pieces(item, "dailyNetAssetValuePerShareDateClass").join(",") ||
    days.join(",") !== yieldDays.join(",") ||
    daily.reduce((sum, v) => sum + cents(one(v, "dailyGrossSubscriptions")), 0n) !== sub ||
    daily.reduce((sum, v) => sum + cents(one(v, "dailyGrossRedemptions")), 0n) !== redeem
  )
    throw new RetailEvidenceError(
      "Reported monthly class flows or operating dates disagree with the daily entries",
    );
  const yieldFraction = rate(one(yields.at(-1)!, "sevenDayNetYieldValue"));
  return { days: days.length, netFlowCents: String(sub - redeem), netAssetsCents: String(assets), yieldFraction };
}

function earliestPublic(filed: string, accepted: string): string {
  return filed > newYorkDate(accepted) ? stamp(filed, "060000") : accepted;
}

function publicBound(filed: string, firstVerified: string): string {
  const followingMidnight = stamp(plusDay(filed), "000000");
  return firstVerified < followingMidnight ? firstVerified : followingMidnight;
}

function displayReading(e: SchwabRetailFlowsEvidence, period: string) {
  const net = Number(e.netFlowCents);
  const assets = Number(e.netAssetsCents);
  const percent = (net / assets) * 100;
  return {
    series: [{ date: period, value: percent }],
    metrics: [
      { label: "Net investor flows", value: net / 1e11, unit: "$B", date: period },
      { label: "Investor class net assets", value: assets / 1e11, unit: "$B", date: period },
      {
        label: "Seven-day net yield",
        value: Number((Number(e.yieldFraction) * 100).toFixed(9)),
        unit: "%",
        date: period,
      },
    ],
    summary: `SWVXX reported ${net < 0 ? "net outflows" : "net inflows"} of $${(Math.abs(net) / 1e11).toFixed(2)} billion, equal to ${Math.abs(percent).toFixed(2)}% of month-end investor class assets.`,
  };
}

export async function collectSchwabRetailFlows(
  fetcher: Fetcher = fetch,
  now: () => string = () => new Date().toISOString(),
  receiptDirectory?: string,
): Promise<RetailSignal> {
  const at = now();
  const base = baseline(at);
  // New registrant filings can include several sibling funds. Only network requests consume this budget.
  let lastRequest = -Infinity;
  const read: Fetcher = async (url, init) => {
    const delay = lastRequest + 200 - performance.now();
    if (delay > 0) await wait(delay);
    lastRequest = performance.now();
    return fetcher(url, init);
  };
  try {
    const catalog = await fetchBytes(CATALOG, 2_000_000, read);
    const filings = listFilings(catalog.toString("utf8"), at).filter(
      (f) => earliestPublic(f.filed, f.accepted) <= at,
    );
    const periods = [...new Set(filings.map((f) => f.period))].sort().reverse();
    for (const period of periods) {
      const group = filings.filter((f) => f.period === period);
      if (group.length > 48)
        throw new RetailEvidenceError("SEC filing group exceeds the expected registrant coverage");
      let selected: { filing: Filing; capturedAt: string; sha256: string } | undefined;
      for (const filing of group) {
        const index = await original(
          indexUrl(filing.accession),
          filing.accession + "-index.json",
          250_000,
          read,
          now,
          receiptDirectory,
        );
        if (!belongs(filing, index.text)) continue;
        if (filing.form !== "N-MFP3")
          throw new RetailEvidenceError("SEC published an amendment for this retail fund month");
        if (selected) throw new RetailEvidenceError("Multiple original SEC filings match this retail fund month");
        selected = { filing, capturedAt: index.capturedAt, sha256: index.sha256 };
      }
      if (!selected) continue;
      const f = selected.filing;
      const xml = await original(
        folder(f.accession) + "primary_doc.xml",
        f.accession + "-xml.json",
        MAX_XML,
        read,
        now,
        receiptDirectory,
      );
      const reading = parseSchwabRetailXml(xml.text, period);
      const firstVerifiedAt = selected.capturedAt > xml.capturedAt ? selected.capturedAt : xml.capturedAt;
      const e: SchwabRetailFlowsEvidence = {
        seriesId: SERIES,
        classId: CLASS,
        accession: f.accession,
        filed: f.filed,
        acceptedAt: f.accepted,
        firstVerifiedAt,
        publiclyKnownBy: publicBound(f.filed, firstVerifiedAt),
        indexSHA256: selected.sha256,
        xmlSHA256: xml.sha256,
        ...reading,
      };
      const signal: RetailSignal = {
        ...base,
        status: "available",
        ...displayReading(e, period),
        schwabRetailFlows: e,
        source: {
          ...base.source,
          url: indexUrl(f.accession),
          retrievedAt: now(),
          observedAt: period,
          releasedAt: f.filed,
          sha256: e.xmlSHA256,
        },
      };
      validateSchwabRetailFlows(signal);
      return signal;
    }
    throw new RetailEvidenceError("No recent original SEC filing matched the SWVXX series and class");
  } catch (error) {
    const failureKind = sourceFailureKind(error);
    let collectionNote = "SEC source or private receipt could not be verified.";
    if (failureKind === "transport") collectionNote = "SEC filing transport failed.";
    if (error instanceof RetailEvidenceError) collectionNote = error.message;
    return { ...base, failureKind, collectionNote };
  }
}

const evidenceKeys = [
  "seriesId",
  "classId",
  "accession",
  "filed",
  "acceptedAt",
  "firstVerifiedAt",
  "publiclyKnownBy",
  "days",
  "netFlowCents",
  "netAssetsCents",
  "yieldFraction",
  "indexSHA256",
  "xmlSHA256",
]
  .sort()
  .join(",");
export function validateSchwabRetailFlows(signal: RetailSignal, archiveCutoff?: string) {
  const evidence = signal.schwabRetailFlows;
  if (signal.id !== SCHWAB_RETAIL_FLOWS_ID) {
    if (evidence !== undefined)
      throw new RetailEvidenceError("Schwab retail evidence is attached to another signal");
    return;
  }
  const source = signal.source;
  const base = baseline(source.retrievedAt);
  if (
    signal.family !== "retail" ||
    signal.instruments.join(",") !== "MARKET" ||
    signal.directionalInstruments?.length !== 0 ||
    Object.keys(signal.scores).sort().join(",") !== "daily,monthly,weekly" ||
    Object.values(signal.scores).some((value) => value !== null)
  ) {
    throw new RetailEvidenceError("Schwab retail context cannot cast a vote");
  }
  if (
    signal.staleAfterDays !== base.staleAfterDays ||
    signal.unit !== base.unit ||
    source.name !== base.source.name ||
    source.attribution !== base.source.attribution ||
    source.usage !== usage ||
    source.frequency !== base.source.frequency ||
    signal.methodology !== method ||
    signal.limitation !== limitation
  ) {
    throw new RetailEvidenceError("Invalid Schwab retail attribution or calculation policy");
  }
  if (
    !instant(source.retrievedAt) ||
    (archiveCutoff !== undefined && (!instant(archiveCutoff) || source.retrievedAt > archiveCutoff))
  ) {
    throw new RetailEvidenceError("Invalid Schwab retail source or archive cutoff time");
  }
  if (signal.status === "unavailable") {
    if (
      evidence !== undefined ||
      source.url !== CATALOG ||
      source.observedAt !== null ||
      source.releasedAt !== null ||
      source.sha256 !== null ||
      signal.series.length ||
      signal.metrics.length
    ) {
      throw new RetailEvidenceError("Unavailable Schwab retail context contains a reading");
    }
    return;
  }
  const period = source.observedAt;
  if (
    signal.status !== "available" ||
    !period ||
    !endOfMonth(period) ||
    !evidence ||
    evidence.seriesId !== SERIES ||
    evidence.classId !== CLASS ||
    Object.keys(evidence).sort().join(",") !== evidenceKeys ||
    !accessionPattern.test(evidence.accession) ||
    source.url !== indexUrl(evidence.accession) ||
    source.sha256 !== evidence.xmlSHA256 ||
    !hashValue(evidence.xmlSHA256) ||
    !hashValue(evidence.indexSHA256)
  ) {
    throw new RetailEvidenceError("Invalid Schwab retail report, fund, class or source digest");
  }
  const { filed, acceptedAt, firstVerifiedAt, publiclyKnownBy } = evidence;
  if (
    source.releasedAt !== filed ||
    publicDate(filed) !== filed ||
    filed <= period ||
    !instant(acceptedAt) ||
    !instant(firstVerifiedAt) ||
    newYorkDate(acceptedAt) > filed ||
    Date.parse(filed) - Date.parse(newYorkDate(acceptedAt)) > 7 * DAY
  ) {
    throw new RetailEvidenceError("Invalid Schwab retail submission and filing chronology");
  }
  const opening = earliestPublic(filed, acceptedAt);
  if (
    firstVerifiedAt < opening ||
    firstVerifiedAt > source.retrievedAt ||
    publiclyKnownBy !== publicBound(filed, firstVerifiedAt) ||
    publiclyKnownBy < opening
  ) {
    throw new RetailEvidenceError("Invalid Schwab retail public availability");
  }
  if (
    !Number.isInteger(evidence.days) ||
    evidence.days < 15 ||
    evidence.days > 24 ||
    typeof evidence.netFlowCents !== "string" ||
    !/^(?:0|-?[1-9]\d{0,17})$/.test(evidence.netFlowCents) ||
    typeof evidence.netAssetsCents !== "string" ||
    !/^[1-9]\d{0,17}$/.test(evidence.netAssetsCents)
  ) {
    throw new RetailEvidenceError("Invalid Schwab retail filed aggregate or operating days");
  }
  rate(evidence.yieldFraction);
  const expected = displayReading(evidence, period);
  const point = signal.series[0];
  if (
    signal.series.length !== 1 ||
    point?.date !== period ||
    point.value !== expected.series[0].value ||
    Object.keys(point).sort().join(",") !== "date,value" ||
    signal.metrics.length !== expected.metrics.length ||
    signal.summary !== expected.summary
  ) {
    throw new RetailEvidenceError("Schwab retail display disagrees with the filed aggregate");
  }
  for (const [index, metric] of signal.metrics.entries()) {
    const expectedMetric = expected.metrics[index];
    if (
      metric.label !== expectedMetric.label ||
      metric.date !== period ||
      metric.unit !== expectedMetric.unit ||
      metric.value !== expectedMetric.value ||
      Object.keys(metric).sort().join(",") !== "date,label,unit,value"
    ) {
      throw new RetailEvidenceError("Schwab retail metrics disagree with the filed aggregate");
    }
  }
}
