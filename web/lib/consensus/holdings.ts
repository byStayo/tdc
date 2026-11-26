import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import type { Signal } from "./types.ts";
import { sourceFailureKind } from "./source-failure.ts";

export const HOLDINGS_MANAGERS = [
  { id: "berkshire", cik: "0001067983", name: "Berkshire Hathaway" },
  { id: "bridgewater", cik: "0001350694", name: "Bridgewater Associates" },
] as const;
type Manager = (typeof HOLDINGS_MANAGERS)[number];
type Document = { text: string; sha256: string; retrievedAt: string };
type FetchText = (url: string) => Promise<Document>;
export interface HoldingPosition {
  issuer: string;
  securityClass: string;
  valueUSD: number;
  shares: number;
}
export interface HoldingReport {
  accession: string;
  period: string;
  filedAt: string;
  url: string;
  tableUrl: string;
  coverUrl: string;
  retrievedAt: string;
  hashes: { submissions: string; index: string; cover: string; table: string };
  rowCount: number;
  reportedValueUSD: number;
  shareValueUSD: number;
  sharePositions: number;
  excludedValueUSD: number;
  remainingValueUSD: number;
  confidentialOmitted: boolean;
  top: HoldingPosition[];
}
export interface InstitutionalHoldings {
  id: string;
  cik: string;
  name: string;
  current: HoldingReport;
  previous: HoldingReport;
}
export interface FilingIdentity {
  accession: string;
  period: string;
  filedAt: string;
}
const validDate = (value: string) =>
  typeof value === "string" && value.length === 10 && !!publicDate(value);
const validInstant = (value: string) =>
  typeof value === "string" &&
  !!publicDate(value) &&
  new Date(value).toISOString() === value;
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const baseURL = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/`;

/** A bounded, recent 13F pair. Amendments require explicit reconciliation, never silent substitution. */
export function selectHoldingsFilings(
  raw: unknown,
  cik: string,
  cutoff: string,
): FilingIdentity[] {
  const data = raw as {
    cik?: string | number;
    filings?: { recent?: Record<string, unknown[]> };
  };
  const r = data?.filings?.recent;
  if (
    String(data?.cik).padStart(10, "0") !== cik ||
    !r ||
    !["form", "filingDate", "reportDate", "accessionNumber"].every(
      (k) => Array.isArray(r[k]) && r[k].length === r.form?.length,
    ) ||
    r.form.length > 2000
  )
    throw new Error("Invalid SEC manager submissions");
  const filings = r.form.flatMap((form, i) => {
    if (typeof form !== "string" || !form.startsWith("13F-")) return [];
    const filedAt = r.filingDate[i] as string,
      period = r.reportDate[i] as string,
      accession = r.accessionNumber[i] as string;
    if (
      !validDate(filedAt) ||
      !validDate(period) ||
      period > filedAt ||
      !/^\d{10}-\d{2}-\d{6}$/.test(accession)
    )
      throw new Error("Invalid 13F filing identity");
    return filedAt <= cutoff.slice(0, 10)
      ? [{ form, filedAt, period, accession }]
      : [];
  });
  const periods = [...new Set(filings.map((f) => f.period))]
    .sort()
    .reverse()
    .slice(0, 2);
  if (
    periods.length !== 2 ||
    periods.some(
      (p) => p < "2023-01-03" || !/-(03-31|06-30|09-30|12-31)$/.test(p),
    )
  )
    throw new Error(
      "Two current-format quarterly holdings reports are required",
    );
  const lag = Date.parse(periods[0]) - Date.parse(periods[1]);
  if (lag < 85 * 86400000 || lag > 95 * 86400000)
    throw new Error("Nonconsecutive 13F quarters");
  return periods.map((period) => {
    const group = filings.filter((f) => f.period === period);
    if (group.length !== 1 || group[0].form !== "13F-HR")
      throw new Error("13F amendment or notice requires reconciliation");
    const { accession, filedAt } = group[0];
    return { accession, period, filedAt };
  });
}

function cleanXML(raw: string, root: string, namespace: string): string {
  if (raw.length > 2_000_000 || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(raw))
    throw new Error("Unsupported 13F XML");
  const xml = raw
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const open = new RegExp(`^<(?:[A-Za-z_][\\w.-]*:)?${root}\\b([^>]*)>`).exec(
    xml,
  );
  if (
    !open ||
    !open[1].includes(`"${namespace}"`) ||
    !new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${root}>$`).test(xml)
  )
    throw new Error("Unexpected 13F XML root");
  return xml;
}
function fields(xml: string, tag: string): string[] {
  return [
    ...xml.matchAll(
      new RegExp(
        `<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}>`,
        "g",
      ),
    ),
  ].map((m) => m[1]);
}
function one(xml: string, tag: string, optional = false): string {
  const values = fields(xml, tag);
  if (optional && !values.length) return "";
  if (values.length !== 1 || /[<>]/.test(values[0]))
    throw new Error(`Ambiguous 13F ${tag}`);
  if (/&(?!(?:#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(values[0]))
    throw new Error("Unknown XML entity");
  return values[0]
    .trim()
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
      if (code.startsWith("#")) {
        const point = Number.parseInt(
          code.slice(code[1] === "x" ? 2 : 1),
          code[1] === "x" ? 16 : 10,
        );
        if (
          point < 32 ||
          point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff)
        )
          throw new Error("Invalid XML character");
        return String.fromCodePoint(point);
      }
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<
          string,
          string
        >
      )[code.toLowerCase()];
    });
}
function amount(xml: string, tag: string): number {
  const value = one(xml, tag);
  if (!/^\d{1,16}$/.test(value) || !integer(Number(value)))
    throw new Error(`Invalid 13F ${tag}`);
  return Number(value);
}
function reportDate(value: string): string {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(value))
    throw new Error("Invalid 13F report date");
  const [month, day, year] = value.split("-");
  const date = `${year}-${month}-${day}`;
  if (!validDate(date)) throw new Error("Invalid 13F report date");
  return date;
}

