/** Frozen historical research helpers. No public vote or source collection. */
import { extendedResearchSession, extendedResearchSessions } from './extended-research-calendar.ts';
import { isFullKibotSession } from './kibot.ts';
import { newYorkTimestamp } from './time.ts';
import { policyCsv } from './policy.ts';
import { publicDate } from '../public-normalization.ts';
export const METHOD='prelaunch-statcan-foreign-canadian-equity-spy-v1';
export const FIRST_ISSUE='2016-01-19', LAST_ISSUE='2026-10-16', LAST_TARGET='2026-11-02';
export type Flow={issueDate:string;referencePeriod:string;netCadMillions:number;featureCadBillions:number};
export type Fix={date:string;usd:number;cad:number};
export function flowTargets(flows:Flow[]) {
 const sessions=extendedResearchSessions('2016-01-01',LAST_TARGET);
 const cutoffs=sessions.map((day,index)=>{const clock=extendedResearchSession(day)!;return {index,issuedAt:newYorkTimestamp(day.replaceAll('-','')+'T080000')!,full:isFullKibotSession(clock.openAt,clock.closeAt)};});
 const rows:(Flow&{target:string;preceding:string;earlier:string;availableAt:string;issuedAt:string})[]=[];
 const skips:{issueDate:string;reason:string}[]=[];
 const issues=new Set<string>(),references=new Set<string>(),targets=new Set<string>();
 for(const flow of [...flows].sort((a,b)=>a.issueDate.localeCompare(b.issueDate))){
  if(publicDate(flow.issueDate)!==flow.issueDate || flow.issueDate<FIRST_ISSUE || flow.issueDate>LAST_ISSUE ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(flow.referencePeriod) || flow.referencePeriod>=flow.issueDate.slice(0,7) ||
    !Number.isSafeInteger(flow.netCadMillions) || flow.featureCadBillions!==flow.netCadMillions/1000) throw new Error('Flow is outside frozen source contract');
  if(issues.has(flow.issueDate)||references.has(flow.referencePeriod)) throw new Error('Duplicate original monthly observation');
  issues.add(flow.issueDate);references.add(flow.referencePeriod);
  const nextDay=new Date(Date.parse(flow.issueDate)+86400000).toISOString().slice(0,10);
  const availableAt=newYorkTimestamp(nextDay.replaceAll('-','')+'T000000')!;
  const index=cutoffs.find(point=>point.issuedAt>availableAt&&point.full)?.index ?? -1;
  if(index<2){skips.push({issueDate:flow.issueDate,reason:'no_full_target_with_two_prior_sessions'});continue;}
  const target=sessions[index],preceding=sessions[index-1],earlier=sessions[index-2];
  const priorClock=extendedResearchSession(preceding)!;
  if(!isFullKibotSession(priorClock.openAt,priorClock.closeAt)) {skips.push({issueDate:flow.issueDate,reason:'prior_session_is_early_close'});continue;}
  if(targets.has(target))throw new Error('Two releases target the same cash session');
  targets.add(target);
  rows.push({...flow,target,preceding,earlier,availableAt,issuedAt:newYorkTimestamp(target.replaceAll('-','')+'T080000')!});
 }
 return {rows,skips};
}
export function fxChange(fixes:Fix[],target:string) {
 if(fixes.some((f,i)=>publicDate(f.date)!==f.date || ![f.usd,f.cad].every(v=>Number.isFinite(v)&&v>0) || (i>0&&f.date<=fixes[i-1].date)))throw new Error('FX fixes are invalid or out of order');
 const i=fixes.findLastIndex(f=>f.date<target);
 if(i<1 || Date.parse(target)-Date.parse(fixes[i].date)>7*86400000 || Date.parse(fixes[i].date)-Date.parse(fixes[i-1].date)>7*86400000)return null;
 const previous=fixes[i-1],latest=fixes[i];
 return {value:10000*Math.log((latest.usd/latest.cad)/(previous.usd/previous.cad)),dates:[previous.date,latest.date]};
}

export type EcbPoint={date:string;value:number};
type EcbCurrency='USD'|'CAD';
export function parseEcbChunk(body:string,currency:EcbCurrency,from:string,through:string):EcbPoint[]{
 const [head,...rows]=policyCsv(body);
 const fields=['KEY','FREQ','CURRENCY','CURRENCY_DENOM','EXR_TYPE','EXR_SUFFIX','TIME_PERIOD','OBS_VALUE','OBS_STATUS','UNIT','UNIT_MULT'];
 const ix=Object.fromEntries(fields.map(k=>[k,head.indexOf(k)]));
 if(fields.some(k=>ix[k]<0)||!rows.length||publicDate(from)!==from||publicDate(through)!==through||from>through)throw new Error('ECB chunk fields or bounds invalid');
 let previous='';
 return rows.map(r=>{
  const date=r[ix.TIME_PERIOD],value=Number(r[ix.OBS_VALUE]);
  const expected:Record<string,string>={KEY:`EXR.D.${currency}.EUR.SP00.A`,FREQ:'D',CURRENCY:currency,CURRENCY_DENOM:'EUR',EXR_TYPE:'SP00',EXR_SUFFIX:'A',OBS_STATUS:'A',UNIT:currency,UNIT_MULT:'0'};
  if(Object.entries(expected).some(([key,v])=>r[ix[key]]!==v)||publicDate(date)!==date||date<from||date>through||date<=previous||!Number.isFinite(value)||value<=0)throw new Error('ECB chunk series, unit, status or date differs');
  previous=date;return {date,value};
 });
}
export function mergeEcbChunks(chunks:EcbPoint[][]){
 const byDate=new Map<string,number>();let latest='',overlapRows=0;
 for(const [i,points] of chunks.entries()){
  if(!points.length||points.some((p,j)=>publicDate(p.date)!==p.date||!Number.isFinite(p.value)||p.value<=0||(j>0&&p.date<=points[j-1].date)))throw new Error('ECB chunk points invalid');
  const overlap=points.filter(p=>byDate.has(p.date));
  if(i>0&&(!overlap.length||points[0].date>latest))throw new Error('ECB chunks lack verified overlap');
  for(const p of overlap)if(byDate.get(p.date)!==p.value)throw new Error('ECB overlapping original value differs');
  overlapRows+=overlap.length;
  for(const p of points)byDate.set(p.date,p.value);
  latest=[latest,points.at(-1)!.date].sort().at(-1)!;
 }
 return {points:[...byDate].sort(([a],[b])=>a.localeCompare(b)).map(([date,value])=>({date,value})),overlapRows};
}
export function joinEcbLegs(usd:EcbPoint[],cad:EcbPoint[]){
 if(usd.length!==cad.length||usd.some((r,i)=>r.date!==cad[i].date))throw new Error('ECB USD/CAD leg dates do not match exactly');
 return usd.map((r,i)=>({date:r.date,usd:r.value,cad:cad[i].value}));
}
