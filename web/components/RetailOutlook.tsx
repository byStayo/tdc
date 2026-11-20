"use client";
import { useEffect, useRef, useState } from "react";
import { retailFrameStatus } from "@/lib/retail-lifecycle";
import styles from "./RetailOutlook.module.css";
const provider = "https://www.myfxbook.com/community/outlook";
export default function RetailOutlook({ historical }: { historical: boolean }) {
  const [loaded, setLoaded] = useState(false), [state, setState] = useState<"loading"|"ready"|"error">("loading");
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (historical) { setLoaded(false); return; }
    if (!loaded) return;
    setState("loading");
    const listener = (event: MessageEvent) => {
      const status = retailFrameStatus(event, frame.current?.contentWindow ?? null);
      if (status) setState(status);
    };
    window.addEventListener("message", listener);
    const timer = window.setTimeout(()=>setState(s=>s==="ready"?s:"error"),15000);
    return()=>{window.removeEventListener("message",listener);window.clearTimeout(timer);};
  },[loaded,historical]);
  return <section className={styles.panel} aria-label="Myfxbook FX community outlook">
    <div className={styles.heading}><div><span className={styles.eyebrow}>MYFXBOOK · FX COMMUNITY</span><h3>How currency traders are positioned</h3></div><span className={styles.badge}>Hosted view</span></div>
    <p className={styles.scope}>Selected Myfxbook community positions across six currency pairs. This is not US ETF positioning or a representative sample of all retail investors.</p>
    {historical ? <p className={styles.note}>This current hosted view is not included in a saved historical edition.</p> : <>
      <div className={styles.actions}><button onClick={()=>{setState("loading");setLoaded(v=>!v);}}>{loaded?"Close hosted view":"Load Myfxbook view"}</button><a href={provider} target="_blank" rel="noopener noreferrer">Open Myfxbook ↗</a></div>
      {!loaded ? <p className={styles.note}>Loads from Myfxbook when you choose. The provider controls availability, timing and privacy.</p> : <div className={styles.stage}>
        <iframe ref={frame} src="/widgets/retail-outlook" title="Six currency pairs: Myfxbook community outlook" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="strict-origin-when-cross-origin" />
        {state!=="ready"&&<div className={styles.status} role="status">{state==="loading"?<p>Loading Myfxbook’s hosted view…</p>:<><p>The hosted view is unavailable.</p><a href={provider} target="_blank" rel="noopener noreferrer">View the source on Myfxbook ↗</a></>}</div>}
      </div>}
    </>}
    <p className={styles.note}>EUR/USD · GBP/USD · USD/JPY · USD/CAD · AUD/USD · USD/CHF. Provider attribution is preserved. These figures are not copied into our saved consensus, history or models.</p>
  </section>;
}
