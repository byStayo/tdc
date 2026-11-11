import { createHash } from "node:crypto";
import { INSTRUMENTS, type Instrument } from "./types.ts";

/** Never persist network frames, post text, account identifiers or record URIs. */
export const BLUESKY_STREAM = "wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents?collections=app.bsky.feed.post";
export const BLUESKY_METHOD = "bluesky-market-stance-v2" as const;
export const X_STANCE_METHOD = "x-explicit-stances-v2" as const;
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
  stopReason: "time_limit" | "event_limit" | "byte_limit" | "recent_window_complete";
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
  cues: Partial<Record<Instrument, LanguageCue>>;
}
export type Exclusions = { actors: string[]; records: string[] };
export function privateIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
const emptyCounts = (): CueCounts => ({ upward: 0, downward: 0, mixed: 0, unclassified: 0 });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const validDID = (v: unknown): v is string => typeof v === "string" && /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:%_-]+)$/.test(v);
const etfNames = {
  SPY: /\$(?:SPY|SPX)\b|\bS\s*&\s*P\s*500\b/i,
  QQQ: /\$(?:QQQ|NDX)\b|\bNASDAQ\s*100\b/i,
  IWM: /\$(?:IWM|RUT)\b|\bRUSSELL\s*2000\b/i,
  DIA: /\$(?:DIA|DJI)\b|\bDOW\s+JONES\b/i,
  TLT: /\$TLT\b/i,
};
const etfAliases = Object.entries(etfNames) as [Exclude<Instrument, "MARKET">, RegExp][];
const equityMarket = /#stockmarket\b|\b(?:stock market|U\.?S\.? (?:stocks|equities)|Wall Street(?! Journal))\b/i;
const relatedMarket = /\$(?:AAPL|MSFT|NVDA|AMZN|GOOGL|META|TSLA)\b|\b(?:Federal Reserve|Treasury yields)\b/i;
const stanceSubjects = [...etfAliases, ["MARKET", equityMarket] as const];
const withoutLinks = (text: string) => text.replace(/https?:\/\/\S+/gi, " ");
export function marketInstruments(text: string): Instrument[] {
  const cleaned = withoutLinks(text);
  const instruments = etfAliases.filter(([, pattern]) => pattern.test(cleaned)).map(([instrument]) => instrument);
  return instruments.length || equityMarket.test(cleaned) || relatedMarket.test(cleaned) ? ["MARKET", ...instruments] : [];
}

