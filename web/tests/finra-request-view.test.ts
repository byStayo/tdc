import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {registerHooks,createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {createElement,type ComponentType,type ReactNode} from "react";
import ts from "typescript";

test("the actual FINRA frame names the completed request, even when the current selector differs",async()=>{
 const component=new URL("../components/FinraWeeklyView.tsx",import.meta.url);
 const react=pathToFileURL(createRequire(import.meta.url).resolve("react")).href;
 // Inject the race's resulting state into the real component: current selection
 // QQQ, completed response SPY. No provider input or extra production props.
 const hooks="data:text/javascript,"+encodeURIComponent(`export {useRef,useEffect} from ${JSON.stringify(react)};export function useState(initial){return [initial===null?{html:'<p>SPY synthetic response</p>',symbol:'SPY'}:initial==='SPY'?'QQQ':initial,()=>{}];}`);
 const loader=registerHooks({
  resolve(specifier,context,next){if(specifier==="react"&&context.parentURL===component.href)return{url:hooks,shortCircuit:true};return next(specifier,context);},
  load(url,context,next){
   if(url.endsWith("/FinraWeeklyView.module.css"))return{format:"module",source:"export default {};",shortCircuit:true};
   if(url!==component.href)return next(url,context);
   return{format:"module",source:ts.transpileModule(readFileSync(component,"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
  }
 });
 try{
  const {default:View}=await import(component.href) as {default:ComponentType<{instrument:"MARKET"}>};
  const {renderToStaticMarkup}=createRequire(import.meta.url)("react-dom/server") as {renderToStaticMarkup:(node:ReactNode)=>string};
  const html=renderToStaticMarkup(createElement(View,{instrument:"MARKET"}));
  assert.match(html,/title="SPY FINRA weekly off-exchange volume"/);
  assert.doesNotMatch(html,/title="QQQ FINRA/);
  assert.match(html,/SPY synthetic response/);
 }finally{loader.deregister();}
});
