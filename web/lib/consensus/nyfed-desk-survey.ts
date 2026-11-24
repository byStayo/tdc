import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import type { Signal } from "./types.ts";

import { NYFED_DESK_SURVEY_ID, nyFedDeskSurveyTargetExpired } from "./nyfed-desk-expiry.ts";
export { NYFED_DESK_SURVEY_ID } from "./nyfed-desk-expiry.ts";
export const NYFED_SURVEY_INDEX = "https://www.newyorkfed.org/markets/market-intelligence/survey-of-market-expectations";
const origin = "https://www.newyorkfed.org";
const hub = origin + "/markets/data-hub";
const hubScript = origin + "/medialibrary/interactives/markets/data/browser/main.js";
const terms = origin + "/privacy/termsofuse";
const calendar = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const fixedSources = [NYFED_SURVEY_INDEX, hub, hubScript, terms, calendar];
const parser = fileURLToPath(new URL("../../scripts/research-nyfed-desk-survey.py", import.meta.url));
const limit = 2_000_000;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: string) => /^[a-f0-9]{64}$/.test(value);
const instant = (value: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const newYorkDate = (value: string) => new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date(value));
const publicDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value+"T00:00:00.000Z").toISOString().slice(0, 10) === value;

type Capture = {bytes: Buffer; sha256: string; retrievedAt: string};
type Packed = {url: string; retrievedAt: string; sha256: string; gzip: string};
type Receipt = {version: 1; sources: Packed[]};
type Bin = {range: string; meanProbabilityPct: number};
type Evidence = {
  version: 1; responsesDue: string; distributed: string; elapsedMeetingTarget: string;
  minutesReleasedDate: string; publicationDay: string; officialPublicationTime: null; firstVerifiedBy: string;
  targetDate: string; respondents: number; bins: Bin[]; pdfUrl: string; pdfSHA256: string;
  workbookUrl: string; workbookSHA256: string; receiptId: string;
};
type WithSurvey = Signal & {nyFedDeskSurvey?: Evidence};
type Qualified = {
  distributed: string; responsesDue: string; elapsedMeetingTarget: string; minutesReleasedDate: string;
  surveyResultsPublicationDateByOfficialSchedule: string; surveyResultsOfficialClock: null; firstVerifiedBy: string;
  surveys: {targetDate: string; respondents: number; probabilities: Bin[]}[];
  pdf: {url: string; sha256: string}; xlsx: {url: string; sha256: string};
};

function latestPair(index: string) {
  for (const row of index.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const links = [...row[1].matchAll(/href="(\/medialibrary\/media\/markets\/survey\/(20\d{2})\/([a-z]+)-(20\d{2})-(sme-results\.pdf|data\.xlsx))"/g)];
    if (!links.some(l => l[5] === "sme-results.pdf")) continue;
    if (links.length !== 2 || links[0][5] !== "sme-results.pdf" || links[1][5] !== "data.xlsx" ||
        links.some(l=>l[2] !== l[4] || l[2] !== links[0][2] || l[3] !== links[0][3])) throw Error("Invalid native NY Fed survey links");
    return links.map(l=>origin+l[1]);
  }
  throw Error("Missing paired NY Fed survey original and spreadsheet");
}
function checkCapture(c: Capture, at: string) {
  if (!instant(at) || !instant(c.retrievedAt) || c.retrievedAt > at || !Buffer.isBuffer(c.bytes) ||
      c.bytes.length === 0 || c.bytes.length > limit || c.sha256 !== sha(c.bytes)) throw Error("Invalid federal survey capture");
}
function pairId(sources: Packed[]) {
  return sha(JSON.stringify(sources.slice(-2).map(s=>[s.url,s.sha256])));
}
function base(now: string): WithSurvey {
  return {
    id:NYFED_DESK_SURVEY_ID, family:"events", title:"Survey of Market Expectations", shortLabel:"Year-end Fed policy survey",
    instruments:["MARKET"], directionalInstruments:[], status:"unavailable",
    summary:"A verified year-end survey distribution is unavailable.",
    source:{name:"Federal Reserve Bank of New York · Survey of Market Expectations",url:NYFED_SURVEY_INDEX,
      observedAt:null,releasedAt:null,retrievedAt:now,frequency:"FOMC cycle",attribution:"Federal Reserve Bank of New York, Markets Group.",
      usage:"Content from the New York Fed subject to the Terms of Use at newyorkfed.org. " + terms,sha256:null},
    methodology:"Read the first future calendar-year-end distribution in the combined panel of dealers and other market participants. Check the official workbook against the dated original report. The observation is the response deadline. The publication day follows the corresponding FOMC minutes by one business day. The source gives no intraday publication clock.",
    limitation:"This report measures respondents’ mean subjective probabilities for the future policy target midpoint. Survey probabilities, respondent counts and rounded bins supply no traded odds, contract liquidity or ETF-directional score.",
    series:[],metrics:[],scores:{daily:null,weekly:null,monthly:null},staleAfterDays:90,unit:"%",
  };
}

