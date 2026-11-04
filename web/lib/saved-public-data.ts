import type { Envelope, Filing, MacroSeries, Positioning } from "./contracts.ts";
import { contractsForSymbol, hasRelatedContract, publicDate } from "./public-normalization.ts";
import type { EditorialEvidence } from "../scripts/collect-editorial-evidence.ts";

const ETF_CONTEXT = new Set(["SPY", "QQQ", "IWM", "DIA", "TLT", "GLD", "VTI", "VOO", "IEF"]);
const KNOWN_SERIES = new Set(["FEDFUNDS", "DPRIME", "TNWBSHNO"]);
// Cited rate/funding evidence is archived with the report. It does not expand
// the workspace's three declared macro panels or refresh their retrieval age.
const EDITORIAL_ONLY_SERIES = new Map([
  ["DGS2", "percent"], ["DGS10", "percent"], ["DGS30", "percent"],
  ["SOFR", "percent"], ["RRPONTSYD", "billions USD"],
]);
export interface SavedPublicData {
  schemaVersion: 1;
  collectedAt: string;
  macroRetrievedAt?: string | null;
  positioningRetrievedAt?: string | null;
  macro: MacroSeries[];
  positioning: Positioning[];
  filings: { symbol: string; retrievedAt: string; data: Filing[] }[];
}

