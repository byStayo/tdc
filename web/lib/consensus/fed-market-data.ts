import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Point, Provenance } from "./types.ts";

type MacroSource = Pick<Provenance, "name" | "url" | "attribution" | "usage">;
export type PrimaryMacroReading = {
  series: Point[];
  sha256: string;
  retrievedAt: string;
  releasedAt: string | null;
  source?: MacroSource;
};
export type PrimaryMacroProvider = {
  source: MacroSource;
  read: () => Promise<PrimaryMacroReading>;
};
type Read = (url: string) => Promise<PublicDocument>;
const TREASURY_FIELDS = { DGS2: "2", DGS10: "10", DGS30: "30" } as const;
type TreasuryId = keyof typeof TREASURY_FIELDS;
const YIELD_ENDPOINT = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve";
const YIELD_CITATION = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve";
const BOARD_H15 = "https://www.federalreserve.gov/releases/h15/";
const BOARD_H15_PACKAGE = "https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=bf17364827e38702b42a58cf8eaa3f78&lastobs=260&from=&to=&filetype=csv&label=include&layout=seriescolumn&type=package";
const MARKET_API = "https://markets.newyorkfed.org/api";
const MARKET_TERMS = "https://www.newyorkfed.org/privacy/termsofuse";
const RATE_CITATIONS = {
  SOFR: "https://www.newyorkfed.org/markets/reference-rates/sofr",
  EFFR: "https://www.newyorkfed.org/markets/reference-rates/effr",
} as const;
type RefRate = keyof typeof RATE_CITATIONS;

export function checkedMacroPoints(points: Point[], through: string, label: string): Point[] {
  const sorted = points.sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length || sorted.some((row, index) =>
    publicDate(row.date) !== row.date || row.date > through || !Number.isFinite(row.value) ||
    (index > 0 && row.date === sorted[index - 1].date)))
    throw new Error(`Invalid dates or values in ${label}`);
  return sorted.slice(-260);
}

export function treasuryYieldPoints(xml: string, year: number, through: string): Record<TreasuryId, Point[]> {
  const series: Record<TreasuryId, Point[]> = { DGS2: [], DGS10: [], DGS30: [] };
  if (!xml.includes('xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"'))
    throw new Error("Unrecognized Treasury yield XML");
  const entries = [...xml.matchAll(/<m:properties>([\s\S]*?)<\/m:properties>/g)];
  if (!entries.length && through.startsWith(year + "-01-") && !/<entry\b/.test(xml)) return series;
  for (const [, entry] of entries) {
    const date = /<d:NEW_DATE\b[^>]*>(\d{4}-\d{2}-\d{2})T00:00:00<\/d:NEW_DATE>/.exec(entry)?.[1];
    if (!date || !date.startsWith(year + "-") || publicDate(date) !== date)
      throw new Error("Invalid Treasury yield date");
    for (const [id, tenor] of Object.entries(TREASURY_FIELDS) as [TreasuryId, string][]) {
      const field = new RegExp(`<d:BC_${tenor}YEAR\\b([^>]*?)(?:\\/\\s*>|>([^<]*)<\\/d:BC_${tenor}YEAR>)`).exec(entry);
      if (field && /\bm:null="true"/.test(field[1])) continue;
      const value = field?.[2];
      if (value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value))
        throw new Error(`Missing Treasury ${tenor}-year par yield`);
      series[id].push({ date, value: Number(value) });
    }
  }
  for (const id of Object.keys(TREASURY_FIELDS) as TreasuryId[])
    series[id] = checkedMacroPoints(series[id], through, "Treasury par yields");
  return series;
}

