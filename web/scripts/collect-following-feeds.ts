import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marketInstruments, marketStances, MINIMUM_PARTICIPANTS, type LanguageCue } from "../lib/consensus/bluesky.ts";
import { rssItems } from "../lib/consensus/collector.ts";
import { sourceChunk, sourceResponse } from "../lib/consensus/source-failure.ts";
import { INSTRUMENTS, type Instrument } from "../lib/consensus/types.ts";
import { newYorkDate } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".editorial");
const starterFeeds = [
  ["TKer", "www.tker.co"],
  ["Apricitas Economics", "www.apricitas.io"],
] as const;
const dayMs = 86_400_000;

type Post = { author: string; at: number; text: string };
type XAccount = { userId: string; apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };
type InstagramAccount = { graphVersion: string; accountId: string; token: string; handles: string[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected object shape");
  return value as Record<string, unknown>;
}

async function localConfig() {
  let file;
  try {
    file = await open(resolve(directory, "following-config.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192)
      throw new Error("Following config must be an owner-only 0600 file under .editorial");
    const buffer = Buffer.alloc(8193);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8192) throw new Error("Following config exceeds 8 KiB");
    return object(JSON.parse(buffer.subarray(0, length).toString("utf8")));
  } finally {
    await file.close();
  }
}

async function fetchText(url: URL, headers: Record<string, string> = {}) {
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

export async function collectX(input: unknown, cutoff: string) {
  const config = object(input);
  if (!isId(config.userId) || ![config.apiKey, config.apiSecret, config.accessToken, config.accessSecret].every(isCredential))
    throw new Error("Invalid X OAuth 1.0a configuration");
  const account = config as XAccount;
  const url = new URL("https://api.x.com/2/users/" + account.userId + "/timelines/reverse_chronological");
  url.search = new URLSearchParams({
    max_results: "100", start_time: new Date(Date.parse(cutoff) - dayMs).toISOString(), end_time: cutoff,
    exclude: "retweets,replies", expansions: "author_id", "user.fields": "protected",
    "tweet.fields": "author_id,created_at,lang,referenced_tweets,withheld",
  }).toString();
  const body = object(JSON.parse(await fetchText(url, { Authorization: xAuthorization(url, account) })));
  const meta = object(body.meta);
  const rows = body.data ?? [];
  if (!Array.isArray(rows) || rows.length > 100 || meta.result_count !== rows.length)
    throw new Error("Invalid X timeline page");
  const users = body.includes === undefined ? [] : object(body.includes).users;
  if (!Array.isArray(users)) throw new Error("Invalid X author metadata");
  const publicUsers = new Set(users.map(object).filter(user => isId(user.id) && user.protected === false).map(user => user.id));
  const posts = rows.map(object).flatMap(row =>
    isId(row.author_id) && publicUsers.has(row.author_id) && row.lang === "en" &&
      row.referenced_tweets === undefined && row.withheld === undefined &&
      typeof row.text === "string" && typeof row.created_at === "string"
      ? [{ author: row.author_id, at: Date.parse(row.created_at), text: row.text }] : []);
  return { status: "ok", read: rows.length, truncated: typeof meta.next_token === "string", readings: summarize(posts, cutoff) };
}

export async function collectInstagram(input: unknown, cutoff: string) {
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
      url.searchParams.set("fields", "business_discovery.username(" + handle + "){id,username,media.limit(10){caption,timestamp}}");
      const body = object(JSON.parse(await fetchText(url, { Authorization: "Bearer " + account.token })));
      const profile = object(body.business_discovery);
      if (!isId(profile.id) || profile.username !== handle) throw new Error("Unexpected Instagram account");
      const media = object(profile.media);
      if (!Array.isArray(media.data) || media.data.length > 10) throw new Error("Invalid Instagram media page");
      truncated ||= media.paging !== undefined && typeof object(media.paging).next === "string";
      for (const row of media.data.map(object)) {
        if (typeof row.caption === "string" && typeof row.timestamp === "string")
          posts.push({ author: profile.id, at: Date.parse(row.timestamp),
            text: row.caption.replace(/(^|\s)#(SPY|QQQ|IWM|DIA|TLT)\b/gi, (_match, space, symbol) => space + "$" + symbol) });
      }
    } catch { unavailableAccounts++; }
  }
  return { status: unavailableAccounts === account.handles.length ? "unavailable" : unavailableAccounts ? "partial" : "ok",
    accounts: account.handles.length, unavailableAccounts, truncated, readings: summarize(posts, cutoff) };
}

function summarize(posts: Post[], cutoff: string) {
  const end = Date.parse(cutoff);
  const latest = new Map<Instrument, Map<string, LanguageCue>>(INSTRUMENTS.map(symbol => [symbol, new Map()]));
  for (const post of posts.filter(post => post.at <= end && post.at > end - dayMs && post.text.length <= 12_000)
    .sort((a, b) => b.at - a.at)) {
    const cues = marketStances(post.text);
    for (const symbol of marketInstruments(post.text)) {
      const authors = latest.get(symbol)!;
      if (!authors.has(post.author)) authors.set(post.author, cues[symbol] ?? "unclassified");
    }
  }
  return [...latest].map(([instrument, authors]) => {
    const counts = { upward: 0, downward: 0, mixed: 0, unclassified: 0 };
    for (const cue of authors.values()) counts[cue]++;
    return { instrument, participants: authors.size, counts: authors.size >= MINIMUM_PARTICIPANTS ? counts : null };
  });
}

async function platform<T extends { status: string }>(input: unknown, collect: (input: unknown, cutoff: string) => Promise<T>, cutoff: string) {
  if (input === undefined) return { status: "not_configured" };
  try { return await collect(input, cutoff); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { status: "unavailable", detail: /^Source HTTP \d{3}$/.test(message) ? message : "Check the platform configuration and API access" };
  }
}

async function main() {
  const cutoff = new Date(Date.now() - 15_000).toISOString();
  const config = await localConfig();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = resolve(directory, "following-digest.json");
  if (config.x !== undefined) {
    // Reserve one billable page per local calendar day, even across process restarts.
    const day = newYorkDate(cutoff);
    try {
      await writeFile(resolve(directory, "following-x-attempt-" + day), cutoff + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      console.log(JSON.stringify({ x: "already_attempted", day, previousDigest: output }));
      return;
    }
  }
  const [x, instagram, newsletters] = await Promise.all([
    platform(config.x, collectX, cutoff), platform(config.instagram, collectInstagram, cutoff),
    Promise.all(starterFeeds.map(async ([name, host]) => {
      const url = new URL("https://" + host + "/feed");
      try {
        const xml = await fetchText(url);
        if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw new Error("Expected RSS");
        const entries = rssItems(xml, name, host, cutoff)
          .filter(item => Date.parse(item.at) > Date.parse(cutoff) - 4 * dayMs)
          .map(({ title, url, at }) => ({ title, url, at }));
        return { name, feed: url.href, status: "ok", entries };
      } catch { return { name, feed: url.href, status: "unavailable", entries: [] }; }
    })),
  ]);
  const report = { schemaVersion: 1, cutoff, expiresAt: new Date(Date.parse(cutoff) + dayMs).toISOString(),
    purpose: "Private editorial leads and social interpretation diagnostics. Check primary evidence before publication.",
    x, instagram, newsletters };
  const temporary = resolve(directory, ".following-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  console.log(JSON.stringify({ followingDigest: output, x: x.status, instagram: instagram.status,
    newsletters: newsletters.map(feed => ({ name: feed.name, status: feed.status, items: feed.entries.length })) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error("Following feed collection failed. Check .editorial/following-config.json and the private output directory.");
    if (!process.argv.includes("--scheduled")) process.exitCode = 1;
  }
}
