import test from "node:test";
import assert from "node:assert/strict";
import {brotliCompressSync} from "node:zlib";
import {decodeFinraDisplay,FINRA_AGREEMENT,renderFinraView,type FinraDisplay} from "../lib/finra-display.ts";
import {POST,GET} from "../app/finra-view/route.ts";
const time="2026-11-06T21:00:00.000Z";
const fixture:FinraDisplay={cutoff:time,retrievedAt:time,sha256:"a".repeat(64),weeks:[{instrument:"SPY",weekStart:"2026-10-12",initialPublished:"2026-11-02",lastUpdated:"2026-11-02",atsShares:123.456789,nonAtsShares:321.123456,atsTrades:10,nonAtsTrades:20}]};
const encode=(data:unknown)=>brotliCompressSync(Buffer.from(JSON.stringify(data))).toString("base64");
test("restricted FINRA snapshot validates provenance, freshness, scope, dates and quantities",()=>{
 const now=Date.parse(time);assert.ok(decodeFinraDisplay(encode(fixture),now));
 for(const value of [{...fixture,retrievedAt:"bad"},{...fixture,sha256:"bad"},{...fixture,weeks:[]},{...fixture,weeks:[...fixture.weeks,...fixture.weeks]},...[-1,Infinity,"123"].map(n=>({...fixture,weeks:fixture.weeks.map(w=>({...w,atsShares:n}))})),... [ {instrument:"MARKET"},{weekStart:"2026-10-13"},{lastUpdated:"2026-11-07"},{initialPublished:"2026-10-01"},{atsTrades:1.5}].map(change=>({...fixture,weeks:fixture.weeks.map(w=>({...w,...change}))}))])assert.equal(decodeFinraDisplay(encode(value),now),null);
 assert.equal(decodeFinraDisplay(encode(fixture),now+7*86400000+1),null);
 assert.equal(decodeFinraDisplay(encode(fixture),now-1),null);
 assert.equal(decodeFinraDisplay("not compressed",now),null);
 assert.equal(decodeFinraDisplay(encode(fixture)+" ".repeat(48001),now),null);
 assert.equal(decodeFinraDisplay(encode({...fixture,cutoff:new Date(now+1000).toISOString()}),now+2000),null);
 assert.equal(decodeFinraDisplay(encode({...fixture,weeks:fixture.weeks.map(w=>({...w,weekStart:"2026-07-27"}))}),now),null);
 const monday=Date.parse("2026-11-02T00:00:00.000Z");
 const tooMany=Array.from({length:66},(_,n)=>{const date=new Date(monday-Math.floor(n/5)*7*86400000).toISOString().slice(0,10);return {...fixture.weeks[0],instrument:["SPY","QQQ","IWM","DIA","TLT"][n%5],weekStart:date,initialPublished:date,lastUpdated:date};});
 assert.equal(decodeFinraDisplay(encode({...fixture,cutoff:new Date(monday).toISOString(),retrievedAt:new Date(monday).toISOString(),weeks:tooMany}),monday),null);
 const escaped=renderFinraView({...fixture,retrievedAt:"Fri, 06 Nov 2026 21:00:00 GMT (<img src=x>)"},"SPY");assert.ok(escaped.includes("&lt;img src=x&gt;"));assert.ok(!escaped.includes("<img src=x>"));
 const html=renderFinraView(fixture,"SPY");assert.match(html,/123\.456789/);assert.match(html,/321\.123456/);assert.match(html,/2026-10-12/);assert.match(html,/FINRA is the owner/);assert.match(html,/No further redistribution/);assert.throws(()=>renderFinraView(fixture,"TLT"));assert.doesNotMatch(html,/<script|application\/json/);
});
test("FINRA HTML view refuses ungated, cross-origin, malformed and expired requests",async()=>{
 const previous=process.env.FINRA_DISPLAY_SNAPSHOT;
 const request=(body:unknown,origin="https://thedailyconsensus.com")=>new Request("https://thedailyconsensus.com/finra-view",{method:"POST",headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
 const accepted={accepted:true,agreement:FINRA_AGREEMENT,symbol:"SPY",dark:false};
 try{
 process.env.FINRA_DISPLAY_SNAPSHOT=encode({...fixture,cutoff:new Date().toISOString(),retrievedAt:new Date().toISOString()});
 // Use a current synthetic week; never use live restricted data in a test fixture.
 const current=new Date();current.setUTCDate(current.getUTCDate()-((current.getUTCDay()+6)%7));const week=current.toISOString().slice(0,10);
 const fresh={...fixture,cutoff:new Date().toISOString(),retrievedAt:new Date().toISOString(),weeks:fixture.weeks.map(w=>({...w,weekStart:week,initialPublished:week,lastUpdated:week}))};
 process.env.FINRA_DISPLAY_SNAPSHOT=encode(fresh);
 assert.equal(GET().status,405);
 assert.equal((await POST(new Request("https://thedailyconsensus.com/finra-view",{method:"POST",headers:{origin:"https://thedailyconsensus.com","Content-Type":"text/plain"},body:JSON.stringify(accepted)}))).status,403);
 assert.equal((await POST(new Request("http://thedailyconsensus.com/finra-view",{method:"POST",headers:{origin:"http://thedailyconsensus.com","Content-Type":"application/json"},body:JSON.stringify(accepted)}))).status,403);
 for(const body of [{...accepted,accepted:false},{...accepted,agreement:"old"},{...accepted,symbol:"MARKET"},{...accepted,dark:"false"}])assert.equal((await POST(request(body))).status,400);
 assert.equal((await POST(request(accepted,"https://evil.example"))).status,403);
 assert.equal((await POST(request("x".repeat(600)))).status,413);
 const good=await POST(request(accepted));assert.equal(good.status,200);assert.equal(Number(good.headers.get("X-Finra-Expires")),Date.parse(fresh.retrievedAt)+7*86400000);assert.match(good.headers.get("cache-control")!,/no-store/);assert.match(good.headers.get("content-type")!,/text\/html/);assert.match(good.headers.get("x-robots-tag")!,/noarchive/);assert.match(await good.text(),/123\.456789/);
 assert.equal((await POST(request({...accepted,symbol:"TLT"}))).status,503);
 delete process.env.FINRA_DISPLAY_SNAPSHOT;assert.equal((await POST(request(accepted))).status,503);
 const past=new Date(Date.now()-8*86400000);const pastMonday=new Date(past);pastMonday.setUTCDate(pastMonday.getUTCDate()-((pastMonday.getUTCDay()+6)%7));const pastWeek=pastMonday.toISOString().slice(0,10);
 process.env.FINRA_DISPLAY_SNAPSHOT=encode({...fixture,cutoff:past.toISOString(),retrievedAt:past.toISOString(),weeks:fixture.weeks.map(w=>({...w,weekStart:pastWeek,initialPublished:pastWeek,lastUpdated:pastWeek}))});assert.equal((await POST(request(accepted))).status,503);
 }finally{if(previous===undefined)delete process.env.FINRA_DISPLAY_SNAPSHOT;else process.env.FINRA_DISPLAY_SNAPSHOT=previous;}
});