export function h15YieldPoints(csv: string, through: string): Record<TreasuryId, Point[]> {
  const rows = csv.trim().split(/\r?\n/).map(row => row.split(",").map(cell => cell.replaceAll('"', "").trim()));
  const units = rows.find(row => row[0] === "Unit:");
  const head = rows.findIndex(row => row[0] === "Time Period");
  if (head < 0 || !units) throw new Error("Missing Board H.15 metadata");
  const columns = rows[head];
  const series: Record<TreasuryId, Point[]> = { DGS2: [], DGS10: [], DGS30: [] };
  for (const id of Object.keys(TREASURY_FIELDS) as TreasuryId[]) {
    const code = `RIFLGFCY${TREASURY_FIELDS[id].padStart(2, "0")}_N.B`;
    const pos = columns.indexOf(code);
    if (pos < 1 || columns.lastIndexOf(code) !== pos || units[pos] !== "Percent:_Per_Year")
      throw new Error("Wrong H.15 series or units for " + id);
    const points = rows.slice(head + 1).flatMap(parts => {
      const [date] = parts;
      const value = parts[pos];
      if (parts.length !== columns.length || publicDate(date) !== date)
        throw new Error("Malformed H.15 data row");
      if (value === "ND" || value === "") return [];
      if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid H.15 par yield");
      return [{ date, value: Number(value) }];
    });
    series[id] = checkedMacroPoints(points, through, "H.15 constant maturities");
  }
  return series;
}

export function nyFedRatePoints(text: string, rate: RefRate, through: string): Point[] {
  const { refRates } = JSON.parse(text) as {
    refRates?: { type?: unknown; effectiveDate?: unknown; percentRate?: unknown }[];
  };
  if (!Array.isArray(refRates) || refRates.length > 260)
    throw new Error(`Unexpected New York Fed ${rate} list`);
  const points = refRates.map(row => {
    if (row.type !== rate || typeof row.effectiveDate !== "string" || typeof row.percentRate !== "number")
      throw new Error(`Unexpected New York Fed ${rate} row`);
    return { date: row.effectiveDate, value: row.percentRate };
  });
  return checkedMacroPoints(points, through, rate);
}

export function nyFedReverseRepo(text: string, retrievedAt: string): Pick<PrimaryMacroReading, "series" | "releasedAt"> {
  const { repo } = JSON.parse(text) as { repo?: { operations?: Record<string, unknown>[] } };
  if (!Array.isArray(repo?.operations) || repo.operations.length > 450)
    throw new Error("Unexpected New York Fed overnight reverse repo list");
  const reports = new Map<string, string>();
  const points: Point[] = [];
  for (const row of repo.operations) {
    if (typeof row.note === "string" && /small value exercise/i.test(row.note)) continue;
    const date = row.operationDate;
    const amount = row.totalAmtAccepted;
    const updated = typeof row.lastUpdated === "string" ? row.lastUpdated : "";
    const timestamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(updated);
    const issuedAt = timestamp && newYorkTimestamp(timestamp[1].replaceAll("-", "") + "T" + timestamp.slice(2).join(""));
    const detail = Array.isArray(row.details) && row.details.length === 1 ? row.details[0] : null;
    if (row.auctionStatus !== "Results" || row.operationType !== "Reverse Repo" || row.operationMethod !== "Fixed Rate" ||
        row.term !== "Overnight" || typeof date !== "string" || row.settlementDate !== date ||
        !issuedAt || issuedAt > retrievedAt || timestamp![1] < date ||
        typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 ||
        detail?.securityType !== "Treasury" || detail?.amtAccepted !== amount)
      throw new Error("Invalid regular Treasury overnight reverse repo result");
    reports.set(date, issuedAt);
    points.push({ date, value: amount / 1e9 });
  }
  const series = checkedMacroPoints(points, newYorkDate(retrievedAt), "overnight reverse repo");
  return { series, releasedAt: reports.get(series.at(-1)!.date)! };
}

function referenceRateSource(rate: RefRate): PrimaryMacroProvider["source"] {
  return {
    name: "Federal Reserve Bank of New York · " + rate,
    url: RATE_CITATIONS[rate],
    attribution: rate + " data from the Federal Reserve Bank of New York.",
    usage: `The ${rate} data are subject to the New York Fed Terms of Use at ${MARKET_TERMS}. The New York Fed disclaims responsibility for publication by The Daily Consensus, endorsement of this republication, and liability for use.`,
  };
}

