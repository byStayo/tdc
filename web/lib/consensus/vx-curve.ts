import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { publicDate } from "../public-normalization.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { marketHistoryPreview } from "./market-history-preview.ts";
import { latestOptionSession } from "./option-activity-clock.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceFailureKind, sourceResponse } from "./source-failure.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const VX_CURVE_ID = "cfe-vx-monthly-curve";
const docURL = "https://getmarkethistory.com/docs/guides/vix-historical-data/";
const existingNote = "Refresh unavailable. Showing the last verified observation with its original dates; normal stale-data limits still apply.";
const pendingNote = "The new settlement pair is pending. Showing the prior verified observation with its original date.";
const method = "Compare the previous U.S. equity session’s official settlements for the two nearest unexpired standard monthly CFE VIX futures. Market History and CFE must agree on both contract expiries and settlements before 08:00 New York on the next equity session. Only the relationship between the two settlements is shown.";
const limit = "These futures price expected S&P 500 volatility. The tested curve did not improve next-session SPY direction forecasts.";
const symbolRoute = "symbols?dataset=futures/us&timeframe=1d";
const md = "https://getmarkethistory.com/api/v1/";
const dayMs = 86_400_000;
const monthCodes = "FGHJKMNQUVXZ";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const instant = (v: string) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const at8 = (day: string) => newYorkTimestamp(day.replaceAll("-", "") + "T080000")!;
const validDay = (s: string) => typeof s === "string" && publicDate(s) === s;
const shift = (day: string, amount: number) => new Date(Date.parse(day) + amount * dayMs).toISOString().slice(0, 10);
const exchangeURL = (day: string) => "https://www-api.cboe.com/us/futures/market_statistics/settlement/csv/?dt=" + day;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Doc = { url: string; text: string; sha256: string; at: string };
type ExchangeSheet = Doc & { filename: string };
type Preview = Doc & { count: string | null; limit: string | null; through: string | null; session: string | null; format: string | null };
type Contract = { ticker: string; expiry: string; id: number };
type Window = { target: string; observed: string; closed: string; cutoff: string };
type Receipt = { version: 1; window: Window; checkedAt: string; sheet: ExchangeSheet; catalog: Doc; legs: { specification: Doc; preview: Preview }[] };
type Reading = { day: string; at: string; sha256: string; band: number };
class Pending extends Error {}

function nextSession(day: string) {
  for (let i = 1; i <= 10; i++) {
    const candidate = shift(day, i);
    if (exchangeSession(candidate)) return candidate;
  }
  throw new Error("No reviewed next exchange date for VX");
}
function windowAt(now: string): Window {
  if (!instant(now)) throw new Error("Invalid VX capture clock");
  const today = newYorkDate(now), here = exchangeSession(today);
  const target = here && now < here.closeAt ? today : nextSession(today);
  const cutoff = at8(target), observed = latestOptionSession(cutoff, Date.parse(cutoff));
  // CFE Rule 1202(p) sets 15:00 Chicago on full sessions and 12:00 Chicago on scheduled 12:15 early closes.
  return { target, observed, closed: exchangeSession(observed)!.closeAt, cutoff };
}
function checkDoc(d: Doc, url: string, w: Window, through: string) {
  if (d.url !== url || hash(d.text) !== d.sha256 || !instant(d.at) || d.at < w.closed || d.at >= w.cutoff || d.at > through)
    throw new Error("VX receipt URL, timestamp or hash differs");
}

