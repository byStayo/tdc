import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marketInstruments, marketStances, MINIMUM_PARTICIPANTS, X_STANCE_METHOD, xStanceAnalysis,
  type LanguageCue, type XAbstentionReason } from "../lib/consensus/bluesky.ts";
import { rssItems } from "../lib/consensus/collector.ts";
import { nativeAnnotationFolder, startNativeAnnotationCapture, type NativeAnnotationCapture } from "../lib/consensus/social-annotation-capture.ts";
import { instagramCaptionText } from "../lib/consensus/instagram-post-text.ts";
import { sourceChunk, sourceResponse } from "../lib/consensus/source-failure.ts";
import { INSTRUMENTS, type Instrument } from "../lib/consensus/types.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { X_POST_FIELDS, X_POST_TEXT_METHOD, xPostText } from "../lib/consensus/x-post-text.ts";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".editorial");
const starterFeeds = [
  ["TKer", "www.tker.co"],
  ["Apricitas Economics", "www.apricitas.io"],
] as const;
const dayMs = 86_400_000;
export const xSearchQueries = {
  SPY: '($SPY OR $SPX OR "S&P 500")',
  QQQ: '($QQQ OR $NDX OR "Nasdaq 100" OR "Nasdaq-100")',
  IWM: '($IWM OR $RUT OR "Russell 2000")',
  DIA: '($DIA OR $DJI OR "Dow Jones")',
  TLT: "$TLT",
} as const;
const xSearchPageSize = 20;
const xSearchPagesPerInstrument = 2;

type Post = { author: string; at: number; text: string };
type XAccount = { userId: string; apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };
type InstagramAccount = { graphVersion: string; accountId: string; token: string; handles: string[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected object shape");
  return value as Record<string, unknown>;
}

async function privateText(path: string, byteLimit: number) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > byteLimit)
      throw new Error("Expected a bounded owner-only following feed file");
    const buffer = Buffer.alloc(byteLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > byteLimit) throw new Error("Following feed file exceeds its size limit");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function localConfig() {
  const text = await privateText(resolve(directory, "following-config.json"), 8192);
  return text === null ? {} : object(JSON.parse(text));
}

export async function fetchText(url: URL, headers: Record<string, string> = {}) {
  const response = await sourceResponse(fetch, url.href, {
    redirect: "error", signal: AbortSignal.timeout(12000), headers,
  });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await sourceChunk(reader);
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("Feed exceeds 2 MB"); }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isId = (value: unknown): value is string => typeof value === "string" && /^\d{1,25}$/.test(value);
const isCredential = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,2048}$/.test(value);
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase());

function xAuthorization(url: URL, account: XAccount) {
  const oauth = {
    oauth_consumer_key: account.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: account.accessToken,
    oauth_version: "1.0",
  };
  const parameters = [...url.searchParams, ...Object.entries(oauth)]
    .map(([key, value]) => encode(key) + "=" + encode(value)).sort().join("&");
  const signature = createHmac("sha1", encode(account.apiSecret) + "&" + encode(account.accessSecret))
    .update(["GET", encode(url.origin + url.pathname), encode(parameters)].join("&")).digest("base64");
  return "OAuth " + Object.entries({ ...oauth, oauth_signature: signature })
    .map(([key, value]) => key + '="' + encode(value) + '"').join(", ");
}

export async function collectX(input: unknown, cutoff: string, observe?: NativeAnnotationCapture["observe"]) {
  const config = object(input);
  if (!isId(config.userId) || ![config.apiKey, config.apiSecret, config.accessToken, config.accessSecret].every(isCredential))
    throw new Error("Invalid X OAuth 1.0a configuration");
  const account = config as XAccount;
  const url = new URL("https://api.x.com/2/users/" + account.userId + "/timelines/reverse_chronological");
  url.search = new URLSearchParams({
    max_results: "100", start_time: new Date(Date.parse(cutoff) - dayMs).toISOString(), end_time: cutoff,
    exclude: "retweets,replies", expansions: "author_id", "user.fields": "protected",
    "tweet.fields": X_POST_FIELDS,
  }).toString();
  const page = await readXPage(url, xAuthorization(url, account), 100);
  observe?.(null, page.native, page.missingVisibility);
  return { status: "ok", classifier: X_STANCE_METHOD, textMethod: X_POST_TEXT_METHOD, read: page.read, truncated: page.next !== null,
    ...summarizeX(page.posts, cutoff, page.read, page.rejectedTextAuthors.size, page.missingVisibility) };
}

