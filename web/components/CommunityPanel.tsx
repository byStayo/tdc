"use client";
import { useEffect, useState } from "react";
import { COMMUNITY_CONTACT, COMMUNITY_LABELS, currentCommunity, type CommunitySample } from "@/lib/community";
import type { Instrument } from "@/lib/consensus/types";
import styles from "./CommunityPanel.module.css";
const format = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }).format(new Date(value));
export default function CommunityPanel({ instrument, historical }: { instrument: Instrument; historical: boolean }) {
  const [sample, setSample] = useState<CommunitySample | null>(null);
  const [loading, setLoading] = useState(!historical);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (historical) return;
    let disposed = false;
    const controller = new AbortController();
    const load = async () => {
      if (!disposed) setNow(Date.now());
      try {
        const response = await fetch("/api/community", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error();
        const payload = await response.json();
        const next = currentCommunity(payload.sample);
        if (!disposed) { setSample(next); setNow(Date.now()); }
      } catch { if (!disposed) { setSample(null); setNow(Date.now()); } }
      finally { if (!disposed) setLoading(false); }
    };
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => { disposed = true; controller.abort(); window.clearInterval(interval); };
  }, [historical]);
  const active = !historical && sample && Date.parse(sample.expiresAt) > now ? sample : null;
  const reading = active?.readings.find((row) => row.instrument === instrument);
  return <section className={styles.panel} aria-label="Bluesky market-discussion sample">
    <div className={styles.heading}><div><span className={styles.eyebrow}>BLUESKY · A SMALL COMMUNITY SAMPLE</span><h3>The language around the market</h3></div><span className={styles.badge}>Context only</span></div>
    {historical ? <p className={styles.notice}>Community samples are current-only. They are not part of this saved edition.</p> : loading ? <p className={styles.notice} role="status">Checking the latest saved sample…</p> : !active || !reading ? <p className={styles.notice}>No current sample meets the publication checks. No sentiment is inferred.</p> : <>
      <p className={styles.window}>Captured {format(active.startedAt)} – {format(active.endedAt)}</p>
      <p className={styles.lead}><strong>{reading.participants}</strong> distinct {reading.participants === 1 ? "account" : "accounts"} matched {instrument === "MARKET" ? "the declared market filters" : `${instrument}/related-index filters`}. One qualifying post per account.</p>
      {reading.distribution ? <dl className={styles.lanes}>{Object.entries(COMMUNITY_LABELS).map(([key, label]) => {
        const count = reading.distribution![key as keyof typeof COMMUNITY_LABELS];
        const percent = count / reading.participants * 100;
        return <div key={key} className={styles.lane}><dt>{label}</dt><dd><span className={styles.track} aria-hidden="true"><span style={{ width: `${percent}%` }} /></span><span className={styles.value}>{count} <small>· {Math.round(percent)}%</small></span></dd></div>;
      })}</dl> : <p className={styles.notice}>Fewer than {active.minimumParticipants} accounts matched this instrument. The distribution is withheld.</p>}
      <p className={styles.qualifier}>Simple word cues, not a validated sentiment score. “Unclassified” does not mean neutral. This sample does not represent X, Instagram or all investors.</p>
    </>}
    <details className={styles.method}><summary>How this sample works</summary><div>
      <p>A bounded live Bluesky capture includes English-tagged original posts with $SPY/$SPX, $QQQ/$NDX, $IWM/$RUT, $DIA/$DJI, $TLT and the S&P 500, Nasdaq 100, Russell 2000 or Dow Jones names. The market view also includes $AAPL, $MSFT, $NVDA, $AMZN, $GOOGL, $META, $TSLA, #stockmarket and the phrases “stock market,” “US stocks,” “US equities,” “Wall Street,” “Federal Reserve” and “Treasury yields.” URLs, replies, quoted posts, self-labelled content and old timestamps are excluded. Each instrument uses its own matching subset; counts cannot be added across views.</p>
      <p>“Bullish,” “rally,” “uptrend” and “breakout” are upward cues; “bearish,” “sell-off,” “downtrend,” “breakdown” and “crashing” are downward cues. Both produces mixed; questions, negation, conditional language or no cue remain unclassified. Context, bots, coordination and sarcasm can mislead this simple method. No accuracy claim is made.</p>
      <p>Updates, deletions and account removals received during capture are applied. Raw posts, handles and account IDs are never saved or displayed. Non-identifying totals may remain in source-version history; they are excluded from saved consensus editions, directional votes and model training. The current display expires after 24 hours.</p>
      <p>A verified removal report withdraws the entire current sample because individual contributions cannot be reconstructed after capture. An exclusion stored privately as a one-way identifier hash can prevent future inclusion. Contact support for content-removal or abuse reports; include a post link if relevant. No posts are accepted or shared through this site.</p>
      {active && <p>Sample ends {format(active.endedAt)} · expires {format(active.expiresAt)} · {active.receivedEvents.toLocaleString()} received stream events, including nonmatching and deletion events.</p>}
    </div></details>
    <div className={styles.links}><a href="https://bsky.network/docs/jetstream/" target="_blank" rel="noopener noreferrer">Bluesky source & documentation ↗</a><a href={`mailto:${COMMUNITY_CONTACT}?subject=Daily%20Consensus%20content%20report`}>Report or request removal</a></div>
  </section>;
}