function monthlySettlements(csv: string, date: string) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== "Product,Symbol,Expiration Date,Price" || lines.length > 1500) throw new Error("Unexpected CFE settlement sheet");
  const result = new Map<string, number>();
  for (const line of lines) {
    const [product, ticker, expiry, price, extra] = line.split(",");
    if (product !== "VX") continue;
    if (extra !== undefined || !validDay(expiry)) throw new Error("Malformed CFE expiry");
    if (/^VX\d{2}\/[FGHJKMNQUVXZ]\d$/.test(ticker) || expiry <= date) continue;
    if (ticker !== "VX/" + monthCodes[Number(expiry.slice(5, 7)) - 1] + expiry[3] ||
        !/^\d+(?:\.\d+)?\*?$/.test(price) || result.has(expiry)) throw new Error("Invalid or duplicated CFE monthly settlement");
    const settle = Number(price.replace(/\*$/, ""));
    if (!Number.isFinite(settle) || settle <= 0) throw new Error("Nonpositive CFE settlement");
    result.set(expiry, settle);
  }
  return result;
}
function nearest(catalog: Doc, sheet: Doc, day: string) {
  const settlement = monthlySettlements(sheet.text, day);
  const list = JSON.parse(catalog.text);
  type Entry = { symbol: string; symbol_id: number; first_timestamp: string };
  if (!Array.isArray(list.symbols) || list.count !== list.symbols.length || list.count < 2 || list.count > 5000)
    throw new Error("Incomplete CFE contract catalogue");
  const contracts: Contract[] = list.symbols.flatMap((row: Entry) => {
    if (!/^VX-\d{4}-\d\d-\d\d$/.test(row.symbol)) return [];
    const expiry = row.symbol.slice(3);
    if (!validDay(expiry) || !Number.isSafeInteger(row.symbol_id) || row.symbol_id <= 0 ||
        !/^\d{4}-\d\d-\d\dT00:00:00Z$/.test(row.first_timestamp) || !validDay(row.first_timestamp.slice(0,10)))
      throw new Error("Invalid monthly VX catalogue identity");
    return expiry > day && row.first_timestamp.slice(0,10) <= day ? [{ ticker: row.symbol, id: row.symbol_id, expiry }] : [];
  }).sort((a: Contract, b: Contract) => a.expiry.localeCompare(b.expiry));
  if (contracts.length < 2 || settlement.size < 2) throw new Pending("CFE or Market History has not supplied both active contracts");
  if (new Set(contracts.map(v => v.expiry.slice(0,7))).size !== contracts.length || new Set(contracts.map(v => v.id)).size !== contracts.length ||
      new Set([...settlement.keys()].map(d => d.slice(0,7))).size !== settlement.size) throw new Error("Duplicate VX delivery month or contract identity");
  const exp = [...settlement.keys()].sort().slice(0, 2), pair = contracts.slice(0, 2);
  if (pair.some((v, i) => v.expiry !== exp[i])) throw new Error("CFE and Market History identify different nearest monthly contracts");
  return pair.map(c => ({ ...c, settle: settlement.get(c.expiry)! }));
}

const sheetFilename = (day: string) => "FuturesSettlements_" + day + ".csv";
async function cfeSheet(fetcher: Fetcher, day: string, now: () => string): Promise<ExchangeSheet> {
  const url = exchangeURL(day);
  const res = await sourceResponse(fetcher, url, { redirect: "error", credentials: "omit", headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(15000) });
  if (res.headers.get("content-type")?.split(";")[0].trim() !== "text/csv") throw new Error("Expected a CFE settlement CSV");
  const filename = res.headers.get("content-disposition")?.match(/^attachment;\s*filename=(?:"([^"]+)"|([^;\s]+))$/i);
  if ((filename?.[1] ?? filename?.[2]) !== sheetFilename(day)) throw new Error("CFE attachment trade date differs");
  const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await sourceChunk(reader);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 150_000) throw new Error("CFE settlement sheet exceeds the size bound");
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const text = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks));
  return {url, text, sha256: hash(text), at: now(), filename: sheetFilename(day)};
}
async function providerDoc(route: string, fetcher: Fetcher, now: () => string) {
  const response = await marketHistoryPreview(route, fetcher);
  const doc = { url: md + route, text: response.text, sha256: response.sha256, at: now() };
  return {doc, headers: response.headers};
}