export function nyFedDeskFirstEligibleOpen(capturedAt: string) {
  const firstDay = Date.parse(newYorkDate(capturedAt) + "T00:00:00.000Z");
  for (let offset = 0; offset <= 10; offset++) {
    const day = new Date(firstDay + offset * 86_400_000).toISOString().slice(0, 10);
    if (!hasReviewedCalendar(day)) return null;
    const session = exchangeSession(day);
    if (session && session.openAt > capturedAt) return {session:day, openAt:session.openAt};
  }
  return null;
}

function signal(e: Evidence, observedBy: string): WithSurvey {
  const s = base(observedBy);
  const highest = Math.max(...e.bins.map(b=>b.meanProbabilityPct));
  const leading = e.bins.filter(b=>b.meanProbabilityPct===highest).map(b=>b.range).join(", ");
  return {...s, status:"available",
    summary:`The combined panel of ${e.respondents} assigned the highest mean probability, ${highest}%, to ${leading} for the ${e.targetDate} federal funds target midpoint.`,
    source:{...s.source, url:e.pdfUrl, observedAt:e.responsesDue, releasedAt:e.publicationDay, sha256:e.pdfSHA256,
      attribution:`© ${e.responsesDue.slice(0,4)} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org. Markets Group, Survey of Market Expectations.`},
    metrics:[...e.bins.map(b=>({label:"Year-end policy midpoint "+b.range, value:b.meanProbabilityPct,unit:"% probability",date:e.responsesDue})),
      {label:"Combined survey respondents",value:e.respondents,unit:"respondents",date:e.responsesDue}],
    nyFedDeskSurvey:e,
  };
}

