import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { INSTRUMENTS } from "./types.ts";
import type { Signal } from "./types.ts";
import { publicDate } from "../public-normalization.ts";
import { sourceResponse, sourceChunk, sourceFailureKind, SourceMissingError } from "./source-failure.ts";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface NewsStory {
  id: string;
  title: string;
  url: string;
  domain: string;
  batchAt: string;
  publishedAt: string | null;
  tone: number;
  themes: string[];
  mentions: number;
}
export interface NewsPulse {
  batchAt: string;
  sourceUrl: string;
  sourceHash: string;
  rowsScanned: number;
  matchedArticles: number;
  storyCount: number;
  publishers: number;
  positive: number;
  negative: number;
  balanced: number;
  meanTone: number | null;
  stories: NewsStory[];
  methodology: string;
}
const THEMES = new Set([
  "ECON_STOCKMARKET",
  "ECON_CENTRALBANK",
  "ECON_INTEREST_RATES",
  "ECON_INFLATION",
  "ECON_WORLDCURRENCIES",
  "WB_332_CAPITAL_MARKETS",
]);
const FINANCE =
  /\b(?:stocks?|equities|equity|nasdaq|dow jones|wall street|s&p|treasur(?:y|ies)|bonds?|yields?|federal reserve|fed|ecb|boe|boj|central bank|inflation|interest rates?|earnings|profits?|revenues?|liquidity|currenc(?:y|ies)|forex|ftse|dax|nikkei|hang seng|ipo)\b/i;