async function readXPage(url: URL, authorization: string, limit: number) {
  const body = object(JSON.parse(await fetchText(url, { Authorization: authorization })));
  const meta = object(body.meta);
  const rows = body.data ?? [];
  if (!Array.isArray(rows) || rows.length > limit || meta.result_count !== rows.length)
    throw new Error("Invalid X page");
  const users = body.includes === undefined ? [] : object(body.includes).users;
  if (!Array.isArray(users)) throw new Error("Invalid X author metadata");
  const visibility = new Map<string, boolean>();
  for (const user of users.map(object)) {
    if (!isId(user.id) || typeof user.protected !== "boolean") continue;
    if (visibility.has(user.id) && visibility.get(user.id) !== user.protected) throw new Error("Conflicting X author visibility");
    visibility.set(user.id, user.protected);
  }
  let missingVisibility = false;
  const rejectedTextAuthors = new Set<string>();
  const from = Date.parse(url.searchParams.get("start_time")!), through = Date.parse(url.searchParams.get("end_time")!);
  const posts = rows.map(object).flatMap(row => {
    if (!isId(row.author_id) || row.lang !== "en" ||
        row.referenced_tweets !== undefined || row.withheld !== undefined || typeof row.created_at !== "string") return [];
    const at = Date.parse(row.created_at);
    if (!(at > from && at <= through)) return [];
    if (!visibility.has(row.author_id)) { missingVisibility = true; return []; }
    if (visibility.get(row.author_id)) return [];
    const text = xPostText(row);
    if (text === null) { rejectedTextAuthors.add(row.author_id); return []; }
    return [{ author: row.author_id, at, text }];
  });
  const next = typeof meta.next_token === "string" && meta.next_token.length <= 2048 ? meta.next_token : null;
  return { posts, read: rows.length, next, rejectedTextAuthors, missingVisibility, native: body };
}

export async function collectXPublic(input: unknown, cutoff: string, observe?: NativeAnnotationCapture["observe"]) {
  const { bearerToken } = object(input);
  if (!isCredential(bearerToken)) throw new Error("Invalid X public-search configuration");
  const authorization = "Bearer " + bearerToken;
  const start = new Date(Date.parse(cutoff) - dayMs).toISOString();
  const posts: Post[] = [];
  const rejectedTextAuthors = new Set<string>();
  let missingVisibility = false;
  const queries = [];
  for (const [instrument, terms] of Object.entries(xSearchQueries)) {
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.search = new URLSearchParams({
      query: terms + " lang:en -is:retweet -is:reply -is:quote",
      max_results: String(xSearchPageSize), start_time: start, end_time: cutoff,
      expansions: "author_id", "user.fields": "protected",
      "tweet.fields": X_POST_FIELDS,
    }).toString();
    let next: string | null = null;
    let read = 0;
    let pages = 0;
    let failed = false;
    for (let index = 0; index < xSearchPagesPerInstrument; index++) {
      if (next) url.searchParams.set("next_token", next);
      try {
        const page = await readXPage(url, authorization, xSearchPageSize);
        observe?.(instrument as Instrument, page.native, page.missingVisibility);
        posts.push(...page.posts);
        missingVisibility ||= page.missingVisibility;
        for (const author of page.rejectedTextAuthors) rejectedTextAuthors.add(author);
        read += page.read;
        pages++;
        next = page.next;
      } catch (error) {
        if (error instanceof Error && /^Source HTTP (401|402|403|429)$/.test(error.message)) throw error;
        failed = true;
        break;
      }
      if (!next) break;
      // Only participant coverage controls pagination. Interpret each selected post in the final digest.
      const participants = new Set(posts.filter(post => marketInstruments(post.text, "x").some(symbol => symbol === instrument))
        .map(post => post.author));
      if (participants.size >= MINIMUM_PARTICIPANTS) break;
    }
    queries.push({ instrument, read, pages, failed, truncated: next !== null });
  }
  const failedQueries = queries.filter(query => query.failed).length;
  const read = queries.reduce((total, query) => total + query.read, 0);
  return { mode: "public_search", classifier: X_STANCE_METHOD, textMethod: X_POST_TEXT_METHOD,
    status: failedQueries === queries.length ? "unavailable" : failedQueries ? "partial" : "ok",
    read, queries, ...summarizeX(posts, cutoff, read, rejectedTextAuthors.size, missingVisibility || failedQueries > 0) };
}

