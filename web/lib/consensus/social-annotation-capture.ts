import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../publication-lock.ts";
import { durableJSON, syncDirectory } from "../publication-storage.ts";
import { marketInstruments, privateIdentifier } from "./bluesky.ts";
import { instagramCaptionText } from "./instagram-post-text.ts";
import { isSocialClock, socialAnnotationTemplate, socialObject } from "./social-annotation-source.ts";
import { INSTRUMENTS, type Instrument } from "./types.ts";
import { xPostText } from "./x-post-text.ts";

type Platform = "x" | "instagram";
type Template = ReturnType<typeof socialAnnotationTemplate>;
type Proof = {
  version: 1; platform: Platform; grant: string; secret: string;
  sourcePages: { route: string; instrument: Instrument | null; observedAt: string; canonicalPageMac: string }[];
  sample: Omit<Template, "items">; rows: { ref: string; platform: Platform; instrument: Instrument; content: string }[];
};
type Grant = { digest: string; expiresAt: string; allowed: Set<string>; instagram: Map<string, string>; authors: Set<string>; posts: Set<string> };
type Sink = (instrument: Instrument | null, page: Record<string, unknown>, incomplete?: boolean) => void;
export type NativeAnnotationCapture = {
  observe?: Sink; acceptsInstagramHandle?: (username: string) => boolean; finish: (complete: boolean) => Promise<string>;
};
const day = 86_400_000;
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const nativeAnnotationFolder = () => resolve(homedir(), ".local/share/daily-consensus/social-annotation");
const inactive = (status: string): NativeAnnotationCapture => ({ finish: async () => status });
const content = (secret: string, ref: string, text: string) => createHmac("sha256", Buffer.from(secret, "hex"))
  .update(JSON.stringify([ref, text])).digest("hex");

async function privateFolder(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
      throw new Error("Invalid native annotation directory");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function privateInput(path: string, bound: number) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 1 || stat.size > bound) throw new Error("Invalid native annotation file");
    const buffer = Buffer.alloc(bound + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > bound) throw new Error("Oversized native annotation file");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

async function permission(folder: string, platform: Platform, now: string): Promise<Grant | null> {
  const original = await privateInput(resolve(folder, "permission.json"), 64_000);
  if (!original) return null;
  const grant = socialObject(JSON.parse(original.toString()));
  const { activatedAt, expiresAt, evidenceSha256, approvedAccountHashes, excludedAccountHashes, excludedPostHashes } = grant;
  if (grant.version !== 1 || grant.platform !== platform || grant.scope !== "private-independent-language-annotation" ||
      grant.ownerActivated !== true || grant.privateTextFor24h !== true || grant.privateAggregateEvaluation !== true ||
      !isSocialClock(activatedAt) || !isSocialClock(expiresAt) || activatedAt > now || now >= expiresAt || !hex(evidenceSha256) ||
      ![approvedAccountHashes, excludedAccountHashes, excludedPostHashes].every(a => Array.isArray(a) && a.length <= 250 && a.every(hex)))
    return null;
  const allow = new Set(approvedAccountHashes as string[]);
  const instagram = new Map<string, string>();
  if (platform === "instagram") {
    if (!allow.size || !Array.isArray(grant.instagramAccountBindings) || grant.instagramAccountBindings.length !== allow.size) return null;
    for (const binding of grant.instagramAccountBindings.map(socialObject)) {
      if (!hex(binding.handleHash) || !hex(binding.accountHash) || !allow.has(binding.accountHash) || instagram.has(binding.handleHash)) return null;
      instagram.set(binding.handleHash, binding.accountHash);
    }
    if (new Set(instagram.values()).size !== allow.size) return null;
  }
  const evidence = await privateInput(resolve(folder, "permission-evidence.bin"), 512_000);
  if (!evidence || digest(evidence) !== evidenceSha256) return null;
  const hash = digest(original);
  const withdrawn = await privateInput(resolve(folder, "withdrawn.json"), 8192);
  if (withdrawn && socialObject(JSON.parse(withdrawn.toString())).grant === hash) return null;
  return { digest: hash, expiresAt, allowed: allow, instagram, authors: new Set(excludedAccountHashes as string[]),
    posts: new Set(excludedPostHashes as string[]) };
}