const clean = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function gdeltTime(raw: string): string | null {
  if (!/^\d{14}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}.000Z`;
  return publicDate(iso) && new Date(iso).toISOString() === iso ? iso : null;
}
function articleURL(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !u.hostname.includes(".") ||
      /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname) ||
      /(?:token|api[_-]?key|secret|password)=/i.test(u.search)
    )
      return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (key.startsWith("utm_") || ["fbclid", "gclid"].includes(key))
        u.searchParams.delete(key);
    return u.href;
  } catch {
    return null;
  }
}
export function parseGkg(
  text: string,
  batchAt: string,
  sourceUrl: string,
  sourceHash: string,
  cutoff: string,
): NewsPulse {
  if (
    !gdeltTime(batchAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14)) ||
    batchAt > cutoff
  )
    throw new Error("Invalid or future news batch");
  const seen = new Set<string>(),
    groups = new Map<string, NewsStory>();
  let rowsScanned = 0,
    matchedArticles = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (++rowsScanned > 100000)
      throw new Error("News batch row limit exceeded");
    const row = line.split("\t");
    if (row.length !== 27 || row[2] !== "1" || gdeltTime(row[1]) !== batchAt)
      continue;
    const themes = row[7].split(";").filter((t) => THEMES.has(t));
    if (!themes.length) continue;
    const title = clean(
      row[26].match(/<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/)?.[1] ?? "",
    );
    if (!FINANCE.test(title) || title.length < 8 || title.length > 500)
      continue;
    const url = articleURL(row[4]);
    if (!url || seen.has(url)) continue;
    const toneParts = row[15].split(","),
      tone = Number(toneParts[0]);
    if (
      toneParts.length !== 7 ||
      !toneParts[0] ||
      !Number.isFinite(tone) ||
      Math.abs(tone) > 100 ||
      Number(toneParts[6]) < 50
    )
      continue;
    const rawPublished = row[26].match(
        /<PAGE_PRECISEPUBTIMESTAMP>(\d{14})<\/PAGE_PRECISEPUBTIMESTAMP>/,
      )?.[1],
      publishedAt = rawPublished ? gdeltTime(rawPublished) : null;
    if (
      rawPublished &&
      (!publishedAt ||
        publishedAt > cutoff ||
        Date.parse(cutoff) - Date.parse(publishedAt) > 48 * 3600000)
    )
      continue;
    seen.add(url);
    matchedArticles++;
    // Exact normalized headlines collapse syndication. Paraphrased duplicates may remain.
    const normalized = title
      .toLowerCase()
      .replace(/\s+[|]\s+[^|]+$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    const prior = groups.get(normalized);
    if (prior) {
      prior.mentions++;
      continue;
    }
    groups.set(normalized, {
      id: createHash("sha256").update(normalized).digest("hex").slice(0, 20),
      title: title.slice(0, 200),
      url,
      domain: new URL(url).hostname.replace(/^www\./, ""),
      batchAt,
      publishedAt,
      tone,
      themes,
      mentions: 1,
    });
  }
  const stories = [...groups.values()];
  const domains = new Map<string, number[]>();
  for (const s of stories)
    domains.set(s.domain, [...(domains.get(s.domain) ?? []), s.tone]);
  const publisherMeans = [...domains.values()].map(
    (x) => x.reduce((a, b) => a + b, 0) / x.length,
  );
  return {
    batchAt,
    sourceUrl,
    sourceHash,
    rowsScanned,
    matchedArticles,
    storyCount: stories.length,
    publishers: domains.size,
    positive: stories.filter((s) => s.tone > 1).length,
    negative: stories.filter((s) => s.tone < -1).length,
    balanced: stories.filter((s) => Math.abs(s.tone) <= 1).length,
    meanTone: publisherMeans.length
      ? publisherMeans.reduce((a, b) => a + b, 0) / publisherMeans.length
      : null,
    stories: stories.sort(
      (a, b) => b.mentions - a.mentions || a.id.localeCompare(b.id),
    ),
    methodology:
      "One GDELT English-language 15-minute batch, matched to declared finance themes and headline terms; exact normalized headlines collapse syndication. Tone bins: below −1, within ±1, above +1. Mean gives each publisher equal weight. Batch time is not a verified article publication time; publisher timestamps are shown separately when supplied. This is a bounded global sample, not all news or investor sentiment. Tone is descriptive and casts no directional trading vote.",
  };
}
export function gdeltManifest(
  text: string,
  cutoff: string,
): { url: string; size: number; md5: string; at: string } {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/));
  const entry = rows.find(
    (r) => r.length === 3 && /\.gkg\.csv\.zip$/.test(r[2]),
  );
  if (!entry) throw new Error("No news batch in manifest");
  const [size, md5, raw] = entry,
    url = new URL(raw);
  url.protocol = "https:";
  const m = url.pathname.match(/^\/gdeltv2\/(\d{14})\.gkg\.csv\.zip$/),
    at = m ? gdeltTime(m[1]) : null;
  if (
    url.hostname !== "data.gdeltproject.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !at ||
    at > cutoff ||
    Date.parse(cutoff) - Date.parse(at) > 6 * 3600000 ||
    !/^\d+$/.test(size) ||
    +size < 1 ||
    +size > 12000000 ||
    !/^[a-f0-9]{32}$/.test(md5)
  )
    throw new Error("Invalid news batch manifest");
  return { url: url.href, size: +size, md5, at };
}
export function unpackGkg(data: Uint8Array, expectedName: string): string {
  let accepted = 0;
  const files = unzipSync(data, {
    filter: (file) => {
      if (
        file.name !== expectedName ||
        file.originalSize > 60000000 ||
        ++accepted > 1
      )
        throw new Error("Unexpected ZIP entry or size");
      return true;
    },
  });
  const output = files[expectedName];
  if (
    !output ||
    Object.keys(files).length !== 1 ||
    output.byteLength > 60000000
  )
    throw new Error("Invalid news archive");
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
async function bytes(
  url: string,
  limit: number,
  fetcher: Fetcher,
  range?: string,
): Promise<Uint8Array> {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "data.gdeltproject.org" ||
    u.port ||
    u.search ||
    u.username ||
    u.password ||
    !/^\/gdeltv2\/(?:masterfilelist\.txt|\d{14}\.gkg\.csv\.zip)$/.test(u.pathname)
  )
    throw new Error("Unexpected GDELT source");
  const r = await sourceResponse(fetcher, url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    ...(range ? { headers: { Range: range } } : {}),
  });
  if (range && (r.status !== 206 || !/^bytes \d+-\d+\/\d+$/.test(r.headers.get("Content-Range") ?? ""))) {
    await r.body!.cancel().catch(() => undefined);
    throw new Error("GDELT did not return a bounded index range");
  }
  const reader = r.body!.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("GDELT download limit");
      chunks.push(part.value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return Buffer.concat(chunks);
}

async function latestBatch(fetcher: Fetcher, cutoff: string) {
  // The index can announce a batch before its ZIP is served. Read only its tail.
  const index = new TextDecoder().decode(await bytes(
    "https://data.gdeltproject.org/gdeltv2/masterfilelist.txt",
    16384,
    fetcher,
    "bytes=-16384",
  ));
  const candidates = new Map<string, ReturnType<typeof gdeltManifest>>();
  for (const line of index.split(/\r?\n/).slice(1)) {
    if (!line.endsWith(".gkg.csv.zip")) continue;
    try {
      const manifest = gdeltManifest(line, cutoff);
      candidates.set(manifest.url, manifest);
    } catch {
      // The partial index can also contain future, expired or oversized batches.
    }
  }
  const newest = [...candidates.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  for (const manifest of newest) {
    try {
      return { manifest, zip: await bytes(manifest.url, manifest.size, fetcher) };
    } catch (error) {
      if (!(error instanceof SourceMissingError)) throw error;
    }
  }
  throw new Error("No recent GDELT news archive is available");
}

export async function collectNews(
  fetcher: Fetcher = fetch,
): Promise<{ signal: Signal; pulse: NewsPulse | null }> {
  const at = new Date().toISOString();
  const signal: Signal = {
    id: "gdelt-finance-news",
    family: "news",
    title: "Global financial news tone",
    shortLabel: "News tone",
    instruments: [...INSTRUMENTS],
    status: "unavailable",
    summary: "A current financial-news sample is unavailable.",
    source: {
      name: "The GDELT Project",
      url: "https://www.gdeltproject.org/",
      retrievedAt: at,
      observedAt: null,
      releasedAt: null,
      frequency: "15-minute batch",
      attribution: "The GDELT Project · https://www.gdeltproject.org/",
      usage:
        "Open GDELT metadata, redistributed with citation and source link. Original articles remain with their publishers.",
      sha256: null,
    },
    methodology:
      "Bounded public GKG batch, finance-theme and headline filters, syndicated headline deduplication, publisher-balanced tone. No directional score inferred from tone.",
    limitation:
      "Sampled English-language global finance coverage with possible topic errors and residual syndication. This is not the full daily news cycle or sentiment toward an individual ETF.",
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 1,
    unit: "tone",
  };
  try {
    const { manifest, zip } = await latestBatch(fetcher, at);
    if (
      zip.byteLength !== manifest.size ||
      createHash("md5").update(zip).digest("hex") !== manifest.md5
    )
      throw new Error("GDELT checksum mismatch");
    const retrievedAt = new Date().toISOString(),
      hash = createHash("sha256").update(zip).digest("hex"),
      pulse = parseGkg(
        unpackGkg(
          zip,
          manifest.url
            .split("/")
            .at(-1)!
            .replace(/\.zip$/, ""),
        ),
        manifest.at,
        manifest.url,
        hash,
        retrievedAt,
      );
    if (!pulse.storyCount) throw new Error("No matching financial stories");
    return {
      pulse,
      signal: {
        ...signal,
        status: "available",
        source: {
          ...signal.source,
          retrievedAt,
          observedAt: manifest.at,
          sha256: hash,
        },
        summary: `${pulse.storyCount} finance stories from ${pulse.publishers} publishers in the ${manifest.at.slice(11, 16)} UTC batch. News tone is descriptive, not a trading call.`,
        metrics: [
          {
            label: "Distinct sampled stories",
            value: pulse.storyCount,
            unit: "stories",
            date: manifest.at,
          },
          {
            label: "Publishers represented",
            value: pulse.publishers,
            unit: "publishers",
            date: manifest.at,
          },
          {
            label: "Publisher-balanced tone",
            value: pulse.meanTone!,
            unit: "−100 to +100",
            date: manifest.at,
          },
        ],
      },
    };
  } catch (error) {
    return { signal: {...signal, failureKind: sourceFailureKind(error)}, pulse: null };
  }
}
