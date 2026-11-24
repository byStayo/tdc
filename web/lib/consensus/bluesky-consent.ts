import { createHash } from "node:crypto";
import { marketInstruments, privateIdentifier, type Exclusions } from "./bluesky.ts";
import { BLUESKY_CONSENT_SOURCE, isSocialClock, publicBlueskyPost, socialObject } from "./social-annotation-source.ts";

const appview = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const day = 86_400_000;
const etfs = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
type Etf = typeof etfs[number];
const uriPattern = /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[a-z0-9._:%-]+))\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~:-]+$/;
const cidPattern = /^bafyre[a-z2-7]{53}$/;
const nativeTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const grantPattern = /^For the original (SPY|QQQ|IWM|DIA|TLT) post I am replying to, I permit The Daily Consensus to collect and show it to independent reviewers for private blind annotation and evaluation, with local storage until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) and retention of private anonymized evaluation totals\.$/;

/* This error describes the current provider rows or existing opt-outs. The CLI
 * treats a transport failure separately from withdrawn or invalid consent. */
export class BlueskyConsentRefused extends Error {}

type Entry = { instrument: Etf; postUri: string; consentUri: string; did: string };
type Options = {
  exclusions: () => Promise<Exclusions>;
  collectedAt?: string;
  expectedManifestDigest?: string;
  clock?: () => string;
  fetcher?: typeof fetch;
};

function postDid(uri: unknown) {
  if (typeof uri !== "string" || uri.length > 160) return;
  const match = uriPattern.exec(uri);
  if (match?.[0] === uri) return match[1];
}

function manifestEntries(input: Record<string, unknown>, collectedAt: string) {
  const { from, through, entries } = input;
  if (input.schemaVersion !== 1 || Object.keys(input).length !== 4 || !isSocialClock(from) || !isSocialClock(through) ||
      from >= through || through > collectedAt || Date.parse(collectedAt) - Date.parse(from) > day ||
      !Array.isArray(entries) || entries.length < 1 || entries.length > 100)
    throw new Error("Expected a bounded Bluesky consent manifest");
  const seen = new Set<string>();
  const selected: Entry[] = entries.map(value => {
    const { instrument, postUri, consentUri } = socialObject(value);
    const did = postDid(postUri);
    if (Object.keys(value).length !== 3 || !etfs.includes(instrument as Etf) || !did ||
        typeof postUri !== "string" || typeof consentUri !== "string" || postDid(consentUri) !== did ||
        postUri === consentUri || seen.has(postUri) || seen.has(consentUri))
      throw new Error("Expected unique same-DID original and consent URIs");
    seen.add(postUri);
    seen.add(consentUri);
    return { instrument: instrument as Etf, postUri, consentUri, did };
  });
  return { from, through, selected };
}

function requirePermission(selected: Entry[], { actors, records }: Exclusions) {
  const blockedActors = new Set(actors), blockedRecords = new Set(records);
  for (const { did, postUri, consentUri } of selected) {
    if (blockedActors.has(privateIdentifier(did)) || blockedRecords.has(privateIdentifier(postUri)) ||
        blockedRecords.has(privateIdentifier(consentUri))) throw new BlueskyConsentRefused("Bluesky actor or post is excluded");
  }
}

async function readAppviewPage(uris: string[], fetcher: typeof fetch) {
  const url = new URL(appview);
  for (const uri of uris) url.searchParams.append("uris", uri);
  const response = await fetcher(url, { redirect: "error", credentials: "omit", cache: "no-store",
    headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok || !response.body) throw new Error("Bluesky AppView request failed");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 512_000) {
        await reader.cancel();
        throw new Error("Bluesky AppView response exceeded its limit");
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const page = socialObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))));
  if (!Array.isArray(page.posts)) throw new Error("Invalid Bluesky AppView response");
  const requested = new Set(uris);
  const posts = page.posts.map(socialObject);
  for (const row of posts) {
    if (typeof row.uri !== "string" || !requested.delete(row.uri)) throw new Error("Unexpected Bluesky AppView record");
  }
  if (requested.size) throw new BlueskyConsentRefused("An original post or consent reply is unavailable");
  return posts;
}

function checkedPost(row: Record<string, unknown>) {
  const view = publicBlueskyPost(row);
  if (!view || typeof row.cid !== "string" || row.cid.length !== 59 || !cidPattern.test(row.cid))
    throw new BlueskyConsentRefused("Bluesky source identity or visibility could not be verified");
  const { indexedAt } = row;
  if (typeof indexedAt !== "string" || !nativeTimestamp.test(indexedAt) || !nativeTimestamp.test(view.createdAt))
    throw new BlueskyConsentRefused("Invalid Bluesky source time");
  const created = Date.parse(view.createdAt), indexed = Date.parse(indexedAt);
  if (!Number.isFinite(created) || !Number.isFinite(indexed) || created > indexed)
    throw new BlueskyConsentRefused("Invalid Bluesky source time");
  return { ...view, cid: row.cid, created, indexed };
}

