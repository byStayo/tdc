"use client";
import { useEffect, useRef, useState } from "react";
import type { Instrument } from "@/lib/consensus/types";
import styles from "./FinraWeeklyView.module.css";
const ETFS=["SPY","QQQ","IWM","DIA","TLT"];
export default function FinraWeeklyView({instrument}:{instrument:Instrument}) {
  const [accepted,setAccepted]=useState(false),[symbol,setSymbol]=useState(instrument==="MARKET"?"SPY":instrument),[view,setView]=useState<{html:string;symbol:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const controller=useRef<AbortController|null>(null);
  const expiryTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>{controller.current?.abort();clearTimeout(expiryTimer.current);},[]);
  useEffect(()=>{const observer=new MutationObserver(()=>close());observer.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});return()=>observer.disconnect();},[]);
  async function load(){
    if(!accepted||busy)return;const requestedSymbol=symbol;controller.current?.abort();const c=new AbortController();controller.current=c;setBusy(true);setError("");setView(null);
    try{const dark=document.documentElement.getAttribute("data-theme")==="dark" || document.body.getAttribute("data-theme")==="dark";const r=await fetch("/finra-view",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accepted:true,agreement:"finra-equity-2022-12-20-v1",symbol:requestedSymbol,dark}),cache:"no-store",signal:c.signal});if(!r.ok)throw Error("Verified FINRA data is unavailable. Please use the official reader link below.");const expires=Number(r.headers.get("X-Finra-Expires"));if(!Number.isFinite(expires)||expires<=Date.now())throw Error("The verified FINRA view has expired.");const text=await r.text();if(!c.signal.aborted){setView({html:text,symbol:requestedSymbol});clearTimeout(expiryTimer.current);expiryTimer.current=setTimeout(()=>{close();setError("The FINRA view expired. Please reopen after the next verified refresh.");},expires-Date.now());}}catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:"Unable to open FINRA view.");}finally{if(!c.signal.aborted)setBusy(false);}
  }
  function close(){clearTimeout(expiryTimer.current);controller.current?.abort();setView(null);setAccepted(false);setBusy(false);setError("");}
  return <details className={styles.view} onToggle={e=>{if(!e.currentTarget.open)close();}}>
    <summary>FINRA weekly ETF volume</summary>
    <p>Compare delayed ATS and non-ATS shares traded. FINRA is the owner and source. These totals do not indicate buying or selling pressure and carry no consensus vote.</p>
    {!view&&<><label className={styles.agreement}><input type="checkbox" checked={accepted} onChange={e=>{if(e.target.checked)setAccepted(true);else close();}}/><span>I agree to use this free FINRA data only for non-commercial personal or professional purposes and not to redistribute it. <a href="https://developer.finra.org/specific-terms-equity-data" target="_blank" rel="noopener noreferrer">Read the FINRA Equity Data terms</a>.</span></label><div className={styles.controls}>{instrument==="MARKET"&&<label>ETF <select disabled={busy} value={symbol} onChange={e=>setSymbol(e.target.value as typeof symbol)}>{ETFS.map(s=><option key={s}>{s}</option>)}</select></label>}<button disabled={!accepted||busy} onClick={load}>{busy?"Opening verified data…":"Agree and view FINRA data"}</button>{busy&&<button onClick={close}>Cancel</button>}</div></>}
    {error&&<p role="alert">{error}</p>}
    {view&&<><button onClick={close}>Close FINRA view</button><iframe className={styles.frame} title={`${view.symbol} FINRA weekly off-exchange volume`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={view.html}/></>}
    <p className={styles.note}>Current view only · no downloads or onward redistribution · omitted from historical editions. Closing or collapsing this section unloads the data.</p>
  </details>;
}