function verify(r: Receipt, expected: Window, checked: string): Reading {
  if (r.version !== 1 || !isDeepStrictEqual(r.window, expected) || !instant(r.checkedAt) ||
      r.checkedAt < expected.closed || r.checkedAt >= expected.cutoff || r.checkedAt > checked ||
      !Array.isArray(r.legs) || r.legs.length !== 2) throw new Error("VX capture outside its forecast window");
  const w = expected, through = r.checkedAt;
  checkDoc(r.sheet, exchangeURL(w.observed), w, through);
  if (r.sheet.filename !== sheetFilename(w.observed)) throw new Error("CFE receipt trade date differs");
  checkDoc(r.catalog, md + symbolRoute, w, through);
  const pair = nearest(r.catalog, r.sheet, w.observed);
  let delayed = false;
  for (const [i, leg] of r.legs.entries()) {
    const c = pair[i], route = "futures/us/" + c.ticker, p = leg.preview;
    checkDoc(leg.specification, md + route, w, through);
    checkDoc(p, md + "bars/" + route + "/1d", w, through);
    const s = JSON.parse(leg.specification.text), ct = s.contract;
    const frames = s.bars?.timeframes?.filter((v: {timeframe: string}) => v.timeframe === "1d");
    const f = frames?.[0];
    if (s.ticker !== c.ticker || s.dataset !== "futures/us" || ct?.exchange !== "CFE" || ct.asset_class !== "volatility" ||
        ct.country !== "US" || ct.currency !== "USD" || ct.name !== "VIX future, expires " + c.expiry || ct.status !== "active" ||
        frames?.length !== 1 || f.feed !== "cboe" || f.venue !== "Cboe Futures Exchange (CFE)" ||
        !/^\d{4}-\d\d-\d\dT00:00:00Z$/.test(f.last) || !validDay(f.last.slice(0,10)) || f.last !== p.through ||
        !Number.isFinite(Date.parse(f.updated)) || Date.parse(f.updated) > Date.parse(leg.specification.at) ||
        p.limit !== "100" || p.session !== "UTC 00:00" || p.format !== "jsonl") throw new Error("Invalid VX vendor maturity, identity or preview");
    const rows = p.text.trim().split(/\r?\n/);
    if (!rows.length || rows.length > 100 || String(rows.length) !== p.count) throw new Error("Invalid VX preview count");
    let last = "", settle = 0;
    for (const raw of rows) {
      const b = JSON.parse(raw);
      if (b.symbol !== c.ticker || b.symbol_id !== c.id || !/^\d{4}-\d\d-\d\dT00:00:00Z$/.test(b.timestamp) ||
          !validDay(b.timestamp.slice(0,10)) || b.timestamp <= last || b.is_gap !== false || b.gap_fill_method !== 0 ||
          !Number.isFinite(b.close) || b.close <= 0) throw new Error("Invalid dated VX settlement row");
      last = b.timestamp; settle = b.close;
    }
    if (last !== f.last) throw new Error("VX preview and catalogue end on different dates");
    if (last.slice(0,10) < w.observed) {
      delayed = true;
      continue;
    }
    if (last.slice(0,10) !== w.observed || settle !== c.settle || Date.parse(f.updated) < Date.parse(w.closed))
      throw new Error("VX date or settlement differs from the original exchange sheet");
  }
  if (delayed) throw new Pending("Market History has not delivered the prior session on both maturities");
  return { day: w.observed, at: through, band: Math.sign(pair[0].settle - pair[1].settle), sha256:
    hash(JSON.stringify([w, r.sheet.sha256, r.catalog.sha256, r.legs.map(v => [v.specification.sha256,v.preview.sha256])])) };
}

function signal(at: string, r?: Reading): Signal {
  return { id: VX_CURVE_ID, family: "options", title: "VIX futures term structure", shortLabel: "Monthly VX curve",
    instruments: ["MARKET","SPY"], directionalInstruments: [], status: r ? "available" : "not_formed", staleAfterDays: 5,
    scores: {daily:null,weekly:null,monthly:null}, unit: "band", methodology: method, limitation: limit,
    summary: r ? "The nearest monthly VIX future settled " + ["below","at the same level as","above"][r.band + 1] +
      " the second month on " + r.day + "." : "A pre-open comparison of the two nearest monthly VIX futures is pending.",
    source: {name:"Market History and Cboe Futures Exchange",url:docURL,frequency:"daily futures settlement",
      attribution:"Market History monthly VX futures verified against Cboe Futures Exchange daily settlements.",
      usage:"Derived indicator under the Market History data licence. https://getmarkethistory.com/docs/terms/",
      observedAt:r?.day ?? null,releasedAt:null,retrievedAt:r?.at ?? at,sha256:r?.sha256 ?? null},
    series: r ? [{date:r.day,value:r.band}] : [], metrics: r ? [{date:r.day,label:"First versus second monthly settlement",unit:"band",value:r.band}] : [] };
}
export function validateVxCurve(s: Signal, cutoff: string) {
  if (s.id !== VX_CURVE_ID) return;
  const { collectionNote, failureKind, ...base } = s, at = s.source.retrievedAt;
  if (!instant(at) || !instant(cutoff) || at > cutoff) throw new Error("Invalid VX publication clock");
  let expected = signal(at);
  if (s.status === "available") {
    const w = windowAt(at), day = s.source.observedAt, band = s.series[0]?.value;
    if (day !== w.observed || at < w.closed || at >= w.cutoff || ![-1,0,1].includes(band) ||
        !/^[a-f0-9]{64}$/.test(s.source.sha256 ?? "")) throw new Error("Invalid prospective VX observation");
    expected = signal(at, {day, at, band, sha256:s.source.sha256!});
  } else if (s.status === "unavailable") { expected = {...expected,status:"unavailable"}; }
  if (!isDeepStrictEqual(base,expected) || (collectionNote !== undefined &&
      (s.status !== "available" || ![pendingNote,existingNote].includes(collectionNote))) ||
      (failureKind !== undefined && (s.status !== "unavailable" || !["validation","transport"].includes(failureKind))))
    throw new Error("VX signal differs from its public derived-only contract");
}