export async function collectInstagram(input: unknown, cutoff: string, capture?: NativeAnnotationCapture) {
  const config = object(input);
  if (!isId(config.accountId) || !isCredential(config.token) || typeof config.graphVersion !== "string" ||
      !/^v\d{1,2}\.0$/.test(config.graphVersion) || !Array.isArray(config.handles) ||
      !config.handles.length || config.handles.length > 20 ||
      !config.handles.every(handle => typeof handle === "string" && /^[a-z0-9._]{1,30}$/.test(handle)) ||
      new Set(config.handles).size !== config.handles.length)
    throw new Error("Invalid Instagram Business Discovery configuration");
  const account = config as InstagramAccount;
  const posts: Post[] = [];
  let unavailableAccounts = 0;
  let truncated = false;
  for (const handle of account.handles) {
    try {
      const url = new URL("https://graph.facebook.com/" + account.graphVersion + "/" + account.accountId);
      const annotate = capture?.acceptsInstagramHandle?.(handle) ? capture.observe : undefined;
      const fields = annotate ? "id,caption,timestamp" : "caption,timestamp";
      url.searchParams.set("fields", "business_discovery.username(" + handle + "){id,username,media.limit(10){" + fields + "}}");
      const body = object(JSON.parse(await fetchText(url, { Authorization: "Bearer " + account.token })));
      const profile = object(body.business_discovery);
      if (!isId(profile.id) || profile.username !== handle) throw new Error("Unexpected Instagram account");
      const media = object(profile.media);
      if (!Array.isArray(media.data) || media.data.length > 10) throw new Error("Invalid Instagram media page");
      annotate?.(null, { requestedUsername: handle, business_discovery: profile });
      truncated ||= media.paging !== undefined && typeof object(media.paging).next === "string";
      for (const row of media.data.map(object)) {
        const text = instagramCaptionText(row.caption);
        if (text !== null && typeof row.timestamp === "string") {
          posts.push({ author: profile.id, at: Date.parse(row.timestamp), text });
        }
      }
    } catch { unavailableAccounts++; }
  }
  return { status: unavailableAccounts === account.handles.length ? "unavailable" : unavailableAccounts ? "partial" : "ok",
    accounts: account.handles.length, unavailableAccounts, truncated, readings: summarize(posts, cutoff) };
}

function summarize(posts: Post[], cutoff: string, source?: "x", reasons?: Record<XAbstentionReason, number>) {
  const end = Date.parse(cutoff);
  const latest = new Map<Instrument, Map<string, LanguageCue>>(INSTRUMENTS.map(symbol => [symbol, new Map()]));
  for (const post of posts.filter(post => post.at <= end && post.at > end - dayMs)
    .sort((a, b) => b.at - a.at)) {
    const interpretation = source === "x" ? xStanceAnalysis(post.text) : null;
    const cues = interpretation?.cues ?? marketStances(post.text);
    for (const symbol of marketInstruments(post.text, source)) {
      const authors = latest.get(symbol)!;
      if (authors.has(post.author)) continue;
      authors.set(post.author, cues[symbol] ?? "unclassified");
      if (reasons && symbol === "MARKET" && interpretation?.abstentionReason) reasons[interpretation.abstentionReason]++;
    }
  }
  return [...latest].map(([instrument, authors]) => {
    const counts = { upward: 0, downward: 0, mixed: 0, unclassified: 0 };
    for (const cue of authors.values()) counts[cue]++;
    return { instrument, participants: authors.size, counts: authors.size >= MINIMUM_PARTICIPANTS ? counts : null };
  });
}