/** Run inside the scheduled editorial publisher; never fetch in a page/API read. */
export function savedPublicData(evidence: EditorialEvidence): SavedPublicData {
  if (!publicDate(evidence.collectedAt)) throw new Error("Saved workspace needs a collection date");
  const result: SavedPublicData = { schemaVersion: 1, collectedAt: evidence.collectedAt, macroRetrievedAt: null, positioningRetrievedAt: null, macro: [], positioning: [], filings: [] };
  // A mixed-age panel reports its oldest included retrieval. A later review of
  // an unrelated source must not refresh the panel's provider-check timestamp.
  const oldest = (current: string | null | undefined, next: string) => !current || next < current ? next : current;
  for (const source of evidence.sources) {
    const editorialSeries = source.id.startsWith("FRED_") ? source.id.slice(5) : "";
    if (source.kind === "fred" && EDITORIAL_ONLY_SERIES.has(editorialSeries)) {
      if (source.status === "ok") {
        const data = source.data as { seriesId: string; unit: string; frequency: string; sha256: string; observations: {date: string; value: number | null}[] };
        if (data.seriesId !== editorialSeries || data.unit !== EDITORIAL_ONLY_SERIES.get(editorialSeries) ||
            data.frequency !== "daily" || !/^[a-f0-9]{64}$/.test(data.sha256) || !Array.isArray(data.observations) ||
            !data.observations.some(row => row.value !== null) ||
            data.observations.some(row => !publicDate(row.date) || (row.value !== null && !Number.isFinite(row.value))))
          throw new Error("Invalid editorial-only macro evidence");
      }
      continue;
    }
    if (source.kind === "fred") result.macroRetrievedAt = oldest(result.macroRetrievedAt, source.retrievedAt);
    if (source.kind === "cftc") result.positioningRetrievedAt = oldest(result.positioningRetrievedAt, source.retrievedAt);
    if (source.status !== "ok") continue;
    if (source.kind === "fred") {
      const data = source.data as { seriesId: string; unit: string; frequency: MacroSeries["frequency"]; observations: { date: string; value: number | null }[] };
      if (!KNOWN_SERIES.has(data.seriesId) || !["daily", "monthly", "quarterly"].includes(data.frequency)) throw new Error("Unknown saved macro series");
      const observations = data.observations.filter(row => row.value !== null);
      if (observations.some(row => !publicDate(row.date) || !Number.isFinite(row.value))) throw new Error("Invalid saved macro observation");
      result.macro.push({ id: data.seriesId, name: source.title, unit: data.unit, frequency: data.frequency, url: source.url, observations: observations as MacroSeries["observations"] });
    } else if (source.kind === "cftc") {
      const data = source.data as Positioning;
      if (!contractsForSymbol("MARKET").includes(data.contractCode) || !publicDate(data.reportDate)) throw new Error("Invalid saved positioning contract");
      const counts = { openInterest: data.openInterest, assetManagerLong: data.assetManagerLong, assetManagerShort: data.assetManagerShort, leveragedLong: data.leveragedLong, leveragedShort: data.leveragedShort, dealerLong: data.dealerLong, dealerShort: data.dealerShort };
      if (Object.values(counts).some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new Error("Invalid saved positioning count");
      result.positioning.push({ id: data.id, market: data.market, contractCode: data.contractCode, reportDate: data.reportDate, units: data.units, ...counts });
    } else if (source.kind === "sec") {
      const data = source.data as { ticker: string; cik: string; filings: Filing[] };
      if (!["AAPL", "MSFT", "NVDA"].includes(data.ticker) || data.filings.some(f => f.cik !== data.cik || !publicDate(f.filedAt) || !f.url.startsWith(`https://www.sec.gov/Archives/edgar/data/${Number(data.cik)}/`))) throw new Error("Invalid saved issuer filings");
      result.filings.push({ symbol: data.ticker, retrievedAt: source.retrievedAt, data: data.filings });
    }
  }
  return result;
}

/** Pure saved-data selection. Arbitrary tickers cannot create provider cache keys. */
export function savedPublicContext(saved: SavedPublicData, symbol: string, now = new Date().toISOString()): {
  macro: Envelope<MacroSeries[]>; filings: Envelope<Filing[]>; positioning: Envelope<Positioning[]>;
} {
  const macro: Envelope<MacroSeries[]> = {
    status: saved.macro.length === 3 ? "ok" : saved.macro.length ? "partial" : "unavailable",
    source: "Federal Reserve / FRED · saved publication", fetchedAt: saved.macroRetrievedAt ?? saved.collectedAt, asOf: null, data: saved.macro,
    coverage: "Monthly FEDFUNDS, daily DPRIME and quarterly TNWBSHNO retain separate observation dates and units.",
    message: "Saved during editorial publication; page reads make no provider requests. Historical series can be revised.",
  };
  if (saved.macro.some(series => Date.parse(now) - Date.parse(series.observations.at(-1)?.date ?? '') > ({daily:7,monthly:70,quarterly:180}[series.frequency]) * 86400000)) macro.status = "stale";
  const context = ETF_CONTEXT.has(symbol), issuers = saved.filings.filter(issuer => context || issuer.symbol === symbol);
  const filingsRetrievedAt = issuers.map(issuer => issuer.retrievedAt).sort()[0] ?? null;
  const filings: Envelope<Filing[]> = {
    status: issuers.length ? (Date.parse(now) - Date.parse(filingsRetrievedAt!) > 2 * 86400000 ? "stale" : context && issuers.length < 3 ? "partial" : "ok") : "unconfigured",
    source: "SEC EDGAR · saved publication", fetchedAt: filingsRetrievedAt ?? saved.collectedAt,
    asOf: issuers.flatMap(issuer => issuer.data.map(row => row.filedAt)).sort().at(-1) ?? null,
    data: issuers.flatMap(issuer => issuer.data).sort((a,b)=>b.filedAt.localeCompare(a.filedAt)),
    coverage: context ? `AAPL, MSFT and NVDA filing context for ${symbol}; not the ETF's full holdings or fund disclosures.` : `Saved issuer coverage for ${symbol}.`,
    message: issuers.length ? "Original filing dates and links, collected during editorial publication. Newer filings may exist; check EDGAR." : "This symbol is outside the saved AAPL/MSFT/NVDA filing coverage. Use the linked EDGAR search; no substitute company is shown.",
  };
  const codes = contractsForSymbol(symbol), positions = saved.positioning.filter(row=>codes.includes(row.contractCode));
  const positioning: Envelope<Positioning[]> = {
    status: !positions.length ? "unavailable" : positions.some(row=>Date.parse(now)-Date.parse(row.reportDate)>14*86400000) ? "stale" : positions.length !== codes.length || positions.some(row=>Object.values(row).some(value=>value===null)) ? "partial" : "ok",
    source: "CFTC TFF futures only · saved publication", fetchedAt: saved.positioningRetrievedAt ?? saved.collectedAt,
    asOf: positions.map(row=>row.reportDate).sort().at(-1) ?? null, data: positions,
    coverage: hasRelatedContract(symbol) ? `Related futures context for ${symbol}; not ETF holdings or dark-pool activity.` : `Broad context across six financial futures contracts, not positioning in ${symbol}.`,
    message: "Saved weekly observations, generally measured Tuesday and released Friday. Different contract units are never summed; categories do not reveal individual intent.",
  };
  return { macro, filings, positioning };
}
