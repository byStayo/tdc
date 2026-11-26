import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { createElement, type ComponentType, type ReactNode } from 'react';
import ts from 'typescript';
import { collectEtfFlows } from '../lib/consensus/etf-flows.ts';
import { fixture } from './fixtures/etf-flows.ts';
import type { Instrument, Signal, Snapshot } from '../lib/consensus/types.ts';

test('the actual flow panel isolates instruments and never injects current values into an old edition',async()=>{
  const component=new URL('../components/EtfFlows.tsx',import.meta.url);
  const loader=registerHooks({
    resolve(specifier,context,next){
      if(specifier==='@/lib/consensus/engine')return {url:new URL('../lib/consensus/engine.ts',import.meta.url).href,shortCircuit:true};
      return next(specifier,context);
    },
    load(url,context,next){
      if(url.endsWith('/EtfFlows.module.css'))return {format:'module',source:'export default {};',shortCircuit:true};
      if(url!==component.href)return next(url,context);
      return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
    },
  });
  try{
    const {default:Panel}=await import(component.href) as {default:ComponentType<{signals:Signal[];instrument:Instrument;reference:string}>};
    const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup(element:ReactNode):string};
    const reference='2026-11-10T04:00:00.000Z',text=JSON.stringify(fixture());
    const signals=await collectEtfFlows(async()=>({text,sha256:createHash('sha256').update(text).digest('hex'),retrievedAt:reference}),()=>reference);
    const render=(instrument:Instrument,rows=signals)=>renderToStaticMarkup(createElement(Panel,{instrument,signals:rows,reference}));
    const market=render('MARKET');assert.match(market,/Daily ETF fund flows/);assert.match(market,/QQQ|IWM|TLT/);assert.match(market,/Held|held/);assert.match(market,/No reading/);
    const qqq=render('QQQ');assert.match(qqq,/\+\$100M/);assert.doesNotMatch(qqq,/>IWM<|>SPY<|Covered US ETF sample/);
    assert.match(render('SPY'),/held for provider review/);assert.match(render('DIA'),/not included/);
    const old=JSON.parse(readFileSync(new URL('../public/consensus/2026-11-06T17-01-48-890Z.json',import.meta.url),'utf8')) as Snapshot;
    assert.equal(render('MARKET',old.signals),'');
    assert.doesNotMatch(market,/10,000,000,000|startNetAssets|sharesOutstanding/);
  }finally{loader.deregister()}
});
