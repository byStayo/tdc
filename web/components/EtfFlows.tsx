import type { Instrument, Signal } from '@/lib/consensus/types';
import { effectiveStatus } from '@/lib/consensus/engine';
import styles from './EtfFlows.module.css';

const dollars = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}$${new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(Math.abs(value))}`;
const dated = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});

/** Read the selected edition only. No provider fetches or inferred flows. */
export default function EtfFlows({ signals, instrument, reference }: {signals:Signal[];instrument:Instrument;reference:string}) {
  const flows=signals.filter(signal=>signal.id.startsWith('etfiq-flow-') && (instrument==='MARKET'||signal.instruments.includes(instrument)));
  if (!flows.length) return null;
  const scale=Math.max(1,...flows.filter(s=>s.id!=='etfiq-flow-MARKET').flatMap(s=>s.series.map(p=>Math.abs(p.value))));
  return <section className={styles.section} aria-label="Daily ETF fund flows">
    <header className={styles.heading}><div><p>CREATIONS & REDEMPTIONS</p><h2>Money moving through ETFs.</h2></div><span>Saved daily context · no directional vote</span></header>
    <p className={styles.intro}>Net fund creations and redemptions, calculated by ETFIQ from issuer share counts. The flow date follows the provider’s convention and reflects the prior trading day’s orders.</p>
    <div className={styles.grid}>{flows.map(signal=>{
      const point=signal.series.at(-1),status=effectiveStatus(signal,reference),symbol=signal.instruments[0];
      return <article className={styles.card} key={signal.id}>
        <div className={styles.label}><h3>{symbol==='MARKET'?'Covered US ETF sample':symbol}</h3><span>{point?(status==='stale'?'Older observation':'Dated observation'):'No reading'}</span></div>
        {point?<>
          <strong className={styles.value}>{dollars(point.value)}</strong>
          <p className={styles.date}>Flow dated {dated(point.date)}</p>
          {signal.collectionNote && <p className={styles.missing}>{signal.collectionNote}</p>}
          {symbol!=='MARKET'&&<div className={styles.track} aria-hidden="true"><i className={point.value<0?styles.negative:styles.positive} style={{width:`${Math.abs(point.value)/scale*100}%`}}/></div>}
          {signal.metrics.slice(1).filter(m=>m.unit==='funds'||m.unit==='%').map(metric=><p key={metric.label} className={styles.metric}>{metric.label}: <strong>{new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(metric.value)}{metric.unit==='%'?'%':''}</strong></p>)}
        </>:<p className={styles.missing}>{signal.summary}</p>}
        <a href={signal.source.url} target="_blank" rel="noreferrer">ETFIQ source ↗</a>
      </article>;
    })}</div>
    <footer className={styles.note}>Flows are not returns, known investor intent or private-equity flows. The sample excludes missing, held and multi-session counts; absence is not zero. <a href="https://etfiq.com/license/" target="_blank" rel="noreferrer">Computed data: ETFIQ, reused with attribution.</a></footer>
  </section>;
}
