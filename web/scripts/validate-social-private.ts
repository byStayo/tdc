import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BLUESKY_METHOD, marketStances, type LanguageCue } from "../lib/consensus/bluesky.ts";
import { INSTRUMENTS, type Instrument } from "../lib/consensus/types.ts";

const cues = ["upward", "downward", "mixed", "unclassified"] as const;
const platforms = ["x", "instagram", "bluesky"] as const;
const maxBytes = 512_000;
const root = fileURLToPath(new URL("../../", import.meta.url));
const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

async function readPrivateCorpus() {
  const path = process.argv[2];
  const directory = resolve(homedir(), ".local/share/daily-consensus");
  if (process.argv.length !== 3 || !path || !isAbsolute(path) || dirname(resolve(path)) !== directory)
    throw new Error("Use an absolute corpus path directly under ~/.local/share/daily-consensus/");
  const actualDirectory = await realpath(directory);
  const info = await stat(actualDirectory);
  if (!relative(await realpath(root), actualDirectory).startsWith("../") ||
      info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error("Corpus directory must be owner-only and outside the checkout");
  const file = await open(resolve(actualDirectory, relative(directory, resolve(path))),
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

async function main() {
  const corpus = await readPrivateCorpus();
  const now = new Date().toISOString();
  if (corpus.schemaVersion !== 1 || !canonicalInstant(corpus.collectedAt) ||
      !canonicalInstant(corpus.expiresAt) || corpus.collectedAt > now || corpus.expiresAt <= now ||
      Date.parse(corpus.expiresAt) - Date.parse(corpus.collectedAt) > 86_400_000 ||
      !Array.isArray(corpus.items) || corpus.items.length === 0)
    throw new Error("Expected a current independently labelled corpus with a maximum 24-hour lifetime");
  const groups = new Map<string, number[][]>();
  const seen = new Set<string>();
  for (const item of corpus.items) {
    const { platform, instrument, expected, text } = record(item);
    if (!platforms.includes(platform as typeof platforms[number]) ||
        !INSTRUMENTS.includes(instrument as Instrument) || !cues.includes(expected as LanguageCue) ||
        typeof text !== "string" || !text.trim() || text.length > 3000)
      throw new Error("Invalid labelled row");
    const group = `${platform}/${instrument}`;
    const key = JSON.stringify([group, text.trim().replace(/\s+/g, " ")]);
    if (seen.has(key)) throw new Error("Duplicate text for the same platform and instrument");
    seen.add(key);
    const matrix = groups.get(group) ?? cues.map(() => cues.map(() => 0));
    const predicted = marketStances(text)[instrument as Instrument] ?? "unclassified";
    matrix[cues.indexOf(expected as LanguageCue)][cues.indexOf(predicted)]++;
    groups.set(group, matrix);
  }
  const minimumRows = 10;
  const results = [...groups].flatMap(([group, matrix]) => {
    const rows = matrix.flat().reduce((a, b) => a + b, 0);
    if (rows < minimumRows) return [];
    const directionalCalls = matrix.reduce((sum, cells) => sum + cells[0] + cells[1], 0);
    return [{
      group, rows, expectedByPredicted: matrix,
      directionalCallRate: directionalCalls / rows,
      directionalPrecision: directionalCalls ? (matrix[0][0] + matrix[1][1]) / directionalCalls : null,
    }];
  });
  console.log(JSON.stringify({
    scope: "private-language-interpretation-only",
    classifier: BLUESKY_METHOD,
    labels: cues,
    minimumRowsPerGroup: minimumRows,
    suppressedGroups: groups.size - results.length,
    results,
  }, null, 2));
}

try {
  await main();
} catch {
  // Parse and filesystem errors can contain excerpts or identifying path names.
  console.error("Social benchmark refused the corpus. Check the documented schema, freshness, duplicates and file permissions.");
  process.exitCode = 1;
}
