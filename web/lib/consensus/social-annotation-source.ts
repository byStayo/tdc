import { createHmac, randomBytes } from "node:crypto";
import { privateIdentifier, type Exclusions } from "./bluesky.ts";
import { INSTRUMENTS, type Instrument } from "./types.ts";
import { instagramCaptionText } from "./instagram-post-text.ts";
import { xDisplayText, xPostText } from "./x-post-text.ts";

const day = 86_400_000;
export const BLUESKY_CONSENT_SOURCE = "bluesky-consent-appview";
const sources = ["x-v2", "instagram-business-discovery", "bluesky-appview", BLUESKY_CONSENT_SOURCE, "white-house-twitter-v1"] as const;
type Source = typeof sources[number];
type Platform = "x" | "instagram" | "bluesky";
type Original = { author: string; post: string; at: number; text: string };
export type SocialAnnotation = { ref: string; platform: Platform; instrument: Instrument; text: string; expected: string | null };

export function socialTextKey(platform: Platform, original: string): string {
  const text = platform === "x" ? xDisplayText(original) : original;
  return text.trim().replace(/\s+/g, " ");
}

export function socialObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a source object");
  return value as Record<string, unknown>;
}

export function isSocialClock(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

const numericId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,24}$/.test(value);
const list = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error("Expected native records");
  return value.map(socialObject);
};

function xOriginals(page: Record<string, unknown>, observed: Map<string, boolean>): Original[] {
  const data = list(page.data ?? []);
  if (page.meta !== undefined && socialObject(page.meta).result_count !== data.length) throw new Error("Incomplete native X results");
  const visibility = new Map<string, boolean>();
  for (const user of list(page.includes === undefined ? [] : socialObject(page.includes).users)) {
    if (!numericId(user.id) || typeof user.protected !== "boolean") continue;
    if (observed.has(user.id) && observed.get(user.id) !== user.protected) throw new Error("Conflicting native visibility");
    observed.set(user.id, user.protected);
    visibility.set(user.id, user.protected);
  }
  return data.flatMap(row => {
    if (!numericId(row.id) || !numericId(row.author_id) || visibility.get(row.author_id) !== false ||
        row.lang !== "en" || row.referenced_tweets !== undefined || row.withheld !== undefined || typeof row.created_at !== "string") return [];
    const text = xPostText(row);
    return text === null ? [] : [{ author: row.author_id, post: row.id, at: Date.parse(row.created_at), text }];
  });
}

function instagramOriginals(page: Record<string, unknown>): Original[] {
  const profile = socialObject(page.business_discovery);
  if (!numericId(profile.id) || typeof profile.username !== "string" || page.requestedUsername !== profile.username ||
      !/^[a-z0-9._]{1,30}$/.test(profile.username)) throw new Error("Unverified native Instagram account");
  const author = profile.id;
  return list(socialObject(profile.media).data).flatMap(row => {
    if (!numericId(row.id) || typeof row.caption !== "string" || instagramCaptionText(row.caption) === null ||
        typeof row.timestamp !== "string") return [];
    return [{ author, post: row.id, at: Date.parse(row.timestamp), text: row.caption }];
  });
}

export function publicBlueskyPost(row: Record<string, unknown>) {
  const profile = socialObject(row.author), record = socialObject(row.record);
  const did = profile.did;
  const viewer = profile.viewer === undefined ? {} : socialObject(profile.viewer);
  if (viewer.blocking || viewer.blockedBy || (profile.labels !== undefined &&
      (!Array.isArray(profile.labels) || profile.labels.length))) return null;
  if (typeof did !== "string" || !/^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9._:%-]+)$/.test(did) ||
      typeof row.uri !== "string" || !row.uri.startsWith("at://" + did + "/app.bsky.feed.post/") ||
      !/^[a-zA-Z0-9._~:-]{1,512}$/.test(row.uri.slice(("at://" + did + "/app.bsky.feed.post/").length)) ||
      record.$type !== "app.bsky.feed.post" || typeof record.text !== "string" || !record.text.trim() ||
      record.text.length > 3000 || typeof record.createdAt !== "string" || !Array.isArray(record.langs) ||
      !record.langs.includes("en") || (row.labels !== undefined && (!Array.isArray(row.labels) || row.labels.length)) ||
      record.labels !== undefined) return null;
  return { did, uri: row.uri, record, text: record.text, createdAt: record.createdAt };
}

function blueskyOriginals(page: Record<string, unknown>): Original[] {
  return list(page.posts).flatMap(row => {
    const post = publicBlueskyPost(row);
    if (!post || post.record.reply ||
        (post.record.embed && String(socialObject(post.record.embed).$type).includes("record"))) return [];
    return [{ author: post.did, post: post.uri, at: Date.parse(post.createdAt), text: post.text }];
  });
}

// The three downloads were independently checked against the original White House archive designation.
const federalZipHashes = new Map([
  ["WhiteHouse111716.zip", "588c15d11a1f382f76578b66584a648283980dae11666891d9aa932b6f101758"],
  ["POTUS111716.zip", "d40d86e476a7a513b7d49f5459d30ffa1b2df21272c0ca6ea9be73520f1a0416"],
  ["FLOTUS111716.zip", "ad53a58e17cb43fc815fe4c5bfc44a74ed72b6db0ce77a597e3acb07dfad7d8d"],
].map(([name, hash]) => ["https://obamawhitehouse.archives.gov/sites/default/files/" + name, hash]));