async function underStorageLock<T>(folder: string, operation: () => Promise<T>) {
  const release = await acquirePublicationLock(folder, "social-annotation");
  let failure: { error: unknown } | undefined;
  try { return await operation(); }
  catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}

async function purge(folder: string) {
  // Include only our own interrupted atomic writes. An unclean host exit can leave private text in a temporary file.
  const files = (await readdir(folder)).filter(name => /^(?:packet|receipt)\.json(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name));
  for (const name of files) await unlink(resolve(folder, name));
  if (files.length) await syncDirectory(folder);
}

async function ownedArea(root: string, platform: Platform) {
  if (!(["x", "instagram"] as const).includes(platform)) throw new Error("Unknown native annotation platform");
  const folder = resolve(root, platform);
  if (!await privateFolder(root) || !await privateFolder(folder)) return null;
  const actualRoot = await realpath(root);
  const checkout = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
  if (!relative(checkout, actualRoot).startsWith(".." + sep) ||
      (resolve(root) === nativeAnnotationFolder() && actualRoot !== resolve(await realpath(homedir()), ".local/share/daily-consensus/social-annotation")))
    throw new Error("Native annotation storage must remain private and outside the checkout");
  return resolve(actualRoot, platform);
}

const searchRoute = "api.x.com/2/tweets/search/recent";
const followingRoute = "api.x.com/2/users/:id/timelines/reverse_chronological";
const instagramRoute = "graph.facebook.com/business_discovery";

function current(proof: Proof, platform: Platform, grant: Grant | null, now: string) {
  if (!isSocialClock(now) || !grant || proof.version !== 1 || proof.platform !== platform || proof.grant !== grant.digest || !hex(proof.secret) ||
      proof.sample?.schemaVersion !== 2 || proof.sample.source !== (platform === "x" ? "x-v2" : "instagram-business-discovery") ||
      typeof proof.sample.nonce !== "string" || !/^[0-9a-f]{32}$/.test(proof.sample.nonce) ||
      !isSocialClock(proof.sample.from) || !isSocialClock(proof.sample.through) || !isSocialClock(proof.sample.collectedAt) ||
      !isSocialClock(proof.sample.expiresAt) || Date.parse(proof.sample.through) - Date.parse(proof.sample.from) !== day ||
      proof.sample.through > proof.sample.collectedAt || proof.sample.collectedAt > now || now >= proof.sample.expiresAt ||
      proof.sample.expiresAt > grant.expiresAt || Date.parse(proof.sample.expiresAt) - Date.parse(proof.sample.collectedAt) > day ||
      !Array.isArray(proof.sourcePages) || !proof.sourcePages.length || proof.sourcePages.length > (platform === "x" ? 10 : 20)) return false;
  return proof.sourcePages.every(page => page && isSocialClock(page.observedAt) && proof.sample.through <= page.observedAt &&
    page.observedAt <= proof.sample.collectedAt && hex(page.canonicalPageMac) && (platform === "instagram"
      ? page.route === instagramRoute && page.instrument === null
      : page.instrument === null ? page.route === followingRoute : page.route === searchRoute && INSTRUMENTS.includes(page.instrument)));
}

async function receipt(folder: string) {
  const raw = await privateInput(resolve(folder, "receipt.json"), 160_000);
  return raw ? JSON.parse(raw.toString()) as Proof : null;
}

function allowed(grant: Grant, author: unknown, post: unknown) {
  if (typeof author !== "string" || typeof post !== "string") return false;
  const account = privateIdentifier(author);
  return (!grant.allowed.size || grant.allowed.has(account)) && !grant.authors.has(account) && !grant.posts.has(privateIdentifier(post));
}

