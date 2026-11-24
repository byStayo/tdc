import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import type { EditorialEvidence, EditorialSource } from "../scripts/collect-editorial-evidence.ts";
import { publicBytes } from "./consensus/public-source.ts";
import { TREASURY_YIELD_CITATION, treasuryYieldFile, treasuryYieldPoints } from "./consensus/fed-market-data.ts";
import { SourceTransportError } from "./consensus/source-failure.ts";
import { newYorkDate, newYorkTimestamp } from "./consensus/time.ts";
import { readResearchReceipt } from "./consensus/research-price-capture.ts";
import { publicDate } from "./public-normalization.ts";
import { durableDirectory, durableJSON } from "./publication-storage.ts";

export const TREASURY_CURVE_ID = "TREASURY_YIELD_CURVE";
const title = "U.S. Treasury · Daily Treasury Par Yield Curve Rates";
const unit = "percent per annum";
const maxCurveBytes = 2 * 1024 * 1024;
const tenor = { DGS2: "twoYearPercent", DGS10: "tenYearPercent", DGS30: "thirtyYearPercent" } as const;
type CurveRow = { date: string; twoYearPercent: number; tenYearPercent: number; thirtyYearPercent: number };
type Stamp = { url: string; retrievedAt: string; sha256: string };
type Capture = Omit<Stamp, "url"> & { text: string };
export type TreasuryCurveData = { unit: typeof unit; latest: CurveRow; previous: CurveRow; documents: Stamp[] };
const instant = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const exact = (v: unknown, keys: string[]) => !!v && typeof v === "object" && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const hash = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const retryableHTTP = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set(["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
type TreasuryFetch = (url: string, init?: RequestInit) => Promise<Response>;

class TreasuryDeliveryError extends Error {
  readonly retryDelay: number | null;

  constructor(reason: string, retryDelay: number | null) {
    super(reason);
    this.retryDelay = retryDelay;
  }
}

function retryDelay(hint: string | null): number | null {
  if (hint === null) return 1000;
  let delay: number;
  if (/^\d+$/.test(hint)) {
    delay = Number(hint) * 1000;
  } else {
    const at = new Date(hint);
    if (!Number.isFinite(at.getTime()) || at.toUTCString() !== hint) return null;
    delay = Math.max(0, at.getTime() - Date.now());
  }
  return delay <= 3000 ? delay : null;
}

function transientConnection(cause: unknown): boolean {
  for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError" ||
        transientCodes.has((cause as NodeJS.ErrnoException).code ?? "")) return true;
    cause = cause.cause;
  }
  return false;
}

export function collectOfficialTreasuryCurve(fetcher: TreasuryFetch = fetch, archiveRoot?: string): Promise<EditorialSource> {
  return collectTreasuryCurve(async url => {
    assertTreasuryCurveURL(url);
    const delivery: { response?: Response } = {};
    try {
      const { bytes, retrievedAt, sha256 } = await publicBytes(url, async (target, init) => {
        delivery.response = await fetcher(target, init);
        return delivery.response;
      }, maxCurveBytes);
      return { text: bytes.toString("utf8"), retrievedAt, sha256 };
    } catch (error) {
      const response = delivery.response;
      if (response && !response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const transient = retryableHTTP.has(response.status);
        const delay = transient ? retryDelay(response.headers.get("Retry-After")) : null;
        const detail = transient && delay === null ? " The provider's retry delay is invalid or exceeds three seconds." : "";
        throw new TreasuryDeliveryError(`Treasury returned HTTP ${response.status}.` + detail, delay);
      }
      if (error instanceof SourceTransportError) {
        throw new TreasuryDeliveryError("The Treasury connection failed or was interrupted.", transientConnection(error.cause) ? 1000 : null);
      }
      throw error;
    }
  }, archiveRoot);
}

function table(year: number): string {
  const url = new URL(TREASURY_YIELD_CITATION);
  url.searchParams.set("field_tdr_date_value", String(year));
  url.searchParams.sort();
  return url.href;
}

export function assertTreasuryCurveURL(value: string): void {
  const year = new URL(value).searchParams.get("field_tdr_date_value");
  if (!year || !/^\d{4}$/.test(year) || ![table(Number(year)), treasuryYieldFile(Number(year))].includes(value))
    throw new Error("Expected an exact official Treasury par yield curve URL");
}