/** Native institutional Twitter v1 originals are checked against the issuer account manifest. */
function federalOriginals(page: Record<string, unknown>): Original[] {
  if (typeof page.archiveUrl !== "string" || typeof page.archiveSha256 !== "string" ||
      federalZipHashes.get(page.archiveUrl) !== page.archiveSha256) throw new Error("Unexpected federal archive source");
  const owner = socialObject(page.user_details).id;
  if (!numericId(owner)) throw new Error("Missing native archive account");
  return list(page.tweets).flatMap(row => {
    const user = socialObject(row.user);
    if (!numericId(row.id_str) || user.id_str !== owner || user.protected !== false ||
        row.retweeted_status || row.in_reply_to_status_id_str || row.in_reply_to_status_id || row.quoted_status_id_str ||
        row.quoted_status_id || row.truncated === true || row.withheld_in_countries ||
        typeof row.text !== "string" || !row.text.trim() || row.text.length > 12_000 || /^(?:RT|MT)\s+@/i.test(row.text) ||
        typeof row.created_at !== "string") return [];
    // Each approved institutional ZIP represents one contributor, even if a malformed export claims another account.
    return [{ author: page.archiveUrl as string, post: row.id_str, at: Date.parse(row.created_at), text: row.text }];
  });
}

/** The caller supplies independently acquired, permitted native pages on stdin, separately from the blind labels. */
export function socialAnnotationTemplate(input: unknown, now: string, nonce = randomBytes(16).toString("hex"), exclusions?: Exclusions) {
  const sample = socialObject(input);
  const { source, from, through, collectedAt, expiresAt } = sample;
  if (sample.schemaVersion !== 1 || !sources.includes(source as Source) || !isSocialClock(now) ||
      !isSocialClock(from) || !isSocialClock(through) || !isSocialClock(collectedAt) || !isSocialClock(expiresAt) ||
      from >= through || through > collectedAt || collectedAt > now || expiresAt <= now ||
      Date.parse(expiresAt) - Date.parse(collectedAt) > day || !/^[0-9a-f]{32}$/.test(nonce))
    throw new Error("Expected a current, time-bounded native source");
  const blueskySource = source === "bluesky-appview" || source === BLUESKY_CONSENT_SOURCE;
  const platform: Platform = source === "instagram-business-discovery" ? "instagram" : blueskySource ? "bluesky" : "x";
  const observedVisibility = new Map<string, boolean>();
  const decode = source === "x-v2" ? (page: Record<string, unknown>) => xOriginals(page, observedVisibility) :
    source === "instagram-business-discovery" ? instagramOriginals :
    blueskySource ? blueskyOriginals : federalOriginals;
  const excludedActors = new Set(exclusions?.actors), excludedPosts = new Set(exclusions?.records);
  const originals = new Map<string, Original>();
  const chosen = new Map<Instrument, Map<string, Original>>();
  for (const entry of list(sample.batches)) {
    const subject = entry.instrument as Instrument;
    if (!INSTRUMENTS.includes(subject)) throw new Error("Unknown independently sampled instrument");
    const byAuthor = chosen.get(subject) ?? new Map<string, Original>();
    chosen.set(subject, byAuthor);
    for (const post of decode(socialObject(entry.page))) {
      if (!(post.at >= Date.parse(from) && post.at < Date.parse(through))) continue;
      if (platform === "bluesky" && (excludedActors.has(privateIdentifier(post.author)) ||
          excludedPosts.has(privateIdentifier(post.post)))) continue;
      const prior = originals.get(post.post);
      if (prior && (prior.author !== post.author || prior.at !== post.at || prior.text !== post.text))
        throw new Error("Conflicting native post identity");
      originals.set(post.post, post);
      const selected = byAuthor.get(post.author);
      if (!selected || post.at > selected.at || (post.at === selected.at && post.post > selected.post)) byAuthor.set(post.author, post);
    }
  }
  if (!chosen.size) throw new Error("Missing native sampling groups");
  const items: SocialAnnotation[] = [];
  const groups = [...chosen.keys()].sort().map(instrument => platform + "/" + instrument);
  for (const [instrument, authors] of chosen) {
    const textCounts = new Map<string, number>();
    const normalized = (text: string) => socialTextKey(platform, text);
    for (const { text } of authors.values()) textCounts.set(normalized(text), (textCounts.get(normalized(text)) ?? 0) + 1);
    for (const { author, post, at, text } of authors.values()) {
      // Syndicated text does not provide independent language. Discard every ambiguous copy.
      if (textCounts.get(normalized(text)) !== 1) continue;
      const ref = createHmac("sha256", Buffer.from(nonce, "hex"))
        .update(JSON.stringify([source, instrument, author, post, at, text])).digest("hex");
      items.push({ ref, instrument, platform, text, expected: null });
    }
  }
  items.sort((a, b) => a.ref.localeCompare(b.ref));
  return { schemaVersion: 2, source: source as Source, from, through, collectedAt, expiresAt, nonce, groups, items };
}
