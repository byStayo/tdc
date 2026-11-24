import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BLUESKY_METHOD, MINIMUM_PARTICIPANTS, X_STANCE_METHOD, marketStances, type Exclusions, type LanguageCue } from "../lib/consensus/bluesky.ts";
import { nativeAnnotationFolder, openCapturedSocialAnnotation, withdrawCapturedSocialAnnotation } from "../lib/consensus/social-annotation-capture.ts";
import { readBlueskyAnnotationExclusions } from "../lib/bluesky-private.ts";
import { instagramCaptionText } from "../lib/consensus/instagram-post-text.ts";
import { INSTRUMENTS, type Instrument } from "../lib/consensus/types.ts";
import { isSocialClock as canonicalInstant, socialAnnotationTemplate, socialObject as record } from "../lib/consensus/social-annotation-source.ts";
import { xLongPostText } from "../lib/consensus/x-post-text.ts";

const cues = ["upward", "downward", "mixed", "unclassified"] as const;
const platforms = ["x", "instagram", "bluesky"] as const;
const maxBytes = 512_000;
const root = fileURLToPath(new URL("../../", import.meta.url));
async function privateCorpusPath(path: string) {
  if (!path || !isAbsolute(path)) throw new Error("An absolute owner-only corpus path is required");
  const directory = dirname(resolve(path)), actualDirectory = await realpath(directory);
  const canonical = resolve(homedir(), ".local/share/daily-consensus");
  const disposable = /^daily-consensus-social-[a-zA-Z0-9_-]{6,32}$/.test(basename(directory)) &&
    dirname(actualDirectory) === await realpath(tmpdir());
  if (directory !== canonical && !disposable) throw new Error("Unrecognized private corpus directory");
  const info = await lstat(directory);
  if (!info.isDirectory() || (disposable && basename(directory) !== basename(actualDirectory)) ||
      !relative(await realpath(root), actualDirectory).startsWith("../") ||
      info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error("Corpus directory must be owner-only and outside the checkout");
  return resolve(actualDirectory, relative(directory, resolve(path)));
}

async function readPrivateCorpus(path: string) {
  const file = await open(await privateCorpusPath(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600 || info.size > maxBytes)
      throw new Error("Corpus must be a local owner-only 0600 regular file within the size limit");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error("Corpus exceeds size limit");
    return record(JSON.parse(buffer.subarray(0, size).toString("utf8")));
  } finally {
    await file.close();
  }
}

export function evaluateSocialCorpus(corpus: Record<string, unknown>, now = new Date().toISOString(), native?: unknown, exclusions?: Exclusions) {
  return scoreCheckedSocialCorpus(corpus, now, () => typeof corpus.nonce === "string" && native !== undefined
    ? socialAnnotationTemplate(native, now, corpus.nonce, exclusions) : undefined);
}

function scoreCheckedSocialCorpus(corpus: Record<string, unknown>, now: string,
  checkedSource: () => ReturnType<typeof socialAnnotationTemplate> | undefined) {
  if ((corpus.schemaVersion !== 1 && corpus.schemaVersion !== 2) || !canonicalInstant(now) || !canonicalInstant(corpus.collectedAt) ||
      !canonicalInstant(corpus.expiresAt) || corpus.collectedAt > now || corpus.expiresAt <= now ||
      Date.parse(corpus.expiresAt) - Date.parse(corpus.collectedAt) > 86_400_000 ||
      !Array.isArray(corpus.items) || (corpus.schemaVersion === 1 && !corpus.items.length))
    throw new Error("Expected a current independently labelled corpus with a maximum 24-hour lifetime");
  const matrix = () => cues.map(() => cues.map(() => 0));
  const groups = new Map<string, { matrix: number[][]; pending: number }>();
  const seen = new Set<string>();
  const verified = corpus.schemaVersion === 2;
  let originals: Map<string, { platform: string; instrument: Instrument; text: string }> | undefined;
  if (verified) {
    const template = checkedSource();
    if (!template || template.nonce !== corpus.nonce) throw new Error("Independent native source required");
    if (template.collectedAt !== corpus.collectedAt || template.expiresAt !== corpus.expiresAt ||
        template.source !== corpus.source || template.from !== corpus.from || template.through !== corpus.through ||
        JSON.stringify(template.groups) !== JSON.stringify(corpus.groups) || template.items.length !== corpus.items.length)
      throw new Error("The annotated packet differs from its original source cohort");
    originals = new Map(template.items.map(item => [item.ref, item]));
    for (const group of template.groups) groups.set(group, { matrix: matrix(), pending: 0 });
  }
  for (const item of corpus.items) {
    const row = record(item);
    const { platform, instrument, expected, text } = row;
    if (!platforms.includes(platform as typeof platforms[number]) || !INSTRUMENTS.includes(instrument as Instrument) ||
        (!(verified && expected === null) && !cues.includes(expected as LanguageCue)) ||
        typeof text !== "string" || !text.trim()) throw new Error("Invalid labelled row");
    if (originals) {
      const original = typeof row.ref === "string" && originals.get(row.ref);
      if (!original || original.platform !== platform || original.instrument !== instrument || original.text !== text ||
          Object.keys(row).some(k => !["ref", "platform", "instrument", "text", "expected"].includes(k)))
        throw new Error("Annotation does not match its independent native source");
      originals.delete(row.ref as string);
    }
    let classifierText: string | null;
    if (platform === "x") classifierText = xLongPostText(text);
    else if (platform === "instagram") classifierText = instagramCaptionText(text);
    else classifierText = text.length <= 3000 ? text : null;
    if (classifierText === null) throw new Error("Invalid platform text");
    const group = `${platform}/${instrument}`;
    const key = JSON.stringify([group, text.trim().replace(/\s+/g, " ")]);
    if (seen.has(key)) throw new Error("Duplicate text for the same platform and instrument");
    seen.add(key);
    const state = groups.get(group) ?? { matrix: matrix(), pending: 0 };
    groups.set(group, state);
    if (!verified) continue;
    if (expected === null) {
      state.pending++;
      continue;
    }
    const predicted = marketStances(classifierText, platform === "x" ? "x" : undefined)[instrument as Instrument] ?? "unclassified";
    state.matrix[cues.indexOf(expected as LanguageCue)][cues.indexOf(predicted)]++;
  }
  if (originals?.size) throw new Error("Missing an independently selected source row");
  const results = [...groups].flatMap(([group, { matrix, pending }]) => {
    const rows = matrix.flat().reduce((a, b) => a + b, 0);
    if (!verified || rows < MINIMUM_PARTICIPANTS) return [];
    const directionalCalls = matrix.reduce((sum, cells) => sum + cells[0] + cells[1], 0);
    return [{
      group, rows, selectedContributors: rows + pending, unlabelled: pending, expectedByPredicted: matrix,
      directionalCallRate: directionalCalls / rows,
      directionalPrecision: directionalCalls ? (matrix[0][0] + matrix[1][1]) / directionalCalls : null,
    }];
  });
  return {
    scope: "private-language-interpretation-only",
    inputPolicy: verified ? "native-contributors-v3" : "native-text-v2",
    contributorVerification: verified ? "replayed-native-source" : "unavailable-legacy",
    classifiers: { x: X_STANCE_METHOD, bluesky: BLUESKY_METHOD, instagram: BLUESKY_METHOD },
    labels: cues,
    minimumRowsPerGroup: MINIMUM_PARTICIPANTS,
    minimumContributorsPerGroup: MINIMUM_PARTICIPANTS,
    suppressedGroups: groups.size - results.length,
    results,
  };
}

async function readNativeSource() {
  if (process.stdin.isTTY) throw new Error("The independent native export must be supplied on stdin");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4_000_000) throw new Error("Native source exceeds limit");
    chunks.push(buffer);
  }
  const native = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const exclusions = native.source === "bluesky-appview" ? await readBlueskyAnnotationExclusions(resolve(root, "web")) : undefined;
  return { native, exclusions };
}