function summarizeX(posts: Post[], cutoff: string, read: number, rejectedTextAuthors: number, failed: boolean) {
  const reasons = { guardedContext: 0, noSingleSubject: 0, noAttachedDirection: 0 };
  const readings = summarize(posts, cutoff, "x", reasons);
  const market = readings.find(row => row.instrument === "MARKET")!;
  let state: string;
  if (!market.participants && failed) state = "incomplete_source";
  else if (!read) state = "empty_sample";
  else if (!market.participants && rejectedTextAuthors >= MINIMUM_PARTICIPANTS) state = "unusable_text_observed";
  else if (!market.participants) state = "no_eligible_market_participants";
  else if (!market.counts) state = "below_participant_minimum";
  else state = market.counts.unclassified === market.participants ? "all_unclassified" : "explicit_cues_observed";
  // Suppress the entire partition when a small nonzero cell could be recovered by subtraction.
  const showReasons = (market.counts?.unclassified ?? 0) >= MINIMUM_PARTICIPANTS &&
    Object.values(reasons).every(count => count === 0 || count >= MINIMUM_PARTICIPANTS);
  return { readings, diagnostics: { state, marketAbstentionReasons: showReasons ? reasons : null } };
}

async function platform<T extends { status: string }>(input: unknown, collect: (input: unknown, cutoff: string) => Promise<T>, cutoff: string) {
  if (input === undefined) return { status: "not_configured" };
  try { return await collect(input, cutoff); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { status: "unavailable", detail: /^Source HTTP \d{3}$/.test(message) ? message : "Check the platform configuration and API access" };
  }
}

type TimedX = Record<string, unknown> & { status: string; cutoff?: string; expiresAt?: string };

function reusableX(text: string | null, cutoff: string, sameDay: boolean): TimedX | null {
  if (text === null) return null;
  let prior: Record<string, unknown>;
  // A damaged digest cannot supply a reading. The separate reservation still prevents another X request.
  try { prior = object(JSON.parse(text)); } catch { return null; }
  if (prior.schemaVersion !== 1 || !prior.x || typeof prior.x !== "object" || Array.isArray(prior.x)) return null;
  const x = prior.x as TimedX;
  if (!["ok", "partial", "unavailable"].includes(x.status)) return null;
  // Legacy reports stored the X capture clock only on the containing digest.
  const observed = x.cutoff ?? prior.cutoff;
  const expires = x.expiresAt ?? prior.expiresAt;
  if (typeof observed !== "string" || typeof expires !== "string") return null;
  const at = Date.parse(observed), end = Date.parse(expires), now = Date.parse(cutoff);
  if (!Number.isFinite(at) || !Number.isFinite(end) || new Date(at).toISOString() !== observed ||
      new Date(end).toISOString() !== expires || at > now || end <= now || end !== at + dayMs ||
      (sameDay && newYorkDate(observed) !== newYorkDate(cutoff))) return null;
  return { ...x, cutoff: observed, expiresAt: expires };
}

