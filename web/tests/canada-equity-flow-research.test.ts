import test from 'node:test';
import assert from 'node:assert/strict';
import { flowTargets, fxChange, parseEcbChunk, mergeEcbChunks, joinEcbLegs } from '../lib/consensus/canada-equity-flow-research.ts';
const flow = (issueDate: string, referencePeriod='2015-11') => ({issueDate,referencePeriod,netCadMillions:-2765,featureCadBillions:-2.765});
test('08:30 originals miss the issue cutoff; conservative day bound respects weekends and DST',()=>{
 const winter=flowTargets([flow('2016-01-19')]);
 assert.equal(winter.rows[0].target,'2016-01-20');
 assert.equal(winter.rows[0].availableAt,'2016-01-20T05:00:00.000Z');
 assert.equal(winter.rows[0].issuedAt,'2016-01-20T13:00:00.000Z');
 const summer=flowTargets([flow('2026-10-16','2026-08')]);
 assert.equal(summer.rows[0].target,'2026-10-19');
 assert.equal(summer.rows[0].availableAt,'2026-10-17T04:00:00.000Z');
 assert.equal(summer.rows[0].issuedAt,'2026-10-19T12:00:00.000Z');
 assert.equal(summer.rows[0].featureCadBillions,-2.765);
});
test('the independent calendar skips the Bush funeral and does not replace full-session controls with an early close',()=>{
 assert.equal(flowTargets([flow('2018-12-04','2018-10')]).rows[0].target,'2018-12-06');
 const x=flowTargets([flow('2020-11-25','2020-09')]);
 assert.equal(x.rows.length,0);assert.equal(x.skips[0].reason,'prior_session_is_early_close');
});
test('one source observation is used once, with duplicate and prospective issues rejected',()=>{
 assert.throws(()=>flowTargets([flow('2016-01-19'),flow('2016-01-19')]),/Duplicate/);
 assert.throws(()=>flowTargets([flow('2026-11-17','2026-09')]),/frozen/);
});
test('CAD/USD cross has the declared sign, excludes same-day fixes and rejects unmatched or stale observations',()=>{
 const fixes=[{date:'2026-10-15',usd:1.2,cad:1.6},{date:'2026-10-16',usd:1.2,cad:1.5},{date:'2026-10-19',usd:9,cad:1}];
 const result=fxChange(fixes,'2026-10-19')!;
 assert.deepEqual(result.dates,['2026-10-15','2026-10-16']);
 assert.ok(Math.abs(result.value-10000*Math.log(1.6/1.5))<1e-9);
 assert.equal(fxChange(fixes.slice(0,1),'2026-10-19'),null);
 assert.equal(fxChange(fixes,'2026-11-01'),null);
});

const header='KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,UNIT,UNIT_MULT';
const line=(currency:string,date:string,value:number)=>`EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value},A,${currency},0`;
const csv=(currency:string,points:[string,number][])=>header+'\n'+points.map(([date,value])=>line(currency,date,value)).join('\n');
test('chunk parsing preserves ECB units, signed cross meaning and exact original observation dates',()=>{
 assert.deepEqual(parseEcbChunk(csv('USD',[['2016-12-29',1.2]]),'USD','2015-12-20','2016-12-31'),[{date:'2016-12-29',value:1.2}]);
 for(const bad of [csv('USD',[['2016-12-29',1.2]]).replace(',EUR,',',CAD,'),csv('USD',[['2016-12-29',1.2]]).replace(',USD,0',',USD,2'),csv('USD',[['2016-12-29',1.2]]).replace(',A,USD',',P,USD')])assert.throws(()=>parseEcbChunk(bad,'USD','2015-12-20','2016-12-31'));
});
test('overlapping chunks canonicalize the same observations once and reject conflicts or unverified gaps',()=>{
 const a=[{date:'2016-12-29',value:1.2},{date:'2016-12-30',value:1.3}];
 const b=[{date:'2016-12-30',value:1.3},{date:'2017-01-02',value:1.4}];
 const out=mergeEcbChunks([a,b]);
 assert.deepEqual(out.points,[...a,b[1]]);assert.equal(out.overlapRows,1);
 assert.throws(()=>mergeEcbChunks([a,[{...b[0],value:1.31},b[1]]]),/differs/);
 assert.throws(()=>mergeEcbChunks([a,[b[1]]]),/overlap/);
});
test('USD and CAD legs must match every date before using the frozen CAD/USD cross',()=>{
 const usd=[{date:'2016-12-29',value:1.2},{date:'2016-12-30',value:1.3}],cad=[{date:'2016-12-29',value:1.5},{date:'2016-12-30',value:1.6}];
 assert.deepEqual(joinEcbLegs(usd,cad),[{date:'2016-12-29',usd:1.2,cad:1.5},{date:'2016-12-30',usd:1.3,cad:1.6}]);
 assert.throws(()=>joinEcbLegs(usd,cad.slice(1)),/dates/);
});
