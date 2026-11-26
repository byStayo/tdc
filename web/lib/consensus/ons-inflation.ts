import { createHash } from "node:crypto";
import { immutableSourceReceipt } from "../publication-storage.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind } from "./source-failure.ts";
import type { Signal } from "./types.ts";

export const ONS_ID = "ons-uk-cpi-services";
export const ONS_ORIGIN = "https://www.ons.gov.uk";
export const ONS_CODES = ["d7g7", "d7nn"] as const;
export type OnsCode = typeof ONS_CODES[number];
const months = "January February March April May June July August September October November December".split(" ");
const london = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" });
const officialTitles = {
  d7g7: ["CPI ANNUAL RATE 00: ALL ITEMS 2015=100", "CPI: Consumer Prices Index (% change)", "CPI All Items: Percentage change over 12 months: Estimated pre-97 2005=100"],
  d7nn: ["CPI ANNUAL RATE: Services 2015=100", "CPI ANNUAL RATE: Services - estimated pre-97 2015=100", "CPI ANNUAL RATE: Services - estimated pre-97 2005=100"],
};
const percent = "%", changeUnit = "percentage points";
const labels = ["UK headline CPI annual rate", "UK services CPI annual rate", "Change in headline annual inflation", "Change in services annual inflation"];
const attribution = "Source: Office for National Statistics licensed under the Open Government Licence v3.0.";
const usage = "Crown copyright. https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/";
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const isHash = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const onsInstant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const onsPath = (code: OnsCode) => "/economy/inflationandpriceindices/timeseries/" + code + "/mm23";
const dateInLondon = (iso: string) => london.format(new Date(iso));
const monthPattern = /^(19|20)\d\d-(0[1-9]|1[012])$/;