async function preserve<T>(file: string, value: T) {
  try { await durableJSON(file,value,true); return value; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readResearchReceipt<T>(file);
    if (!winner) throw new Error("Concurrent VX receipt is missing");
    return winner;
  }
}

export async function collectVxCurve(fetcher: Fetcher = fetch, directory?: string, previous?: Signal,
  now = () => new Date().toISOString()): Promise<Signal> {
  const started = now();
  try {
    const w = windowAt(started), folder = directory && join(directory,w.target), file = folder && join(folder,"verified.json");
    const saved = file && await readResearchReceipt<Receipt>(file);
    if (saved) return signal(started,verify(saved,w,started));
    if (started < w.closed || started >= w.cutoff) throw new Pending("Outside the pre-open VX capture window");
    const sheet = await cfeSheet(fetcher,w.observed,now);
    checkDoc(sheet,exchangeURL(w.observed),w,now());
    if (folder) {
      await durableDirectory(folder,0o700);
      const primary = await preserve(join(folder,"cfe-"+sheet.sha256+".json"),sheet);
      checkDoc(primary, sheet.url, w, now());
      if (primary.sha256 !== sheet.sha256) throw new Error("Saved CFE source differs");
    }
    const { doc: catalog } = await providerDoc(symbolRoute,fetcher,now);
    const pair = nearest(catalog,sheet,w.observed);
    const legs = await Promise.all(pair.map(async contract => {
      const route = "futures/us/" + contract.ticker;
      const [spec, bars] = await Promise.all([providerDoc(route,fetcher,now),providerDoc("bars/"+route+"/1d",fetcher,now)]);
      const h = bars.headers;
      return { specification:spec.doc, preview:{ ...bars.doc,count:h.get("x-row-count"),limit:h.get("x-preview-limit"),
        through:h.get("x-data-through"),session:h.get("x-session"),format:h.get("x-format") } };
    }));
    const receipt: Receipt = {version:1,window:w,checkedAt:now(),sheet,catalog,legs};
    if (receipt.checkedAt >= w.cutoff) throw new Pending("VX comparison missed the forecast cutoff");
    const checked = verify(receipt,w,receipt.checkedAt);
    const finished = now();
    if (!instant(finished) || finished < receipt.checkedAt) throw new Error("VX completion clock moved backwards");
    if (finished >= w.cutoff) throw new Pending("VX comparison missed the forecast cutoff");
    receipt.checkedAt = finished;
    if (file) {
      const winner = await preserve(file,receipt);
      const original = verify(winner,w,now());
      if (!isDeepStrictEqual(nearest(winner.catalog,winner.sheet,w.observed),pair)) throw new Error("Concurrent witnessed VX settlements differ");
      return signal(now(),original);
    }
    return signal(now(),{...checked,at:finished});
  } catch (error) {
    const at=now(), pending=error instanceof Pending, kind=sourceFailureKind(error);
    if ((pending || kind === "transport") && previous?.id === VX_CURVE_ID && previous.status === "available") {
      try {
        validateVxCurve(previous,at);
        return {...previous,collectionNote:pending ? pendingNote : existingNote};
      } catch { return {...signal(at),status:"unavailable",failureKind:"validation"}; }
    }
    return pending ? signal(at) : {...signal(at),status:"unavailable",failureKind:kind};
  }
}