/** Must run under the platform storage lock before inspecting, erasing or replacing a packet. */
async function captureState(folder: string, platform: Platform, now: string) {
  try {
    const grant = await permission(folder, platform, now), old = await receipt(folder);
    if (old && current(old, platform, grant, now)) {
      // A reviewer may be labelling the private packet in place. Never replace a live original.
      const file = await lstat(resolve(folder, "packet.json")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (file?.isFile() && file.nlink === 1 && file.uid === process.getuid?.() && (file.mode & 0o777) === 0o600)
        return { grant, live: true };
    }
    await purge(folder);
    return { grant, live: false };
  } catch (error) { await purge(folder); throw error; }
}

/** Observe only original responses the existing digest already acquired from its fixed HTTPS routes. */
export async function startNativeAnnotationCapture(root: string, platform: Platform, cutoff: string,
  clock: () => string = () => new Date().toISOString()): Promise<NativeAnnotationCapture> {
  const folder = await ownedArea(root, platform);
  if (!folder) return inactive("not_authorized");
  const started = clock();
  const { grant, live } = await underStorageLock(folder, () => captureState(folder, platform, started));
  if (live) return inactive("awaiting_annotation");
  if (!grant || !isSocialClock(started) || !isSocialClock(cutoff) || cutoff > started || Date.parse(started) - Date.parse(cutoff) > 900_000)
    return inactive("not_authorized");
  const batches: { instrument: Instrument; page: Record<string, unknown> }[] = [];
  const secret = randomBytes(32).toString("hex");
  const sourcePages: Proof["sourcePages"] = [];
  let bytes = 0, pages = 0, invalid = false;
  const instagramAccount = (username: string) => {
    const account = grant.instagram.get(privateIdentifier(username));
    return account && !grant.authors.has(account) ? account : undefined;
  };
  const observe: Sink = (instrument, native, incomplete = false) => {
    if (invalid) return;
    try {
      const profile = platform === "instagram" ? socialObject(native.business_discovery) : null;
      if (profile && (typeof native.requestedUsername !== "string" || native.requestedUsername !== profile.username ||
          typeof profile.id !== "string" || instagramAccount(native.requestedUsername) !== privateIdentifier(profile.id)))
        throw new Error("Account differs from the authorized Instagram identity");
      const original = JSON.stringify(native);
      if (incomplete || ++pages > (platform === "x" ? 10 : 20) || (bytes += Buffer.byteLength(original)) > 4_000_000 ||
          (native.errors !== undefined && (!Array.isArray(native.errors) || native.errors.length)))
        throw new Error("Incomplete or oversized source");
      sourcePages.push({ route: platform === "instagram" ? instagramRoute : instrument ? searchRoute : followingRoute,
        instrument, observedAt: clock(), canonicalPageMac: content(secret, String(pages), original) });
      const media = profile ? socialObject(profile.media) : null;
      const rows = (media ? media.data : native.data) ?? [];
      if (!Array.isArray(rows)) throw new Error("Missing native page");
      const read = rows.map(socialObject);
      if (profile && typeof profile.id === "string" && grant.allowed.has(privateIdentifier(profile.id)) &&
          read.some(row => typeof row.id !== "string" || !/^[1-9]\d{0,24}$/.test(row.id))) throw new Error("Missing native media identity");
      const authorized = read.filter(row => allowed(grant, profile ? profile.id : row.author_id, row.id));
      const targets = instrument ? [instrument] : INSTRUMENTS;
      for (const target of targets) {
        // X search has a known query per fund. An account timeline or opt-in panel needs its literal subject.
        const data = instrument ? authorized : authorized.filter(row => {
          const text = profile ? instagramCaptionText(row.caption) : xPostText(row);
          return text !== null && marketInstruments(text, platform === "x" ? "x" : undefined).includes(target);
        });
        const page = profile ? { requestedUsername: native.requestedUsername, business_discovery: { id: profile.id,
          username: profile.username, media: { data } } } : { includes: native.includes, data, meta: { result_count: data.length } };
        batches.push({ instrument: target, page });
      }
    } catch { invalid = true; batches.length = 0; }
  };
  return { observe, ...(platform === "instagram" && { acceptsInstagramHandle: (username: string) => Boolean(instagramAccount(username)) }),
    finish: async complete => {
    try {
      const collectedAt = clock();
      if (!complete || invalid || !pages || !isSocialClock(collectedAt) || collectedAt < started ||
          Date.parse(collectedAt) - Date.parse(started) > 900_000) return "source_incomplete";
      const from = new Date(Date.parse(cutoff) - day).toISOString();
      const expiresAt = new Date(Math.min(Date.parse(started) + day, Date.parse(grant.expiresAt))).toISOString();
      let template: Template;
      try {
        template = socialAnnotationTemplate({ schemaVersion: 1, source: platform === "x" ? "x-v2" : "instagram-business-discovery",
          from, through: cutoff, collectedAt, expiresAt, batches }, collectedAt);
      } catch { return "source_incomplete"; }
      const { items, ...sample } = template;
      if (!items.length) return "no_eligible_originals";
      const proof: Proof = { version: 1, platform, grant: grant.digest, secret, sample, sourcePages,
        rows: items.map(item => ({ ref: item.ref, platform, instrument: item.instrument, content: content(secret, item.ref, item.text) })) };
      if (Buffer.byteLength(JSON.stringify(template, null, 2)) + 1 > 512_000 ||
          Buffer.byteLength(JSON.stringify(proof, null, 2)) + 1 > 160_000) return "source_limit";
      return await underStorageLock(folder, async () => {
        const now = clock(), currentState = await captureState(folder, platform, now);
        if (currentState.grant?.digest !== grant.digest || !current(proof, platform, grant, now)) return "not_authorized";
        if (currentState.live) return "awaiting_annotation";
        await durableJSON(resolve(folder, "receipt.json"), proof, true);
        await durableJSON(resolve(folder, "packet.json"), template, true);
        return "ready_for_independent_labels";
      });
    } finally { batches.length = 0; }
  } };
}

export async function openCapturedSocialAnnotation(root: string, platform: Platform, now: string) {
  const folder = await ownedArea(root, platform);
  if (!folder || !isSocialClock(now)) throw new Error("No active annotation");
  return underStorageLock(folder, () => openVerifiedPacket(folder, platform, now));
}

async function openVerifiedPacket(folder: string, platform: Platform, now: string) {
  const clearOnFailure = async (error: unknown): Promise<never> => { await purge(folder); throw error; };
  const proof = await receipt(folder).catch(clearOnFailure), grant = await permission(folder, platform, now).catch(clearOnFailure);
  if (!proof || !current(proof, platform, grant, now)) {
    await purge(folder);
    throw new Error("Annotation expired or withdrawn");
  }
  const raw = await privateInput(resolve(folder, "packet.json"), 512_000);
  if (!raw) throw new Error("Missing private annotation");
  const packet = socialObject(JSON.parse(raw.toString()));
  if (packet.schemaVersion !== 2 || !Array.isArray(proof.rows) || !Array.isArray(packet.items) || packet.items.length !== proof.rows.length)
    throw new Error("Changed annotation membership");
  const selected = new Map(proof.rows.map(row => [row.ref, row]));
  const items = packet.items.map(item => {
    const row = socialObject(item), original = typeof row.ref === "string" && selected.get(row.ref);
    if (!original || original.platform !== platform || row.platform !== platform || row.instrument !== original.instrument ||
        typeof row.text !== "string" || content(proof.secret, original.ref, row.text) !== original.content)
      throw new Error("Annotation differs from verified source");
    selected.delete(original.ref);
    return { ref: original.ref, platform, instrument: original.instrument, text: row.text, expected: null };
  });
  if (selected.size) throw new Error("Missing verified source row");
  return { packet, template: { ...proof.sample, items } };
}

/** New enrollment after withdrawal requires an amended owner grant. */
export async function withdrawCapturedSocialAnnotation(root: string, platform: Platform, now: string) {
  const folder = await ownedArea(root, platform);
  if (!folder || !isSocialClock(now)) return;
  await underStorageLock(folder, async () => {
    try {
      const original = await privateInput(resolve(folder, "permission.json"), 64_000);
      if (original) await durableJSON(resolve(folder, "withdrawn.json"), { grant: digest(original), withdrawnAt: now });
    } finally { await purge(folder); }
  });
}