const uncertain = /\b(?:not|no|never|isn['’]t|aren['’]t|wasn['’]t|don['’]t|doesn['’]t|won['’]t|can['’]t|could|might|if|unless)\b/i;
const retrospectiveOrReported = /\b(?:yesterday|last (?:week|month|year)|(?:days?|weeks?|months?) ago|said|says|according to|sarcasm)\b/i;
const upward = /\bbullish\b/i;
const downward = /\bbearish\b/i;
const forwardMove = /^\s*(?:will|should|to)\s+(?:(rise|climb|gain|rally|break out|move up|go up)|(fall|drop|decline|sell off|break down|move down|go down))\b/i;

function combineCue(prior: LanguageCue | undefined, next: LanguageCue): LanguageCue {
  if (!prior || prior === "unclassified") return next;
  if (next === "unclassified" || prior === next) return prior;
  return "mixed";
}

export function marketStances(text: string, source?: "x"): Partial<Record<Instrument, LanguageCue>> {
  const cleaned = withoutLinks(text);
  const cues: Partial<Record<Instrument, LanguageCue>> = {};
  // A quoted or interrogative post is too ambiguous to classify across clauses.
  if ((source === "x" ? /["“”]/ : /[?"“”]/).test(cleaned) ||
      /(?:^|\s)\/s\b|\b(?:if|unless)\b/i.test(cleaned)) return cues;
  const clauses = cleaned.replace(/\bU\.?S\.? (?=stocks|equities)/gi, "US ")
    .split(/[,;!\n]|\.(?=\s|$)|(?<=\?)\s+|\b(?:but|while|whereas)\b/i);
  for (const clause of clauses) {
    if (clause.includes("?")) continue;
    if (uncertain.test(clause) || retrospectiveOrReported.test(clause) || relatedMarket.test(clause)) continue;
    const subjects = stanceSubjects.flatMap(([instrument, pattern]) => {
      const match = pattern.exec(clause);
      return match ? [{ instrument, start: match.index, end: match.index + match[0].length }] : [];
    });
    if (subjects.length !== 1) continue;
    const [{ instrument, start, end }] = subjects;
    const before = clause.slice(0, start);
    const after = clause.slice(end);
    let stance = after.match(/^\s*(?:(?:looks?|remains?|is|am|stays?)\s+)?(bullish|bearish)\b/i)?.[1] ??
      before.match(/\b(bullish|bearish)\s+on\s*$/i)?.[1];
    let move = /^\s*to\b/i.test(after) && !/\b(?:expect|expects|expecting)\s*$/i.test(before) ? null : after.match(forwardMove);
    if (source === "x") {
      // Ticker-first headings and concise first-person calls are common on X.
      if (/\b(?:above|below|provided|assuming|only when|as long as)\b/i.test(clause)) continue;
      const tail = after.replace(/^\s*(?:(?:[:=→–—-]|🟢|🔴)\s*)+/u, "");
      const lead = before.replace(/(?:[:=→–—-]|🟢|🔴|\s)+$/u, "");
      stance ??= tail.match(/^\s*(?:(?:still|now|very|leaning|looks?|remains?|is|stays?)\s+){0,2}(bullish|bearish)\b/i)?.[1] ??
        tail.match(/^\s*(?:bias|outlook|stance)\s*(?:is\s+|[:=]\s*)(bullish|bearish)\b/i)?.[1] ??
        lead.match(/^(?:\s*|\s*i(?:['’]m| am)\s+)(bullish|bearish)(?:\s+(?:bias|outlook|stance))?(?:\s+(?:on|for)(?:\s+the)?)?$/i)?.[1];
      if (!stance && /\b(?:i(?:['’]m|\s+am)\s+|we(?:['’]re|\s+are)\s+)?(?:going|leaning)\s+(?:long|short)\s+(?:on\s+)?$/i.test(before))
        stance = /\bshort\s+(?:on\s+)?$/i.test(before) ? "bearish" : "bullish";
      move ??= tail.match(/^\s*(?:will|should)\s+(?:(bounce|recover|push higher|break higher)|(roll over|push lower|break lower|selloff))\b/i);
      if (!stance && /\b(?:expect|expects|expecting)\s*$/i.test(before)) {
        const direction = tail.match(/^\s*(higher|lower)\b/i)?.[1]?.toLowerCase();
        if (direction) stance = direction === "higher" ? "bullish" : "bearish";
      }
    }
    let cue: LanguageCue = "unclassified";
    if (stance) {
      cue = upward.test(stance) ? "upward" : "downward";
      if (upward.test(after) && downward.test(after)) cue = "mixed";
    } else if (move) cue = move[1] ? "upward" : "downward";
    cues[instrument] = combineCue(cues[instrument], cue);
    if (instrument !== "MARKET") cues.MARKET = combineCue(cues.MARKET, cue);
  }
  return cues;
}

/** A bounded window, with one most recent qualifying record per account for each view. */
export class BlueskyWindow {
  readonly startedAt: string;
  private readonly started: number;
  private readonly recentCursor: boolean;
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
  constructor(startedAt: string, exclusions: Exclusions = { actors: [], records: [] }, recentCursor = false) {
    this.started = Date.parse(startedAt);
    this.recentCursor = recentCursor;
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
    const earliest = this.started - (this.recentCursor ? 0 : 30_000);
    const authorUpperBound = (this.recentCursor ? eventTime : receivedAt) + 10_000;
    if (!Number.isFinite(eventTime) || !Number.isFinite(authored) || eventTime < earliest ||
        eventTime > receivedAt + 10_000 || (!this.recentCursor && receivedAt - eventTime > 30_000) ||
        authored < earliest || authored > authorUpperBound) { this.filters.timestamp++; return; }
    if (!Array.isArray(record.langs) || !record.langs.includes("en") || typeof record.text !== "string" || Buffer.byteLength(record.text) > 12_000) { this.filters.language++; return; }
    if (record.reply || (object(record.embed) && typeof record.embed.$type === "string" && record.embed.$type.includes("record"))) { this.filters.replyOrQuote++; return; }
    if (object(record.labels) && Array.isArray(record.labels.values) && record.labels.values.length > 0) { this.filters.selfLabel++; return; }
    const instruments = marketInstruments(record.text);
    if (!instruments.length) { this.filters.noMarketMatch++; return; }
    this.matched++;
    this.contributions.set(recordKey, { actor, record: recordKey, sequence, instruments, cues: marketStances(record.text) });
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
      for (const c of actors.values()) counts[c.cues[instrument] ?? "unclassified"]++;
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
      methodology: "Bounded Jetstream sample. English-tagged original posts containing an exact supported cashtag/index name or a declared financial-market phrase or selected large-cap cashtag; no replies, quotes or self-labelled posts. One most recent qualifying post per distinct account per view. Local English-language rules attach explicit forward moves or stances to a single named equity subject per clause. Questions, uncertain language, hindsight and unclear subjects are left unclassified. Updates, deletes and account removals received during the window are applied. No post text, handles or raw account identifiers saved; private exclusion hashes are retained only to honor reports.",
      limitations: [
        "Selected Bluesky discussion, not X, Instagram, all Bluesky, representative retail positioning or verified unique people. Accounts may be bots or coordinated.",
        "The rules can miss context, irony and indirect expressions. Unclassified does not mean neutral. No classifier accuracy or investment intent is established.",
        "A short capture is not a full day. Posts with absent/other language tags, replies, quotes, other tickers, old timestamps and missing stream events are excluded.",
        "Post-window changes cannot be reconciled to individual counts after identifiers are discarded; a removal report invalidates the entire sample. Samples expire after24hours and are excluded from consensus, immutable archives and model training.",
        "Each instrument uses its own matching sample. Multi-instrument posts can appear in more than one view; do not add those counts together.",
      ],
    };
    this.contributions.clear(); this.lastSequence.clear(); this.inactiveActors.clear();
    return sample;
  }
}

export async function collectBlueskySample(options: { seconds?: number; recentSeconds?: number; exclusions?: Exclusions; maxEvents?: number; maxBytes?: number } = {}): Promise<BlueskySample> {
  const seconds = options.seconds ?? 120;
  const maxEvents = options.maxEvents ?? 100_000;
  const maxBytes = options.maxBytes ?? 50_000_000;
  const recentSeconds = options.recentSeconds;
  if (recentSeconds !== undefined && (options.seconds !== undefined || !Number.isInteger(recentSeconds) || recentSeconds < 60 || recentSeconds > 840))
    throw new Error("Invalid bounded sample options");
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 900 || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 50_000_000) throw new Error("Invalid bounded sample options");
  return await new Promise((resolve, reject) => {
    let window: BlueskyWindow | null = null, bytes = 0, events = 0, settled = false, lastReceivedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = recentSeconds === undefined ? null : Date.now() - 15_000;
    const cursorStart = cutoff === null || recentSeconds === undefined ? null : cutoff - recentSeconds * 1000;
    let sawStart = false;
    const endpoint = new URL(BLUESKY_STREAM);
    if (cursorStart !== null) endpoint.searchParams.set("cursor", String(cursorStart * 1000));
    const socket = new WebSocket(endpoint.href, "xrpc.v1.json");
    const finish = (reason?: BlueskySample["stopReason"]) => {
      if (settled) return;
      settled = true; clearTimeout(connectTimer); clearTimeout(timer);
      socket.close();
      if (!reason || !window || events === 0 || Date.now() - lastReceivedAt > 30_000 || (cutoff !== null && reason !== "recent_window_complete")) reject(new Error("Bluesky live sample unavailable; no content logged or published"));
      else {
        const sample = window.finish(new Date(cutoff ?? Date.now()).toISOString(), reason);
        if (sample.filters.originalRecords === 0 || sample.malformedEvents > sample.receivedEvents * 0.01) reject(new Error("Bluesky stream schema could not be verified; no content logged or published"));
        else resolve(sample);
      }
    };
    const connectTimer = setTimeout(() => finish(), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      window = new BlueskyWindow(new Date(cursorStart ?? Date.now()).toISOString(), options.exclusions, cursorStart !== null);
      timer = setTimeout(() => finish("time_limit"), cursorStart === null ? seconds * 1000 : 90_000);
    });
    socket.addEventListener("message", (event) => {
      if (settled || !window) return;
      if (typeof event.data !== "string") { finish(); return; }
      lastReceivedAt = Date.now();
      bytes += Buffer.byteLength(event.data);
      if (bytes > maxBytes) { finish("byte_limit"); return; }
      if (cursorStart !== null && cutoff !== null) {
        let when = NaN;
        try {
          const envelope = JSON.parse(event.data);
          if (envelope?.$type === "error") { finish(); return; }
          when = Date.parse(envelope?.payload?.time);
        } catch { /* The window counts malformed frames without retaining them. */ }
        if (Number.isFinite(when)) {
          if (!sawStart && Math.abs(when - cursorStart) > 30_000) { finish(); return; }
          sawStart = true;
          if (when >= cutoff) { finish("recent_window_complete"); return; }
        }
      }
      events++;
      window.ingest(event.data, Date.now());
      if (events >= maxEvents) finish("event_limit");
    });
    socket.addEventListener("error", () => finish());
    socket.addEventListener("close", () => finish());
  });
}