export function priorOnsMonth(period: string) {
  if (!monthPattern.test(period)) throw Error("Invalid ONS reference month");
  const date = new Date(period + "-01T12:00:00Z");
  date.setUTCDate(0);
  return date.toISOString().slice(0, 7);
}
const monthEnd = (period: string) => {
  const date = new Date(period + "-01T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
};
const periodName = (period: string) => months[Number(period.slice(5)) - 1] + " " + period.slice(0, 4);
export const onsReleasePath = (period: string) => "/releases/consumerpriceinflationuk" + periodName(period).toLowerCase().replace(" ", "");

type Version = { label: string; uri: string; updateDate: string };
export type OnsReading = { period: string; rate: number; nativeDay: string; introducedAt: string; nativeDate: string; observationUpdate: string; uri: string; sha256: string };
export type OnsPair = { period: string; releaseAt: string; availableAt: string; calendarSha256: string; headline: OnsReading; services: OnsReading };
export interface OnsEvidence { current: OnsPair; previous: OnsPair }

function native(raw: PublicDocument) {
  if (!onsInstant(raw.retrievedAt) || !isHash(raw.sha256) || digest(raw.text) !== raw.sha256) throw Error("Invalid ONS source receipt");
  return JSON.parse(raw.text);
}

export function parseOnsSeries(doc: PublicDocument, code: OnsCode, uri: string) {
  const j = native(doc);
  const d = j.description;
  const root = onsPath(code);
  const history = j.versions ?? (uri === root + "/previous/v1" ? [] : null);
  if (j.type !== "timeseries" || j.uri !== uri || d?.cdid !== code.toUpperCase() || d.datasetId !== "MM23" ||
      !officialTitles[code].includes(String(d.title).trim()) || !["%", ""].includes(d.unit) ||
      !onsInstant(d.releaseDate) || !Array.isArray(j.months) || !j.months.length || !Array.isArray(history) || history.length > 800)
    throw Error("Unverified ONS series identity or definition");
  const versions: Version[] = history.map((v: Version, i: number) => {
    if (v?.label !== "v" + (i + 1) || v.uri !== root + "/previous/" + v.label || !onsInstant(v.updateDate) ||
        (i && v.updateDate < history[i-1].updateDate)) throw Error("Invalid ONS archive chain");
    return {label: v.label, uri: v.uri, updateDate: v.updateDate};
  });
  if (uri !== root && uri !== root + "/previous/v" + (versions.length + 1)) throw Error("Unverified ONS archive position");
  const row = j.months.at(-1);
  const index = months.indexOf(row?.month);
  if (index < 0 || !/^\d{4}$/.test(row.year) || row.sourceDataset !== "MM23" ||
      row.date !== row.year + " " + row.month.slice(0,3).toUpperCase() || row.date !== row.label || d.date !== row.date ||
      !/^-?\d{1,2}(?:\.\d)?$/.test(row.value) || !onsInstant(row.updateDate)) throw Error("Invalid ONS latest monthly rate");
  const period = row.year + "-" + String(index + 1).padStart(2,"0");
  const nativeDay = dateInLondon(d.releaseDate);
  const introducedAt = versions.at(-1)?.updateDate;
  // The archive entry bearing this object's own version labels its replacement.
  // The immediately preceding entry in this object's history records its introduction.
  const reading: OnsReading | null = introducedAt ? {period, rate: Number(row.value), nativeDay, introducedAt,
    nativeDate:d.releaseDate, observationUpdate:row.updateDate, uri, sha256:doc.sha256} : null;
  return {period, reading, versions};
}

export function onsHistoricalClock(day: string) {
  const zone = offset.formatToParts(new Date(day + "T12:00:00Z")).find(p => p.type === "timeZoneName")?.value;
  if (zone !== "GMT" && zone !== "GMT+0" && zone !== "GMT+1") throw Error("Unknown ONS local clock");
  const clock = day < "2020-03-25" ? "09:30" : "07:00";
  return new Date(day + "T" + clock + ":00" + (zone === "GMT+1" ? "+01:00" : "Z")).toISOString();
}

export function recordedOnsClock(doc: PublicDocument, period: string) {
  const page = native(doc), d = page.description;
  if (page.uri !== onsReleasePath(period) || !d || d.title !== "Consumer price inflation, UK: " + periodName(period) ||
      d.published !== true || d.finalised !== true || d.cancelled !== false || !onsInstant(d.release_date) || d.release_date > doc.retrievedAt)
    throw Error("Unverified ONS publication calendar");
  return d.release_date as string;
}

export function pairOnsRates(headline: OnsReading, services: OnsReading, releaseAt: string, calendarSha256: string): OnsPair {
  if (!onsInstant(releaseAt)) throw Error("Invalid ONS release date");
  const day = dateInLondon(releaseAt);
  if (priorOnsMonth(day.slice(0,7)) !== headline.period || !isHash(calendarSha256) || headline.period !== services.period ||
      [headline, services].some(r => r.nativeDay !== day || dateInLondon(r.introducedAt) !== day || dateInLondon(r.observationUpdate) !== day))
    throw Error("ONS original rate and publication dates disagree");
  const availableAt = [releaseAt, ...[headline,services].flatMap(r=>[r.introducedAt,r.nativeDate,r.observationUpdate])].sort().at(-1)!;
  return {period:headline.period,releaseAt,availableAt,calendarSha256,headline,services};
}

function baseline(time: string): Signal {
  return {id:ONS_ID,family:"international",title:"UK headline and services inflation",shortLabel:"UK inflation",
    instruments:["MARKET","TLT"],directionalInstruments:[],status:"unavailable",
    summary:"The original UK inflation readings are awaiting verification.",
    source:{name:"Office for National Statistics · UK consumer prices",url:ONS_ORIGIN+onsPath("d7nn"),retrievedAt:time,
      observedAt:null,releasedAt:null,sha256:null,frequency:"monthly",attribution,usage},
    methodology:"Compare the first published annual CPI rates for services and all items with their immediately preceding monthly releases. Changes are in percentage points.",
    limitation:"These changes describe UK consumer prices. Their relationship to U.S. Treasury ETF returns requires separate validation.",
    unit:percent,staleAfterDays:65,metrics:[],series:[],scores:{daily:null,weekly:null,monthly:null}};
}

const change = (a: number,b: number) => (Math.round(10*a)-Math.round(10*b))/10;
function measures({current:c,previous:p}: OnsEvidence) {
  return [c.headline.rate, c.services.rate, change(c.headline.rate,p.headline.rate), change(c.services.rate,p.services.rate)];
}

export function validateOnsInflation(signal: Signal, cutoff: string) {
  if (signal.id !== ONS_ID) {
    if (signal.onsInflation !== undefined) throw Error("ONS evidence belongs to the UK CPI signal");
    return;
  }
  const base = baseline(signal.source.retrievedAt), src = signal.source, e = signal.onsInflation;
  if (signal.family !== base.family || signal.instruments.join() !== "MARKET,TLT" || signal.directionalInstruments?.length !== 0 ||
      Object.values(signal.scores).some(v=>v!==null) || signal.unit!==percent || signal.staleAfterDays!==65 ||
      src.name!==base.source.name || src.attribution!==attribution || src.usage!==usage || src.frequency!=="monthly" ||
      !onsInstant(src.retrievedAt) || src.retrievedAt>cutoff) throw Error("Invalid ONS signal scope or source");
  if (signal.status==="unavailable") {
    if (e || src.sha256!==null || src.releasedAt!==null || src.observedAt!==null || src.url!==base.source.url ||
        signal.metrics.length || signal.series.length) throw Error("Invalid unavailable ONS signal");
    return;
  }
  if (signal.status!=="available" || !e || priorOnsMonth(e.current.period)!==e.previous.period ||
      e.previous.availableAt>=e.current.releaseAt || e.current.availableAt>src.retrievedAt ||
      src.sha256!==digest(JSON.stringify(e)) || src.url!==ONS_ORIGIN+onsReleasePath(e.current.period) ||
      src.observedAt!==monthEnd(e.current.period) || src.releasedAt!==e.current.releaseAt) throw Error("Invalid ONS monthly comparison");
  for (const pair of [e.current,e.previous]) {
    for (const [i,r] of [pair.headline,pair.services].entries()) {
      const root=onsPath(ONS_CODES[i]);
      const suffix=r.uri.startsWith(root) ? r.uri.slice(root.length) : null;
      if (r.period!==pair.period || !Number.isFinite(r.rate) || Math.round(r.rate*10)/10!==r.rate ||
          !isHash(r.sha256) || (suffix!=="" && !/^\/previous\/v[1-9]\d*$/.test(suffix??"")) ||
          ![r.introducedAt,r.nativeDate,r.observationUpdate].every(onsInstant) || dateInLondon(r.nativeDate)!==r.nativeDay)
        throw Error("Invalid dated ONS reading");
    }
    if (pairOnsRates(pair.headline,pair.services,pair.releaseAt,pair.calendarSha256).availableAt!==pair.availableAt)
      throw Error("Invalid ONS availability clock");
  }
  const values=measures(e);
  if (signal.metrics.length!==4 || signal.series.length!==2 ||
      [e.previous,e.current].some((p,i)=>signal.series[i].date!==monthEnd(p.period) || signal.series[i].value!==p.services.rate) ||
      signal.metrics.some((m,i)=>m.label!==labels[i] || m.date!==src.observedAt || m.unit!==(i<2?percent:changeUnit) || m.value!==values[i]))
    throw Error("Invalid published ONS measurements");
}

export type OnsReader = (url: string) => Promise<PublicDocument>;
/** Content addresses let successive weekday collections share the same original. */
export function archivedOnsReader(read: OnsReader, directory?: string): OnsReader {
  return async url => {
    const fresh = await read(url);
    if (!directory) return fresh;
    if (!isHash(fresh.sha256) || digest(fresh.text) !== fresh.sha256 || !onsInstant(fresh.retrievedAt))
      throw Error("Invalid ONS source receipt");
    const verify = (saved: PublicDocument & { url: string }) => {
      if (saved.url !== url || saved.sha256 !== fresh.sha256 ||
          digest(saved.text) !== saved.sha256 || !onsInstant(saved.retrievedAt)) throw Error("Changed ONS original receipt");
    };
    const name = digest(url) + "-" + fresh.sha256 + ".json";
    await immutableSourceReceipt(directory, name, async () => ({ ...fresh, url }), verify);
    return fresh;
  };
}
async function recentOnsOriginals(read: OnsReader, code: OnsCode) {
  const path=onsPath(code);
  const latest=parseOnsSeries(await read(ONS_ORIGIN+path+"/data"),code,path);
  let period=latest.period, first=latest.reading;
  const rows: OnsReading[]=[];
  for (const entry of latest.versions.slice(-8).reverse()) {
    const prior=parseOnsSeries(await read(ONS_ORIGIN+entry.uri+"/data"),code,entry.uri);
    if (prior.versions.some((v,i) => v.uri !== latest.versions[i].uri || v.updateDate !== latest.versions[i].updateDate))
      throw Error("ONS original disagrees with its current archive catalogue");
    if (prior.period!==period) {
      if (priorOnsMonth(period)!==prior.period || !first) throw Error("Missing original for a consecutive ONS month");
      rows.push(first);
      if (rows.length===2) return rows;
      period=prior.period;
    }
    first=prior.reading;
  }
  throw Error("ONS series lack two verifiable first releases");
}

export async function collectOnsInflation(read: OnsReader, now=()=>new Date().toISOString()) {
  let retrievedAt=now();
  const tracked: OnsReader=async url=>{
    const doc=await read(url); if (doc.retrievedAt>retrievedAt) retrievedAt=doc.retrievedAt; return doc;
  };
  try {
    const [head,services]=await Promise.all(ONS_CODES.map(code=>recentOnsOriginals(tracked,code)));
    const dates=await Promise.all(head.map(r=>tracked(ONS_ORIGIN+onsReleasePath(r.period)+"/data")));
    const pairs=head.map((r,i)=>pairOnsRates(r,services[i],recordedOnsClock(dates[i],r.period),dates[i].sha256));
    const e={current:pairs[0],previous:pairs[1]}, base=baseline(retrievedAt), date=monthEnd(e.current.period);
    const signal: Signal={...base,status:"available",onsInflation:e,
      source:{...base.source,url:ONS_ORIGIN+onsReleasePath(e.current.period),sha256:digest(JSON.stringify(e)),
        observedAt:date,releasedAt:e.current.releaseAt},
      summary:periodName(e.current.period)+" UK services inflation was "+e.current.services.rate.toFixed(1)+"% and headline inflation was "+e.current.headline.rate.toFixed(1)+"%.",
      series:[e.previous,e.current].map(r=>({date:monthEnd(r.period),value:r.services.rate})),
      metrics:measures(e).map((value,i)=>({label:labels[i],date,unit:i<2?percent:changeUnit,value}))};
    validateOnsInflation(signal,retrievedAt); return signal;
  } catch (error) { return {...baseline(retrievedAt),failureKind:sourceFailureKind(error)}; }
}