async function dailyX(folder: string, config: Record<string, unknown>, cutoff: string, freeOnly: boolean,
  observe?: NativeAnnotationCapture["observe"]): Promise<TimedX> {
  const publicSearch = config.xPublic !== undefined;
  const input = publicSearch ? config.xPublic : config.x;
  if (input === undefined) return { status: "not_configured" };
  if (!freeOnly) {
    // Claim the paid read before contacting X, including when the process crashes.
    const reservation = resolve(folder, "following-x-attempt-" + newYorkDate(cutoff));
    let acquired = false;
    try {
      await durableJSON(reservation, { cutoff }, true);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (acquired) {
      const reading = publicSearch ? await platform(input, (settings, at) => collectXPublic(settings, at, observe), cutoff) :
        await platform(input, (settings, at) => collectX(settings, at, observe), cutoff);
      return { ...reading, cutoff, expiresAt: new Date(Date.parse(cutoff) + dayMs).toISOString() };
    }
  }
  const prior = await privateText(resolve(folder, "following-digest.json"), 512_000);
  return reusableX(prior, cutoff, !freeOnly) ?? { status: freeOnly ? "skipped_free_only" : "already_attempted" };
}

async function collectNewsletters(cutoff: string) {
  return Promise.all(starterFeeds.map(async ([name, host]) => {
    const url = new URL("https://" + host + "/feed");
    try {
      const xml = await fetchText(url);
      if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw new Error("Expected RSS");
      const entries = rssItems(xml, name, host, cutoff)
        .filter(item => Date.parse(item.at) > Date.parse(cutoff) - 4 * dayMs)
        .map(({ title, url, at }) => ({ title, url, at }));
      return { name, feed: url.href, status: "ok", entries };
    } catch { return { name, feed: url.href, status: "unavailable", entries: [] }; }
  }));
}

export async function collectFollowingDigest(project: string, config: Record<string, unknown>, freeOnly = false,
  cutoff = new Date(Date.now() - 15_000).toISOString(), annotationStorage?: { folder: string; clock?: () => string }) {
  const folder = resolve(project, ".editorial");
  const output = resolve(folder, "following-digest.json");
  const release = await acquirePublicationLock(project, "following-digest", "following-digest.lock");
  let failure: { error: unknown } | undefined;
  try {
    const begin = async (source: "x" | "instagram"): Promise<NativeAnnotationCapture | undefined> => {
      if (!annotationStorage) return;
      try { return await startNativeAnnotationCapture(annotationStorage.folder, source, cutoff, annotationStorage.clock); }
      catch { return { finish: async () => "private_storage_unavailable" }; }
    };
    const [xCapture, igCapture] = await Promise.all([begin("x"), begin("instagram")]);
    const [x, instagram, newsletters] = await Promise.all([
      dailyX(folder, config, cutoff, freeOnly, xCapture?.observe),
      platform(config.instagram, (input, at) => collectInstagram(input, at, igCapture), cutoff),
      collectNewsletters(cutoff),
    ]);
    // Annotation cannot introduce a provider request or stop the independent daily digest.
    const finish = async (capture: NativeAnnotationCapture | undefined, complete: boolean) =>
      capture?.finish(complete).catch(() => "private_storage_unavailable");
    const [xAnnotation, igAnnotation] = await Promise.all([
      finish(xCapture, x.status === "ok"), finish(igCapture, instagram.status === "ok"),
    ]);
    const annotations = annotationStorage ? { x: xAnnotation, instagram: igAnnotation } : undefined;
    const freshExpiry = new Date(Date.parse(cutoff) + dayMs).toISOString();
    // Anyone reading the whole digest must stop using it when its oldest included read expires.
    const expiresAt = x.expiresAt && x.expiresAt < freshExpiry ? x.expiresAt : freshExpiry;
    const report = { schemaVersion: 1, cutoff, expiresAt,
      purpose: "Private editorial leads and social interpretation diagnostics. Check primary evidence before publication.",
      x, instagram, newsletters };
    await durableJSON(output, report);
    return { followingDigest: output, x: x.status, xCutoff: x.cutoff ?? null, instagram: instagram.status, ...(annotations && { annotations }),
      newsletters: newsletters.map(feed => ({ name: feed.name, status: feed.status, items: feed.entries.length })) };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some(arg => arg !== "--scheduled" && arg !== "--free-only"))
    throw new Error("Use --scheduled or --free-only when collecting the following digest");
  console.log(JSON.stringify(await collectFollowingDigest(root, await localConfig(), args.includes("--free-only"), undefined, { folder: nativeAnnotationFolder() })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error("Following feed collection failed. Check .editorial/following-config.json and the private output directory.");
    if (process.argv.includes("--scheduled")) console.log(JSON.stringify({ status: "unavailable" }));
    else process.exitCode = 1;
  }
}