/** Values are dollars for filings since Jan 3 2023. Options/principal amounts never enter share allocations. */
export function parseHoldingsReport(
  coverRaw: string,
  tableRaw: string,
  cik: string,
  identity: FilingIdentity,
): Pick<
  HoldingReport,
  | "rowCount"
  | "reportedValueUSD"
  | "shareValueUSD"
  | "sharePositions"
  | "excludedValueUSD"
  | "remainingValueUSD"
  | "confidentialOmitted"
  | "top"
> {
  const cover = cleanXML(
      coverRaw,
      "edgarSubmission",
      "http://www.sec.gov/edgar/thirteenffiler",
    ),
    table = cleanXML(
      tableRaw,
      "informationTable",
      "http://www.sec.gov/edgar/document/thirteenf/informationtable",
    );
  if (
    one(cover, "submissionType") !== "13F-HR" ||
    one(cover, "cik").padStart(10, "0") !== cik ||
    reportDate(one(cover, "periodOfReport")) !== identity.period ||
    reportDate(one(cover, "reportCalendarOrQuarter")) !== identity.period ||
    !["false", "0"].includes(one(cover, "isAmendment")) ||
    one(cover, "reportType") !== "13F HOLDINGS REPORT" ||
    identity.filedAt < "2023-01-03"
  )
    throw new Error("13F cover and filing identity disagree");
  const confidential = one(cover, "isConfidentialOmitted");
  if (!["true", "false", "1", "0"].includes(confidential))
    throw new Error("Unknown confidential-treatment flag");
  const rows = fields(table, "infoTable"),
    expected = amount(cover, "tableEntryTotal"),
    reportedValueUSD = amount(cover, "tableValueTotal");
  if (!rows.length || rows.length > 5000 || rows.length !== expected)
    throw new Error("13F row count mismatch");
  const positions = new Map<string, HoldingPosition>(),
    seen = new Set<string>();
  let total = 0,
    shareValueUSD = 0;
  for (const row of rows) {
    const issuer = one(row, "nameOfIssuer"),
      securityClass = one(row, "titleOfClass"),
      cusip = one(row, "cusip"),
      valueUSD = amount(row, "value"),
      shares = amount(row, "sshPrnamt"),
      kind = one(row, "sshPrnamtType"),
      option = one(row, "putCall", true);
    if (
      !text(issuer, 200) ||
      !text(securityClass, 150) ||
      !/^[A-Z0-9*@#]{9}$/.test(cusip) ||
      !["SH", "PRN"].includes(kind) ||
      !["", "Put", "Call", "PUT", "CALL"].includes(option)
    )
      throw new Error("Unexpected 13F position schema");
    const signature = row.replace(/\s+/g, " ").trim();
    if (seen.has(signature))
      throw new Error("Duplicate 13F row requires review");
    seen.add(signature);
    total += valueUSD;
    if (kind !== "SH" || option) continue;
    shareValueUSD += valueUSD;
    const key = `${cusip}|${securityClass}`,
      prior = positions.get(key);
    if (prior && prior.issuer !== issuer)
      throw new Error("Inconsistent 13F issuer identity");
    positions.set(key, {
      issuer,
      securityClass,
      valueUSD: valueUSD + (prior?.valueUSD ?? 0),
      shares: shares + (prior?.shares ?? 0),
    });
  }
  if (
    !integer(total) ||
    total !== reportedValueUSD ||
    !shareValueUSD ||
    !integer(shareValueUSD)
  )
    throw new Error("13F values do not reconcile to the cover");
  if (
    [...positions.values()].some(
      (p) => !integer(p.valueUSD) || !integer(p.shares),
    )
  )
    throw new Error("Unsafe aggregate amount");
  const top = [...positions.values()]
    .sort((a, b) => b.valueUSD - a.valueUSD || a.issuer.localeCompare(b.issuer))
    .slice(0, 5);
  return {
    rowCount: rows.length,
    reportedValueUSD,
    shareValueUSD,
    sharePositions: positions.size,
    excludedValueUSD: total - shareValueUSD,
    remainingValueUSD:
      shareValueUSD - top.reduce((sum, p) => sum + p.valueUSD, 0),
    confidentialOmitted: confidential === "true" || confidential === "1",
    top,
  };
}

export function holdingsSignal(item: InstitutionalHoldings): Signal {
  const r = item.current,
    p = item.previous;
  return {
    id: `sec-holdings-${item.id}`,
    family: "institutions",
    title: `${item.name} · disclosed share holdings`,
    shortLabel: `${item.name} 13F`,
    instruments: ["MARKET", "SPY", "QQQ", "IWM", "DIA"],
    status: "available",
    summary: `${item.name} reported ${r.sharePositions} non-option share positions for ${r.period}, filed ${r.filedAt}. This selected filing is delayed broad-equity context.`,
    source: {
      name: "SEC EDGAR · Form 13F",
      url: r.url,
      observedAt: r.period,
      releasedAt: r.filedAt,
      retrievedAt: r.retrievedAt,
      frequency: "quarterly holdings",
      sha256: hash(r.hashes),
      attribution: `${item.name}; original filing via SEC EDGAR`,
      usage:
        "Selected factual aggregates and largest positions derived from public SEC filings; original documents linked. No personal contact or signature information is republished.",
    },
    methodology:
      "Original current and preceding-quarter 13F-HR cover and information tables reconcile by entry count and reported dollar value. Non-option SH rows aggregate by security identifier and class. Five largest positions are ranked by disclosed value; their weights use the non-option share subtotal. Each manager is separate; no directional vote or cross-manager market total.",
    limitation:
      "Quarter-end positions can lag publication by 45 days and do not cover the complete portfolio, cash or shorts. Changes in disclosed value mix price and position changes; they are not returns or capital flows. Amendments/notices require reconciliation. These two selected managers do not represent all institutions or an ETF's holdings.",
    series: [
      { date: p.period, value: p.shareValueUSD / 1e9 },
      { date: r.period, value: r.shareValueUSD / 1e9 },
    ],
    metrics: [
      {
        label: "Reported non-option shares",
        value: r.shareValueUSD / 1e9,
        unit: "USD billion",
        date: r.period,
      },
      {
        label: "Distinct share positions",
        value: r.sharePositions,
        unit: "positions",
        date: r.period,
      },
      {
        label: "Other reported value excluded",
        value: r.excludedValueUSD / 1e9,
        unit: "USD billion",
        date: r.period,
      },
    ],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 150,
    unit: "USD billion",
  };
}

function validateReport(
  r: HoldingReport,
  manager: Manager,
  cutoff: string,
): void {
  if (
    !r ||
    !/^\d{10}-\d{2}-\d{6}$/.test(r.accession) ||
    !validDate(r.period) ||
    !/-(03-31|06-30|09-30|12-31)$/.test(r.period) ||
    r.period < "2023-01-03" ||
    !validDate(r.filedAt) ||
    r.period > r.filedAt ||
    r.filedAt > cutoff.slice(0, 10) ||
    !validInstant(r.retrievedAt) ||
    r.retrievedAt > cutoff ||
    r.filedAt > r.retrievedAt.slice(0, 10)
  )
    throw new Error("Invalid 13F report dates");
  const base = baseURL(manager.cik, r.accession);
  if (
    r.url !== `${base}${r.accession}-index.html` ||
    r.coverUrl !== `${base}primary_doc.xml` ||
    !r.tableUrl.startsWith(base) ||
    !/^[A-Za-z0-9_.-]+\.xml$/.test(r.tableUrl.slice(base.length)) ||
    Object.keys(r.hashes ?? {})
      .sort()
      .join() !== "cover,index,submissions,table" ||
    Object.values(r.hashes).some((h) => !/^[a-f0-9]{64}$/.test(h))
  )
    throw new Error("Invalid 13F provenance");
  if (
    ![
      r.rowCount,
      r.reportedValueUSD,
      r.shareValueUSD,
      r.sharePositions,
      r.excludedValueUSD,
      r.remainingValueUSD,
    ].every(integer) ||
    r.rowCount < r.sharePositions ||
    r.rowCount > 5000 ||
    !r.sharePositions ||
    !r.shareValueUSD ||
    r.reportedValueUSD !== r.shareValueUSD + r.excludedValueUSD ||
    typeof r.confidentialOmitted !== "boolean" ||
    !Array.isArray(r.top) ||
    r.top.length !== Math.min(5, r.sharePositions) ||
    new Set(r.top.map((p) => `${p.issuer}|${p.securityClass}`)).size !==
      r.top.length ||
    r.top.some(
      (p, i) =>
        !text(p.issuer, 200) ||
        !text(p.securityClass, 150) ||
        !integer(p.valueUSD) ||
        !integer(p.shares) ||
        (i > 0 && p.valueUSD > r.top[i - 1].valueUSD),
    ) ||
    r.remainingValueUSD + r.top.reduce((sum, p) => sum + p.valueUSD, 0) !==
      r.shareValueUSD
  )
    throw new Error("Invalid 13F aggregates");
}
export function validateHoldings(
  items: InstitutionalHoldings[],
  cutoff: string,
): void {
  if (
    !Array.isArray(items) ||
    items.length > HOLDINGS_MANAGERS.length ||
    new Set(items.map((i) => i.id)).size !== items.length
  )
    throw new Error("Invalid institutional sample");
  for (const item of items) {
    const manager = HOLDINGS_MANAGERS.find((m) => m.id === item.id);
    if (!manager || manager.cik !== item.cik || manager.name !== item.name)
      throw new Error("Unknown institutional manager");
    validateReport(item.current, manager, cutoff);
    validateReport(item.previous, manager, cutoff);
    const lag =
      Date.parse(item.current.period) - Date.parse(item.previous.period);
    if (
      lag < 85 * 86400000 ||
      lag > 95 * 86400000 ||
      item.current.filedAt <= item.previous.filedAt
    )
      throw new Error("Invalid 13F quarter comparison");
  }
}

export async function collectHoldings(
  fetchText: FetchText,
  cutoff = new Date().toISOString(),
): Promise<{ holdings: InstitutionalHoldings[]; signals: Signal[] }> {
  const holdings: InstitutionalHoldings[] = [],
    signals: Signal[] = [];
  let nextRequestAt = 0;
  // Sequential and bounded. The caller's fetcher declares the product and limits response size/time.
  for (const manager of HOLDINGS_MANAGERS) {
    const request = async (url: string) => {
      const delay = Math.max(0, nextRequestAt - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextRequestAt = Date.now() + 200;
      return fetchText(url);
    };
    try {
      const submissions = await request(
        `https://data.sec.gov/submissions/CIK${manager.cik}.json`,
      );
      const selected = selectHoldingsFilings(
          JSON.parse(submissions.text),
          manager.cik,
          cutoff,
        ),
        reports: HoldingReport[] = [];
      for (const identity of selected) {
        const base = baseURL(manager.cik, identity.accession),
          index = await request(`${base}index.json`),
          directory = JSON.parse(index.text)?.directory?.item as {
            name: string;
          }[];
        if (
          !Array.isArray(directory) ||
          directory.length > 30 ||
          !directory.some((f) => f.name === "primary_doc.xml")
        )
          throw new Error("Invalid 13F archive index");
        const tables = directory.filter(
          (f) =>
            /^[A-Za-z0-9_.-]+\.xml$/.test(f.name) &&
            f.name !== "primary_doc.xml",
        );
        if (tables.length !== 1)
          throw new Error("Ambiguous 13F information table");
        const coverUrl = `${base}primary_doc.xml`,
          tableUrl = `${base}${tables[0].name}`,
          cover = await request(coverUrl),
          table = await request(tableUrl);
        reports.push({
          ...identity,
          url: `${base}${identity.accession}-index.html`,
          coverUrl,
          tableUrl,
          retrievedAt: [
            submissions.retrievedAt,
            index.retrievedAt,
            cover.retrievedAt,
            table.retrievedAt,
          ]
            .sort()
            .at(-1)!,
          hashes: {
            submissions: submissions.sha256,
            index: index.sha256,
            cover: cover.sha256,
            table: table.sha256,
          },
          ...parseHoldingsReport(cover.text, table.text, manager.cik, identity),
        });
      }
      const item = { ...manager, current: reports[0], previous: reports[1] };
      validateHoldings([item], new Date().toISOString());
      holdings.push(item);
      signals.push(holdingsSignal(item));
    } catch (error) {
      signals.push({
        id: `sec-holdings-${manager.id}`,
        family: "institutions",
        title: `${manager.name} · disclosed share holdings`,
        shortLabel: `${manager.name} 13F`,
        instruments: ["MARKET", "SPY", "QQQ", "IWM", "DIA"],
        status: "unavailable",
        summary: `Original holdings verification unavailable: ${error instanceof Error ? error.message : "source error"}.`,
        failureKind: sourceFailureKind(error),
        source: {
          name: "SEC EDGAR · Form 13F",
          url: `https://data.sec.gov/submissions/CIK${manager.cik}.json`,
          observedAt: null,
          releasedAt: null,
          retrievedAt: new Date().toISOString(),
          frequency: "quarterly holdings",
          sha256: null,
          attribution: "US Securities and Exchange Commission",
          usage: "Public filing source; no missing positions inferred.",
        },
        methodology:
          "A complete, reconciled original current/prior quarter filing pair is required. Unknown amendments and ambiguous tables fail closed.",
        limitation:
          "Selected quarterly disclosures cannot establish daily institutional flows or intent.",
        series: [],
        metrics: [],
        scores: { daily: null, weekly: null, monthly: null },
        staleAfterDays: 150,
        unit: "USD billion",
      });
    }
  }
  return { holdings, signals };
}