function matchingReference(value: unknown, uri: string, cid: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = socialObject(value);
  return reference.uri === uri && reference.cid === cid;
}

function verifyGrant(entry: Entry, originalRow: Record<string, unknown>, consentRow: Record<string, unknown>,
  from: string, through: string, collectedAt: string, now: string) {
  const original = checkedPost(originalRow), consent = checkedPost(consentRow);
  const match = grantPattern.exec(consent.text);
  const expiry = match?.[2].replace(/Z$/, ".000Z");
  if (original.did !== entry.did || consent.did !== entry.did || original.record.reply !== undefined ||
      (original.record.embed && String(socialObject(original.record.embed).$type).includes("record")) ||
      !marketInstruments(original.text).includes(entry.instrument) || original.created < Date.parse(from) ||
      original.indexed >= Date.parse(through))
    throw new BlueskyConsentRefused("Bluesky original is outside the verified sample");
  if (consent.created < original.created || consent.indexed < original.indexed || consent.indexed > Date.parse(collectedAt) ||
      !match || match[0] !== consent.text || match[1] !== entry.instrument ||
      consent.record.embed !== undefined || !isSocialClock(expiry) || expiry <= now || Date.parse(expiry) - consent.created > day)
    throw new BlueskyConsentRefused("Bluesky consent does not match the authorized scope");
  const reply = consent.record.reply;
  if (!reply || typeof reply !== "object" || Array.isArray(reply))
    throw new BlueskyConsentRefused("Consent must directly reply to the original post");
  const { root, parent } = socialObject(reply);
  if (!matchingReference(root, original.uri, original.cid) || !matchingReference(parent, original.uri, original.cid))
    throw new BlueskyConsentRefused("Consent does not bind the current original post");
  return { expiry, identity: [entry.instrument, original.uri, original.cid, original.created, original.indexed, original.text,
    consent.uri, consent.cid, consent.created, consent.indexed, consent.text] };
}

/** Every live call starts from the explicitly selected URI pairs. Responses stay in memory. */
export async function collectBlueskyConsent(input: unknown, options: Options) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const started = clock(), collectedAt = options.collectedAt ?? started;
  if (!isSocialClock(started) || !isSocialClock(collectedAt) || collectedAt > started ||
      Date.parse(started) - Date.parse(collectedAt) >= day) throw new Error("Invalid Bluesky collection time");
  const { from, through, selected } = manifestEntries(socialObject(input), collectedAt);
  const consentManifestDigest = createHash("sha256").update(JSON.stringify([from, through,
    selected.map(entry => JSON.stringify([entry.instrument, entry.postUri, entry.consentUri])).sort()])).digest("hex");
  if (options.expectedManifestDigest !== undefined && options.expectedManifestDigest !== consentManifestDigest)
    throw new Error("Bluesky consent manifest differs from the prepared packet");
  requirePermission(selected, await options.exclusions());
  const uris = selected.flatMap(entry => [entry.postUri, entry.consentUri]);
  const rows = new Map<string, Record<string, unknown>>();
  const fetcher = options.fetcher ?? fetch;
  for (let offset = 0; offset < uris.length; offset += 25) {
    for (const row of await readAppviewPage(uris.slice(offset, offset + 25), fetcher)) rows.set(row.uri as string, row);
  }
  const exclusions = await options.exclusions();
  requirePermission(selected, exclusions);
  const checkedAt = clock();
  if (!isSocialClock(checkedAt) || checkedAt < started) throw new Error("Invalid Bluesky verification time");
  const grants = selected.map(entry => verifyGrant(entry, rows.get(entry.postUri)!, rows.get(entry.consentUri)!,
    from, through, collectedAt, checkedAt));
  const expiresAt = grants.map(grant => grant.expiry).sort()[0];
  const consentDigest = createHash("sha256").update(JSON.stringify([BLUESKY_CONSENT_SOURCE, from, through, collectedAt,
    expiresAt, grants.map(grant => JSON.stringify(grant.identity)).sort()])).digest("hex");
  const batches = selected.map(({ instrument, postUri }) => ({ instrument, page: { posts: [rows.get(postUri)!] } }));
  return { approvedPosts: grants.length, exclusions, consentDigest, consentManifestDigest,
    native: { schemaVersion: 1, source: BLUESKY_CONSENT_SOURCE, from, through, collectedAt, expiresAt, batches } };
}