async function preparePrivateCorpus(path: string) {
  const target = await privateCorpusPath(path);
  const { native, exclusions } = await readNativeSource();
  const template = socialAnnotationTemplate(native, new Date().toISOString(), undefined, exclusions);
  const body = JSON.stringify(template, null, 2) + "\n";
  if (Buffer.byteLength(body) > maxBytes) throw new Error("Annotation packet exceeds its size limit");
  const file = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(body);
  } catch (error) {
    await unlink(target);
    throw error;
  } finally {
    await file.close();
  }
  return { status: "prepared", sourceGroups: template.groups.length, selectedRows: template.items.length,
    expiresAt: template.expiresAt };
}

export async function runCapturedSocialBenchmark(storage: string, platform: "x" | "instagram", withdraw = false,
  clock: () => string = () => new Date().toISOString()) {
  const now = clock();
  if (withdraw) {
    await withdrawCapturedSocialAnnotation(storage, platform, now);
    return { status: "withdrawn" };
  }
  const { packet, template } = await openCapturedSocialAnnotation(storage, platform, now);
  const result = scoreCheckedSocialCorpus(packet, now, () => template);
  return { ...result, contributorVerification: "verified-at-provider-collection" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let result;
    if (args.length === 2 && args[0] === "--prepare") {
      result = await preparePrivateCorpus(args[1]);
    } else if (args.length === 2 && ["--captured", "--withdraw-captured"].includes(args[0]) &&
        (args[1] === "x" || args[1] === "instagram")) {
      result = await runCapturedSocialBenchmark(nativeAnnotationFolder(), args[1], args[0] === "--withdraw-captured");
    } else if (args.length === 1) {
      const corpus = await readPrivateCorpus(args[0]);
      const source = corpus.schemaVersion === 2 ? await readNativeSource() : undefined;
      result = evaluateSocialCorpus(corpus, new Date().toISOString(), source?.native, source?.exclusions);
    } else {
      throw new Error("Unexpected arguments");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Parse and filesystem errors can contain excerpts or identifying path names.
    console.error("Social benchmark refused the input. Check the native source, annotation, freshness and private file permissions.");
    process.exitCode = 1;
  }
}