export function validateNyFedDeskSurvey(s: Signal, cutoff: string) {
  const e = (s as WithSurvey).nyFedDeskSurvey;
  if (s.id !== NYFED_DESK_SURVEY_ID || s.family !== "events" || s.instruments.join() !== "MARKET" || !Array.isArray(s.directionalInstruments) ||
      s.directionalInstruments.length || !["daily","weekly","monthly"].every(h=>s.scores[h as keyof typeof s.scores]===null) || Object.keys(s.scores).length!==3 || s.series.length || !instant(cutoff))
    throw Error("NY Fed survey scope changed");
  if (s.status === "unavailable") {
    if (e || s.metrics.length || s.source.observedAt || s.source.releasedAt || s.source.sha256) throw Error("Unverified NY Fed survey contains measurements");
    return;
  }
  if (!e || e.version!==1 || e.officialPublicationTime!==null || !instant(e.firstVerifiedBy) || !instant(s.source.retrievedAt) ||
      e.firstVerifiedBy>s.source.retrievedAt || s.source.retrievedAt>cutoff || s.source.observedAt!==e.responsesDue || s.source.releasedAt!==e.publicationDay ||
      ![e.distributed,e.responsesDue,e.elapsedMeetingTarget,e.minutesReleasedDate,e.publicationDay,e.targetDate].every(publicDay) ||
      !(e.distributed<e.responsesDue && e.responsesDue<e.elapsedMeetingTarget && e.elapsedMeetingTarget<e.minutesReleasedDate &&
        e.minutesReleasedDate<e.publicationDay && e.publicationDay<=newYorkDate(e.firstVerifiedBy) && newYorkDate(s.source.retrievedAt)<e.targetDate) ||
      !/\d{4}-12-31$/.test(e.targetDate) || !Number.isInteger(e.respondents) || e.respondents<1 || e.respondents>500 ||
      !Array.isArray(e.bins) || e.bins.length<3 || e.bins.length>25 || new Set(e.bins.map(b=>b.range)).size!==e.bins.length ||
      e.bins.some(b=>!(/^(?:<= |>= )?\d+\.\d{2}(?: - \d+\.\d{2})?%$/.test(b.range)) || !Number.isInteger(b.meanProbabilityPct) || b.meanProbabilityPct<0 || b.meanProbabilityPct>100) ||
      Math.abs(100-e.bins.reduce((n,b)=>n+b.meanProbabilityPct,0))>e.bins.length/2 || ![e.pdfSHA256,e.workbookSHA256,e.receiptId].every(fingerprint))
    throw Error("Invalid dated NY Fed survey evidence");
  const firstOpen = nyFedDeskFirstEligibleOpen(e.firstVerifiedBy);
  if (firstOpen && (firstOpen.openAt <= e.firstVerifiedBy || firstOpen.session < e.publicationDay))
    throw Error("NY Fed survey eligibility precedes public verification or its announced day");
  const ageExpired = Date.parse(cutoff) - Date.parse(e.responsesDue) > s.staleAfterDays * 86_400_000;
  const targetExpired = nyFedDeskSurveyTargetExpired(s as WithSurvey, cutoff);
  let lastUpper: number | null = null;
  for (const [i, b] of e.bins.entries()) {
    const values = b.range.match(/\d+\.\d{2}/g)!.map(v => Math.round(Number(v)*100));
    if (i === 0) {
      if (!b.range.startsWith("<= ") || values.length !== 1) throw Error("Invalid survey lower tail");
    } else {
      const upperTail = i === e.bins.length-1;
      if (lastUpper === null || values[0] !== lastUpper+1 ||
          (upperTail ? !b.range.startsWith(">= ") || values.length !== 1 : values.length !== 2 || values[0] > values[1]))
        throw Error("NY Fed probability bins have a gap or overlap");
    }
    lastUpper = values.at(-1)!;
  }
  const paths=latestPair('<tr><a href="'+e.pdfUrl.replace(origin,'')+'"></a><a href="'+e.workbookUrl.replace(origin,'')+'"></a></tr>');
  if (paths[0]!==e.pdfUrl || paths[1]!==e.workbookUrl || e.pdfUrl.indexOf('/'+e.responsesDue.slice(0,4)+'/')<0 ||
      e.receiptId!==sha(JSON.stringify([[e.pdfUrl,e.pdfSHA256],[e.workbookUrl,e.workbookSHA256]])) ||
      !(s.status === "available" || (s.status === "stale" && (ageExpired || targetExpired)))) throw Error("NY Fed survey signal differs from its source-checked measurements");
  const expected = signal(e, s.source.retrievedAt);
  for (const k of ["title", "shortLabel", "summary", "methodology", "limitation", "staleAfterDays", "unit"] as const) {
    if (s[k] !== expected[k]) throw Error("Archived NY Fed survey text or freshness policy changed");
  }
  for (const k of ["name", "url", "frequency", "attribution", "usage", "sha256"] as const) {
    if (s.source[k] !== expected.source[k]) throw Error("NY Fed source attribution or provenance changed");
  }
  if (s.metrics.length !== expected.metrics.length || s.metrics.some((m,i) => {
    const ref = expected.metrics[i];
    return m.label !== ref.label || m.date !== ref.date || m.unit !== ref.unit || m.value !== ref.value;
  })) throw Error("NY Fed survey values differ from their verified bins");
}

