import { createHash } from "node:crypto";
import { INSTRUMENTS, type Instrument } from "./types.ts";

/** Never persist network frames, post text, account identifiers or record URIs. */
export const BLUESKY_STREAM = "wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents?collections=app.bsky.feed.post";
export const BLUESKY_METHOD = "bluesky-language-cues-v1" as const;
export const MINIMUM_PARTICIPANTS = 10;
export type LanguageCue = "upward" | "downward" | "mixed" | "unclassified";
export type CueCounts = Record<LanguageCue, number>;
export interface CommunityReading {
  instrument: Instrument;
  participants: number;
  distribution: CueCounts | null;
}
export interface BlueskySample {
  schemaVersion: 1;
  method: typeof BLUESKY_METHOD;
  source: { name: "Bluesky Jetstream"; url: "https://bsky.network/docs/jetstream/" };
  startedAt: string;
  endedAt: string;
  expiresAt: string;
  durationSeconds: number;
  status: "sampled" | "insufficient_sample";
  stopReason: "time_limit" | "event_limit" | "byte_limit";
  receivedEvents: number;
  malformedEvents: number;
  filters: Record<string, number>;
  deletionEvents: number;
  accountRemovals: number;
  matchedRecords: number;
  minimumParticipants: 10;
  readings: CommunityReading[];
  sourceDigest: string;
  methodology: string;
  limitations: string[];
}
interface Contribution {
  actor: string;
  record: string;
  sequence: number;
  instruments: Instrument[];
  cue: LanguageCue;
}
export type Exclusions = { actors: string[]; records: string[] };
export function privateIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
const emptyCounts = (): CueCounts => ({ upward: 0, downward: 0, mixed: 0, unclassified: 0 });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const validDID = (v: unknown): v is string => typeof v === "string" && /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:%_-]+)$/.test(v);
export function marketInstruments(text: string): Instrument[] {
  const cleaned = text.replace(/https?:\/\/\S+/gi, " ");
  const instruments: Instrument[] = [];
  if (/\$(?:SPY|SPX)\b|\bS\s*&\s*P\s*500\b/i.test(cleaned)) instruments.push("SPY");
  if (/\$(?:QQQ|NDX)\b|\bNASDAQ\s*100\b/i.test(cleaned)) instruments.push("QQQ");
  if (/\$(?:IWM|RUT)\b|\bRUSSELL\s*2000\b/i.test(cleaned)) instruments.push("IWM");
  if (/\$(?:DIA|DJI)\b|\bDOW\s+JONES\b/i.test(cleaned)) instruments.push("DIA");
  if (/\$TLT\b/i.test(cleaned)) instruments.push("TLT");
  const broad = /\$(?:AAPL|MSFT|NVDA|AMZN|GOOGL|META|TSLA)\b|#stockmarket\b|\b(?:stock market|U\.?S\.? (?:stocks|equities)|Wall Street(?! Journal)|Federal Reserve|Treasury yields)\b/i.test(cleaned);
  return instruments.length || broad ? ["MARKET", ...instruments] : [];
}
export function languageCue(text: string): LanguageCue {
  const cleaned = text.replace(/https?:\/\/\S+/gi, " ");
  // Questions, negation, quotations and conditional phrasing are deliberately unclassified.
  if (/[?"“”]|\b(?:not|no|never|isn['’]t|aren['’]t|wasn['’]t|don['’]t|doesn['’]t|won['’]t|can['’]t|could|might|if|unless)\b/i.test(cleaned)) return "unclassified";
  const upward = /\b(?:bullish|rally|rallies|rallying|uptrend|breakout)\b/i.test(cleaned);
  const downward = /\b(?:bearish|sell[ -]?off|downtrend|breakdown|crashing)\b/i.test(cleaned);
  return upward && downward ? "mixed" : upward ? "upward" : downward ? "downward" : "unclassified";
}

/** A bounded window, with one most recent qualifying record per account for each view. */
export class BlueskyWindow {
  readonly startedAt: string;
  private readonly started: number;
  private contributions = new Map<string, Contribution>();
  private lastSequence = new Map<string, number>();
  private excludedActors: Set<string>;
  private excludedRecords: Set<string>;
  private inactiveActors = new Set<string>();
  private digest = createHash("sha256");
  private events = 0;
  private malformed = 0;
  private deletes = 0;
  private accounts = 0;
  private matched = 0;
  private filters: Record<string, number> = { originalRecords: 0, timestamp: 0, language: 0, replyOrQuote: 0, selfLabel: 0, noMarketMatch: 0, excluded: 0 };
  constructor(startedAt: string, exclusions: Exclusions = { actors: [], records: [] }) {
    this.started = Date.parse(startedAt);
    if (!Number.isFinite(this.started)) throw new Error("Invalid sample start");
    this.startedAt = new Date(this.started).toISOString();
    this.excludedActors = new Set(exclusions.actors);
    this.excludedRecords = new Set(exclusions.records);
  }
  ingest(frame: string, receivedAt: number): void {
    this.events++;
    // Hash is evidence of the received stream, not a stored or recoverable corpus.
    this.digest.update(frame).update("\n");
    let event: Record<string, unknown>;
    try {
      const envelope: unknown = JSON.parse(frame);
      if (!object(envelope) || !object(envelope.payload)) throw new Error();
      event = envelope.payload;
      if (typeof event.$type !== "string") throw new Error();
    } catch { this.malformed++; return; }
    if (!validDID(event.did) || !Number.isSafeInteger(event.seq) || Number(event.seq) < 0) { this.malformed++; return; }
    const actor = privateIdentifier(event.did);
    const sequence = Number(event.seq);
    if (event.$type.endsWith("#account")) {
      // Both flattened and nested documented account payload forms are accepted.
      const account = object(event.account) ? event.account : event;
      if (account.active === false) {
        this.inactiveActors.add(actor);
        for (const [key, value] of this.contributions) if (value.actor === actor) this.contributions.delete(key);
        this.accounts++;
      }
      return;
    }
    if (!event.$type.endsWith("#commit") || event.collection !== "app.bsky.feed.post") return;
    if (typeof event.rkey !== "string" || !/^[A-Za-z0-9._~:-]{1,512}$/.test(event.rkey)) { this.malformed++; return; }
    const recordKey = privateIdentifier(`at://${event.did}/app.bsky.feed.post/${event.rkey}`);
    if (sequence <= (this.lastSequence.get(recordKey) ?? -1)) return;
    this.lastSequence.set(recordKey, sequence);
    if (event.operation === "delete") {
      this.contributions.delete(recordKey);
      this.deletes++;
      return;
    }
    if (event.operation !== "create" && event.operation !== "update") { this.malformed++; return; }
    // An edit can remove eligibility or change the cue; never retain its previous classification.
    this.contributions.delete(recordKey);
    if (this.excludedActors.has(actor) || this.excludedRecords.has(recordKey) || this.inactiveActors.has(actor)) { this.filters.excluded++; return; }
    if (!object(event.record)) { this.malformed++; return; }
    const record = event.record;
    this.filters.originalRecords++;
    const eventTime = typeof event.time === "string" ? Date.parse(event.time) : NaN;
    const authored = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
    if (!Number.isFinite(eventTime) || !Number.isFinite(authored) || eventTime < this.started - 30_000 || eventTime > receivedAt + 10_000 || receivedAt - eventTime > 30_000 || authored < this.started - 30_000 || authored > receivedAt + 10_000) { this.filters.timestamp++; return; }
    if (!Array.isArray(record.langs) || !record.langs.includes("en") || typeof record.text !== "string" || Buffer.byteLength(record.text) > 12_000) { this.filters.language++; return; }
    if (record.reply || (object(record.embed) && typeof record.embed.$type === "string" && record.embed.$type.includes("record"))) { this.filters.replyOrQuote++; return; }
    if (object(record.labels) && Array.isArray(record.labels.values) && record.labels.values.length > 0) { this.filters.selfLabel++; return; }
    const instruments = marketInstruments(record.text);
    if (!instruments.length) { this.filters.noMarketMatch++; return; }
    this.matched++;
    this.contributions.set(recordKey, { actor, record: recordKey, sequence, instruments, cue: languageCue(record.text) });
  }
  finish(endedAt: string, stopReason: BlueskySample["stopReason"]): BlueskySample {
    const ended = Date.parse(endedAt);
    if (!Number.isFinite(ended) || ended <= this.started || ended - this.started > 901_000) throw new Error("Invalid sample window");
    const readings = INSTRUMENTS.map((instrument): CommunityReading => {
      const actors = new Map<string, Contribution>();
      for (const c of this.contributions.values()) {
        if (!c.instruments.includes(instrument)) continue;
        if (c.sequence > (actors.get(c.actor)?.sequence ?? -1)) actors.set(c.actor, c);
      }
      const counts = emptyCounts();
      for (const c of actors.values()) counts[c.cue]++;
      return { instrument, participants: actors.size, distribution: actors.size >= MINIMUM_PARTICIPANTS ? counts : null };
    });
    const sample: BlueskySample = {
      schemaVersion: 1, method: BLUESKY_METHOD,
      source: { name: "Bluesky Jetstream", url: "https://bsky.network/docs/jetstream/" },
      startedAt: this.startedAt, endedAt: new Date(ended).toISOString(),
      expiresAt: new Date(ended + 24 * 60 * 60_000).toISOString(),
      durationSeconds: (ended - this.started) / 1000,
      status: readings[0].distribution ? "sampled" : "insufficient_sample", stopReason,
      receivedEvents: this.events, malformedEvents: this.malformed, filters: { ...this.filters }, deletionEvents: this.deletes,
      accountRemovals: this.accounts, matchedRecords: this.matched,
      minimumParticipants: 10, readings, sourceDigest: this.digest.digest("hex"),
      methodology: "Bounded live-tail sample. English-tagged original posts containing an exact supported cashtag/index name or a declared financial-market phrase or selected large-cap cashtag; no replies, quotes or self-labelled posts. One most recent qualifying post per distinct account per view. Counts are simple English language cues, with questions, negation and conditional statements left unclassified. Updates, deletes and account removals received during the window are applied. No post text, handles or raw account identifiers saved; private exclusion hashes are retained only to honor reports.",
      limitations: [
        "Selected Bluesky discussion, not X, Instagram, all Bluesky, representative retail positioning or verified unique people. Accounts may be bots or coordinated.",
        "Word cues miss context, sarcasm and the subject of a view. Unclassified does not mean neutral. No classifier accuracy or investment intent is established.",
        "A short capture is not a full day. Posts with absent/other language tags, replies, quotes, other tickers, old timestamps and missing stream events are excluded.",
        "Post-window changes cannot be reconciled to individual counts after identifiers are discarded; a removal report invalidates the entire sample. Samples expire after24hours and are excluded from consensus, immutable archives and model training.",
        "Each instrument uses its own matching sample. Multi-instrument posts can appear in more than one view; do not add those counts together.",
      ],
    };
    this.contributions.clear(); this.lastSequence.clear(); this.inactiveActors.clear();
    return sample;
  }
}

export async function collectBlueskySample(options: { seconds?: number; exclusions?: Exclusions; maxEvents?: number; maxBytes?: number } = {}): Promise<BlueskySample> {
  const seconds = options.seconds ?? 120;
  const maxEvents = options.maxEvents ?? 100_000;
  const maxBytes = options.maxBytes ?? 50_000_000;
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 900 || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 50_000_000) throw new Error("Invalid bounded sample options");
  return await new Promise((resolve, reject) => {
    let window: BlueskyWindow | null = null, bytes = 0, events = 0, settled = false, lastReceivedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = new WebSocket(BLUESKY_STREAM, "xrpc.v1.json");
    const finish = (reason?: BlueskySample["stopReason"]) => {
      if (settled) return;
      settled = true; clearTimeout(connectTimer); clearTimeout(timer);
      socket.close();
      if (!reason || !window || events === 0 || Date.now() - lastReceivedAt > 30_000) reject(new Error("Bluesky live sample unavailable; no content logged or published"));
      else {
        const sample = window.finish(new Date().toISOString(), reason);
        if (sample.filters.originalRecords === 0 || sample.malformedEvents > sample.receivedEvents * 0.01) reject(new Error("Bluesky stream schema could not be verified; no content logged or published"));
        else resolve(sample);
      }
    };
    const connectTimer = setTimeout(() => finish(), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer); window = new BlueskyWindow(new Date().toISOString(), options.exclusions);
      timer = setTimeout(() => finish("time_limit"), seconds * 1000);
    });
    socket.addEventListener("message", (event) => {
      if (settled || !window) return;
      if (typeof event.data !== "string") { finish(); return; }
      lastReceivedAt = Date.now();
      bytes += Buffer.byteLength(event.data); events++;
      if (bytes > maxBytes) { finish("byte_limit"); return; }
      window.ingest(event.data, Date.now());
      if (events >= maxEvents) finish("event_limit");
    });
    socket.addEventListener("error", () => finish());
    socket.addEventListener("close", () => finish());
  });
}