function curveRows(doc: Capture, year: number): CurveRow[] {
  const series = treasuryYieldPoints(doc.text, year, newYorkDate(doc.retrievedAt));
  const dates = [...new Set(Object.values(series).flatMap(points => points.slice(-2).map(p => p.date)))].sort().reverse().slice(0, 2);
  return dates.map(date => {
    const at = (id: keyof typeof tenor) => {
      const value = series[id].find(point => point.date === date)?.value;
      if (!isRate(value)) throw new Error("Incomplete Treasury curve on " + date);
      return value;
    };
    return { date, twoYearPercent: at("DGS2"), tenYearPercent: at("DGS10"), thirtyYearPercent: at("DGS30") };
  });
}

async function retain(root: string, bytes: Buffer, sha256: string) {
  const folder = resolve(root, ".editorial/treasury-curves");
  await durableDirectory(folder, 0o700);
  const path = resolve(folder, sha256 + ".json");
  type Saved = { gzipBase64: string };
  let saved = await readResearchReceipt<Saved>(path);
  if (!saved) {
    try { await durableJSON(path, { gzipBase64: gzipSync(bytes).toString("base64") }, true); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    saved = await readResearchReceipt<Saved>(path);
  }
  if (!saved || !gunzipSync(Buffer.from(saved.gzipBase64, "base64"), { maxOutputLength: maxCurveBytes }).equals(bytes))
    throw new Error("Treasury capture failed its private byte check");
}

export async function collectTreasuryCurve(read: (url: string) => Promise<Capture>, archiveRoot?: string): Promise<EditorialSource> {
  const currentYear = Number(newYorkDate(new Date().toISOString()).slice(0, 4));
  const sources: Stamp[] = [];
  let retryUsed = false;
  const readYear = async (year: number) => {
    const url = treasuryYieldFile(year);
    let doc: Capture;
    try {
      doc = await read(url);
    } catch (error) {
      if (retryUsed || !(error instanceof TreasuryDeliveryError) || error.retryDelay === null) throw error;
      // Both annual files share one retry. A successful first year is never fetched again.
      retryUsed = true;
      if (error.retryDelay > 0) await wait(error.retryDelay);
      doc = await read(url);
    }
    const bytes = Buffer.from(doc.text);
    if (!instant(doc.retrievedAt) || doc.retrievedAt > new Date().toISOString() || bytes.length > maxCurveBytes || hash(bytes) !== doc.sha256)
      throw new Error("Invalid Treasury capture");
    const rows = curveRows(doc, year);
    if (archiveRoot) await retain(archiveRoot, bytes, doc.sha256);
    sources.push({ url, retrievedAt: doc.retrievedAt, sha256: doc.sha256 });
    return rows;
  };
  const base = { id: TREASURY_CURVE_ID, kind: "treasury_curve" as const, title };
  try {
    const rows = await readYear(currentYear);
    if (rows.length < 2) rows.push(...await readYear(currentYear - 1));
    const [latest, previous] = rows;
    if (!latest || !previous) throw new Error("Two dated Treasury curves are required");
    const year = Number(latest.date.slice(0, 4));
    const source: EditorialSource = { ...base, status: "ok", url: table(year), retrievalUrl: treasuryYieldFile(year), retrievedAt: sources.at(-1)!.retrievedAt,
      observationDates: [latest.date, previous.date], data: { unit, latest, previous, documents: sources } satisfies TreasuryCurveData };
    validateTreasuryCurveSource(source);
    return source;
  } catch (cause) {
    const retrievedAt = new Date().toISOString(), year = Number(newYorkDate(retrievedAt).slice(0, 4));
    const reason = cause instanceof TreasuryDeliveryError ? cause.message : "Treasury curve evidence failed date, content, or archive verification.";
    return { ...base, status: "unavailable", url: table(year), retrievalUrl: treasuryYieldFile(year), retrievedAt, observationDates: [], data: null,
      error: retryUsed ? reason + " The collection used its one retry." : reason };
  }
}

export function validateTreasuryCurveSource(source: EditorialSource): void {
  if (source.kind !== "treasury_curve" && source.id !== TREASURY_CURVE_ID &&
      ![source.url, source.retrievalUrl].some(v => new URL(v).hostname === "home.treasury.gov")) return;
  const invalid = (): never => { throw new Error("Invalid official Treasury curve editorial evidence"); };
  if (source.id !== TREASURY_CURVE_ID || source.kind !== "treasury_curve" || source.title !== title || !instant(source.retrievedAt)) invalid();
  const captureYear = Number(newYorkDate(source.retrievedAt).slice(0, 4));
  if (source.status === "unavailable") {
    if (source.data !== null || source.observationDates.length || source.url !== table(captureYear) || source.retrievalUrl !== treasuryYieldFile(captureYear)) invalid();
    return;
  }
  const data = source.data as TreasuryCurveData;
  if (source.status !== "ok" || !exact(data, ["latest","previous","unit","documents"]) || data.unit !== unit ||
      !Array.isArray(data.documents) || !data.documents.length || data.documents.length > 2 || source.observationDates.length !== 2) invalid();
  for (const [index, stamp] of data.documents.entries()) {
    if (!exact(stamp, ["url","sha256","retrievedAt"]) || typeof stamp.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(stamp.sha256) || !instant(stamp.retrievedAt) ||
        stamp.retrievedAt > source.retrievedAt || stamp.url !== treasuryYieldFile(captureYear - index) ||
        (index > 0 && stamp.retrievedAt < data.documents[index - 1].retrievedAt)) invalid();
  }
  if (data.documents.at(-1)!.retrievedAt !== source.retrievedAt) invalid();
  for (const [index, row] of [data.latest, data.previous].entries()) {
    if (!exact(row, ["date", ...Object.values(tenor)]) || typeof row.date !== "string" || publicDate(row.date) !== row.date ||
        !Object.values(tenor).every(key => isRate(row[key])) || row.date !== source.observationDates[index] || [0,6].includes(new Date(row.date).getUTCDay())) invalid();
    const proof = data.documents.find(stamp => stamp.url === treasuryYieldFile(Number(row.date.slice(0, 4))));
    // The quoted business date is not an original release timestamp. Before the afternoon observation, use the preceding curve.
    if (!proof || row.date > newYorkDate(proof.retrievedAt) || (row.date === newYorkDate(proof.retrievedAt) &&
        proof.retrievedAt < newYorkTimestamp(row.date.replaceAll("-", "") + "T153000")!)) invalid();
  }
  const year = Number(data.latest.date.slice(0, 4));
  if (data.previous.date >= data.latest.date || source.url !== table(year) || source.retrievalUrl !== treasuryYieldFile(year) ||
      (data.documents.length === 2 && !data.previous.date.startsWith(String(captureYear - 1) + "-"))) invalid();
}

export function attachTreasuryCurve(evidence: EditorialEvidence, source: EditorialSource, assembledAt: string): EditorialEvidence {
  validateTreasuryCurveSource(source);
  if (source.id !== TREASURY_CURVE_ID || !instant(assembledAt) || !instant(evidence.collectedAt) || assembledAt < evidence.collectedAt ||
      source.retrievedAt > assembledAt || evidence.schemaVersion !== 1 || evidence.scope !== "market" || !Array.isArray(evidence.sources) ||
      evidence.sources.length > 30 || !Array.isArray(evidence.limitations) || !evidence.limitations.length || evidence.limitations.length > 20) throw new Error("Invalid Treasury editorial assembly");
  if (source.status !== "ok") throw new Error("A separately verified Treasury curve is required to enrich the saved packet");
  const oldCurve = evidence.sources.find(old => old.id === source.id);
  if (oldCurve?.status === "ok") {
    validateTreasuryCurveSource(oldCurve);
    if (oldCurve.retrievedAt > source.retrievedAt || oldCurve.observationDates[0] > source.observationDates[0])
      throw new Error("A Treasury update cannot precede the previously captured curve");
  }
  const sources = evidence.sources.filter(old => old.id !== source.id);
  const limitations = [...evidence.limitations];
  if (sources.length === 30) {
    const { latest, previous } = source.data as TreasuryCurveData;
    // Prefer keeping the frequently referenced 2s/10s FRED series. Displace only a date and value present in both sources.
    const preferred: (keyof typeof tenor)[] = ["DGS30", "DGS2", "DGS10"];
    const index = preferred.map(id => sources.findIndex(old => {
      if (old.id !== "FRED_" + id || old.kind !== "fred" || old.status !== "ok" || old.url !== "https://fred.stlouisfed.org/series/" + id) return false;
      const data = old.data as { seriesId: string; unit: string; observations: { date: string; value: number | null }[] };
      if (data?.seriesId !== id || data.unit !== "percent" || !Array.isArray(data.observations)) return false;
      const last = data.observations.filter(p => isRate(p.value)).sort((a,b) => b.date.localeCompare(a.date))[0];
      return last && [latest,previous].some(p => p.date === last.date && p[tenor[id]] === last.value);
    })).find(i => i >= 0);
    if (index === undefined) throw new Error("No overlapping Treasury tenor can be replaced within the 30-source limit");
    if (limitations.length === 20) throw new Error("The full packet lacks room to record the displaced Treasury citation");
    const [old] = sources.splice(index, 1);
    limitations.push("The official Treasury curve covers the latest available " + old.id + " reading from the original packet. That separate FRED entry was omitted to fit the 30-source limit.");
  }
  return { ...evidence, collectedAt: assembledAt, sources: [...sources, source], limitations };
}