async function readReceipt(path: string) {
  const st=await lstat(path);
  if(!st.isFile() || st.mode & 0o077 || !st.size || st.size>14_000_000) throw Error("Invalid private NY Fed survey receipt");
  return JSON.parse(await readFile(path,"utf8")) as Receipt;
}
async function evaluate(receipt: Receipt, cutoff: string, observedBy?: string): Promise<WithSurvey> {
  if(receipt.version!==1 || !Array.isArray(receipt.sources) || receipt.sources.length!==7 || !instant(cutoff)) throw Error("Invalid native NY Fed survey archive");
  const sources=receipt.sources.map(p=>{
    const b=gunzipSync(Buffer.from(p.gzip,"base64"),{maxOutputLength:limit});
    checkCapture({bytes:b,retrievedAt:p.retrievedAt,sha256:p.sha256},cutoff);
    return {url:p.url,retrievedAt:p.retrievedAt,sha256:p.sha256,base64:b.toString("base64")};
  });
  const q=await new Promise<Qualified>((ok,fail)=>{
    const child=execFile("python3",[parser,"--native-stdin"],{timeout:20_000,maxBuffer:100_000},(error,out)=>{
      if(error) return fail(error);
      try {ok(JSON.parse(out));} catch(err){fail(err);}
    });
    child.stdin?.on("error",fail);
    child.stdin?.end(JSON.stringify({cutoff,sources}));
  });
  const target=q.surveys.find(t=>t.targetDate>newYorkDate(cutoff));
  if(!target) throw Error("NY Fed survey produced no future target at first publication");
  const e:Evidence={version:1,distributed:q.distributed,responsesDue:q.responsesDue,elapsedMeetingTarget:q.elapsedMeetingTarget,
    minutesReleasedDate:q.minutesReleasedDate,publicationDay:q.surveyResultsPublicationDateByOfficialSchedule,
    officialPublicationTime:q.surveyResultsOfficialClock,firstVerifiedBy:q.firstVerifiedBy,targetDate:target.targetDate,
    respondents:target.respondents,bins:target.probabilities,pdfUrl:q.pdf.url,pdfSHA256:q.pdf.sha256,
    workbookUrl:q.xlsx.url,workbookSHA256:q.xlsx.sha256,receiptId:pairId(receipt.sources)};
  const s=signal(e,observedBy??q.firstVerifiedBy);
  validateNyFedDeskSurvey(s,cutoff);
  return s;
}

export async function replayNyFedDeskSurvey(path: string, asOf = new Date().toISOString()) {
  const receipt=await readReceipt(path);
  if(basename(path)!==pairId(receipt.sources)+".json") throw Error("Wrong survey receipt filename");
  return evaluate(receipt,asOf);
}

export async function collectNyFedDeskSurvey(read: (url:string)=>Promise<Capture>, directory?:string, now=()=>new Date().toISOString()):Promise<WithSurvey> {
  try {
    const native=await Promise.all(fixedSources.map(async url=>({url,...await read(url)})));
    const links=latestPair(native[0].bytes.toString("utf8"));
    native.push(...await Promise.all(links.map(async url=>({url,...await read(url)}))));
    const at=now(), sources=native.map(c=>{
      checkCapture(c,at);
      return {url:c.url,sha256:c.sha256,retrievedAt:c.retrievedAt,gzip:gzipSync(c.bytes).toString("base64")};
    });
    const receipt: Receipt={version:1,sources}, checked=await evaluate(receipt,at);
    if(!directory) return checked;
    await durableDirectory(directory,0o700);
    const path=resolve(directory,pairId(sources)+".json");
    try {await durableJSON(path,receipt,true);}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const stored=await readReceipt(path);
      if(pairId(stored.sources)!==pairId(sources)) throw Error("Different source pair in existing NY Fed receipt");
      return await evaluate(stored,at,checked.source.retrievedAt);
    }
    return checked;
  } catch(error) {
    return {...base(now()),failureKind:sourceFailureKind(error)};
  }
}