export function fedMarketProviders(read: Read, now: string): Record<TreasuryId | RefRate | "RRPONTSYD", PrimaryMacroProvider> {
  const today = newYorkDate(now);
  const year = Number(today.slice(0, 4));
  let yields: Promise<{ [Id in TreasuryId]: PrimaryMacroReading }> | undefined;

  async function readYields() {
    const latest = await read(YIELD_ENDPOINT + "&field_tdr_date_value=" + year);
    const series = treasuryYieldPoints(latest.text, year, newYorkDate(latest.retrievedAt));
    // Cross the year boundary whenever the current file cannot supply a full
    // 21-observation change. Ordinary days need just one Treasury request.
    const prior = Object.values(series).some(points => points.length < 22)
      ? await read(YIELD_ENDPOINT + "&field_tdr_date_value=" + (year - 1)) : null;
    const previous = prior ? treasuryYieldPoints(prior.text, year - 1, newYorkDate(prior.retrievedAt)) : null;
    const sha256 = prior
      ? createHash("sha256").update(prior.sha256 + "\n" + latest.sha256).digest("hex")
      : latest.sha256;
    const retrievedAt = prior?.retrievedAt ?? latest.retrievedAt;
    const reading = (id: TreasuryId) => ({
      series: [...(previous?.[id] ?? []), ...series[id]].slice(-260),
      retrievedAt, sha256, releasedAt: null,
    });
    return { DGS2: reading("DGS2"), DGS10: reading("DGS10"), DGS30: reading("DGS30") };
  }

  async function boardYields() {
    const doc = await read(BOARD_H15_PACKAGE);
    const series = h15YieldPoints(doc.text, newYorkDate(doc.retrievedAt));
    const source = {
      name: "Federal Reserve Board · H.15 Selected Interest Rates",
      url: BOARD_H15,
      attribution: "Board of Governors of the Federal Reserve System.",
      usage: "H.15 nominal Treasury constant-maturity yields in percent per annum. The Board publishes its own release vintage.",
    };
    const reading = (id: TreasuryId) => ({ ...doc, series: series[id], releasedAt: null, source });
    return { DGS2: reading("DGS2"), DGS10: reading("DGS10"), DGS30: reading("DGS30") };
  }

  function treasury(id: TreasuryId): PrimaryMacroProvider {
    return {
      source: {
        name: "U.S. Department of the Treasury · Daily Treasury Par Yield Curve Rates",
        url: YIELD_CITATION,
        attribution: "U.S. Department of the Treasury.",
        usage: "Official published Treasury constant-maturity par yields, in percent per annum.",
      },
      read: async () => (await (yields ??= readYields().catch(() => boardYields())))[id],
    };
  }
  function rate(id: RefRate, path: string): PrimaryMacroProvider {
    return {
      source: referenceRateSource(id),
      async read() {
        const doc = await read(MARKET_API + "/rates/" + path + "/last/260.json");
        return { ...doc, releasedAt: null, series: nyFedRatePoints(doc.text, id, newYorkDate(doc.retrievedAt)) };
      },
    };
  }
  return {
    DGS2: treasury("DGS2"), DGS10: treasury("DGS10"), DGS30: treasury("DGS30"),
    SOFR: rate("SOFR", "secured/sofr"), EFFR: rate("EFFR", "unsecured/effr"),
    RRPONTSYD: {
      source: {
        name: "Federal Reserve Bank of New York · Overnight Reverse Repo",
        url: "https://www.newyorkfed.org/markets/desk-operations/reverse-repo",
        attribution: "Federal Reserve Bank of New York · Open Market Trading Desk.",
        usage: `Terms: ${MARKET_TERMS}. Accepted dollars are converted to billions. Small-value exercises are excluded.`,
      },
      async read() {
        const from = new Date(Date.parse(today) - 400 * 86400000).toISOString().slice(0, 10);
        const query = new URLSearchParams({
          startDate: from, endDate: today, operationTypes: "Reverse Repo", method: "fixed", securityType: "tsy", term: "overnight",
        });
        const doc = await read(MARKET_API + "/rp/results/search.json?" + query);
        return { ...doc, ...nyFedReverseRepo(doc.text, doc.retrievedAt) };
      },
    },
  };
}
