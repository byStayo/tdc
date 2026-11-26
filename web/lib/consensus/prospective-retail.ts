import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { publicDate } from "../public-normalization.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import {
  collectNyFedStockOutlook,
  latestNyFedStockRelease,
  NYFED_SCE_ATTRIBUTION,
  NYFED_SCE_INDEX,
  parseNyFedStockOutlook,
  validateNyFedStockOutlook,
} from "./nyfed-stock-outlook.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const RETAIL_ROOT = ".consensus/private-nyfed-retail-prospective/v1";
export const RETAIL_REGISTRATION = RETAIL_ROOT + "/registration.json";
export const RETAIL_ID = "nyfed-household-stock-level-vs-prior-release-v1";
export const RETAIL_RULES = (["SPY", "QQQ", "IWM", "DIA"] as const).map(
  (instrument) =>
    ({
      id: RETAIL_ID,
      family: "retail",
      instrument,
      horizon: "daily",
      expectedSign: 1,
    }) as const,
);
export const RETAIL_POLICY = {
  version: 1,
  rules: RETAIL_RULES,
  selection:
    "One monthly SCE release per fund. Only the full immediate next exchange session, with a same-day pre-open public witness. The first original and separately dated calendar must agree. Never enroll a release already available when this study registered.",
  priceAccess:
    "Only verified private production daily settlement. Independent of historical SCE research. Respect all model holdouts. Private research only.",
  maturity:
    "Per fund, 500 prospective source-checked monthly dates and at least 100 nonoverlapping held-out decisions. Purged 60/20/20 chronological fit, positive incremental coefficient and >0.01 Brier improvement versus preceding-level-only, training base rate and coin. Reserve before evaluation. No automatic public vote. No prelaunch or reserved production outcomes.",
  definitions: {
    [RETAIL_ID]: {
      event:
        "The published national mean probability that United States stock prices will be higher in twelve months, one event per SCE reference month.",
      candidate:
        "Current independently timestamped original national percentage; positive coefficient predeclared.",
      control:
        "The preceding survey month's separately captured national percentage, verified before the current release.",
      rights: NYFED_SCE_ATTRIBUTION,
      terms: [NYFED_SCE_INDEX, "https://www.newyorkfed.org/privacy/termsofuse.html"],
    },
  },
};
const limit = 2_000_000;
type Document = { bytes: Buffer; sha256: string; retrievedAt: string };
type Read = (url: string) => Promise<Document>;
type Original = Omit<Document, "bytes"> & { url: string; gzip: string };
type Source = { version: 1; index: Original; release: Original; calendar: Original; sealedAt: string };
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const instant = (s: string) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const fail = (s: string): never => {
  throw new Error("Invalid SCE research source: " + s);
};
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const decode = (b: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(b);
const period = (end: string) => end.slice(0, 7);
const sourcePath = (month: string, name: string) => join(RETAIL_ROOT, "native", month, name + ".json");
function calendarUrl(day: string) {
  return (
    "https://www.newyorkfed.org/research/calendars/i-" +
    months[Number(day.slice(5, 7)) - 1].toLowerCase() +
    day.slice(2, 4) +
    ".html"
  );
}
function officialTime(calendar: string, day: string): string {
  const month = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const plain = (s: string) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const headings = [
    ...calendar.matchAll(/<td\b[^>]*class=["'][^"']*ts-data-table-head[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi),
  ]
    .map((match) => plain(match[1]))
    .filter((title) => /^[A-Za-z]+ 20\d{2}$/.test(title));
  if (headings.length !== 1 || headings[0] !== month + " " + day.slice(0, 4)) fail("calendar month");
  const result: string[] = [];
  for (const [, cell] of calendar.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    const body = plain(cell);
    const match = /^(\d{1,2})\b.*?\bSurvey of Consumer Expectations\s*\((\d\d?):(\d\d)\)/.exec(body);
    if (match) {
      // Only the core survey. Supplemental SCE modules have different event names.
      if (match[1].padStart(2, "0") !== day.slice(8)) fail("independent calendar date");
      const at = newYorkTimestamp(
        day.replaceAll("-", "") + "T" + match[2].padStart(2, "0") + match[3] + "00",
      );
      if (!at) fail("calendar release time");
      result.push(at!);
    }
  }
  if (result.length !== 1) fail("ambiguous calendar event");
  return result[0];
}
function original(url: string, doc: Document): Original {
  if (
    !Buffer.isBuffer(doc.bytes) ||
    !doc.bytes.length ||
    doc.bytes.length > limit ||
    hash(doc.bytes) !== doc.sha256 ||
    !instant(doc.retrievedAt)
  )
    fail("native bytes");
  return {
    url,
    sha256: doc.sha256,
    retrievedAt: doc.retrievedAt,
    gzip: gzipSync(doc.bytes).toString("base64"),
  };
}
function text(document: Original) {
  if (
    !document ||
    !instant(document.retrievedAt) ||
    typeof document.gzip !== "string" ||
    document.gzip.length > 3_000_000
  )
    fail("native receipt");
  const b = gunzipSync(Buffer.from(document.gzip, "base64"), { maxOutputLength: limit });
  if (hash(b) !== document.sha256) fail("original hash");
  return decode(b);
}
function parseSource(source: Source, cutoff: string) {
  if (
    !source ||
    source.version !== 1 ||
    !instant(cutoff) ||
    !instant(source.sealedAt) ||
    source.sealedAt > cutoff ||
    source.index.url !== NYFED_SCE_INDEX ||
    ![source.index, source.release, source.calendar].every(
      (s) => instant(s.retrievedAt) && s.retrievedAt <= source.sealedAt,
    ) ||
    source.index.retrievedAt > source.release.retrievedAt
  )
    fail("source receipt clock");
  const url = latestNyFedStockRelease(text(source.index));
  if (url !== source.release.url) fail("dated release identity");
  const urlDate = url.slice(-8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  if (!publicDate(urlDate) || source.calendar.url !== calendarUrl(urlDate)) fail("release address/date");
  const release = text(source.release),
    dated = [...release.matchAll(/<div\b[^>]*class=["']ts-contact-info["'][^>]*>([^<]+)<\/div>/gi)];
  const dayText = new Date(urlDate + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (dated.length !== 1 || dated[0][1].trim().replace(/\b0(\d),/, "$1,") !== dayText)
    fail("original printed date");
  const releaseText = release.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (
    /\bcorrection(?: notice)?\s*:|\b(?:this|the original|the previous) (?:press |data )?release (?:has been|was|is) (?:corrected|revised|restated)\b/i.test(
      releaseText,
    )
  )
    fail("source identifies an amended release");
  const releasedAt = officialTime(text(source.calendar), urlDate),
    point = parseNyFedStockOutlook(release, urlDate);
  if (source.release.retrievedAt < releasedAt || source.index.retrievedAt < releasedAt)
    fail("source predates its release");
  return { ...point, url, urlDate, releasedAt };
}
async function first<T>(path: string, value: T) {
  await durableDirectory(dirname(path), 0o700);
  try {
    await durableJSON(path, value, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return (await readResearchReceipt<T>(path)) ?? fail("lost immutable receipt");
}

/** Ordinary collection retains original data without changing the public observation when private evidence is unavailable. */
export async function collectRetailWithOriginals(read: Read, root?: string): Promise<Signal> {
  const docs = new Map<string, Document>();
  const signal = await collectNyFedStockOutlook(async (url) => {
    const d = await read(url);
    docs.set(url, d);
    return { text: d.bytes.toString("utf8"), sha256: d.sha256, retrievedAt: d.retrievedAt };
  });
  if (!root || signal.status !== "available") return signal;
  try {
    const point = signal.series[0],
      url = signal.source.url,
      releaseDate = signal.source.releasedAt!;
    const month = period(point.date),
      canonical = sourcePath(month, "first"),
      exact = sourcePath(month, signal.source.sha256!);
    const prior = await readResearchReceipt<Source>(join(root, canonical)),
      now = new Date().toISOString();
    if (prior) {
      const p = parseSource(prior, now);
      if (p.url !== url || p.value !== point.value || p.observedAt !== point.date)
        fail("issuer revised the first economic reading");
      if (prior.release.sha256 === signal.source.sha256) return signal;
      // Only a release-day/morning witness can use another copy of the same economic reading.
      const today = newYorkDate(now),
        days = exchangeSessions(releaseDate, today).filter((d) => d > releaseDate);
      if (days.length > 1 || (days.length === 1 && now >= exchangeSession(days[0])!.openAt)) return signal;
    }
    const calendar =
      prior?.calendar ?? original(calendarUrl(releaseDate), await read(calendarUrl(releaseDate)));
    const receipt: Source = {
      version: 1,
      index: original(NYFED_SCE_INDEX, docs.get(NYFED_SCE_INDEX)!),
      release: original(url, docs.get(url)!),
      calendar,
      sealedAt: new Date().toISOString(),
    };
    const p = parseSource(receipt, receipt.sealedAt);
    if (p.value !== point.value || p.observedAt !== point.date) fail("as-issued measure");
    const firstCopy = await first(join(root, canonical), receipt),
      f = parseSource(firstCopy, new Date().toISOString());
    if (f.value !== p.value || f.observedAt !== p.observedAt || f.url !== p.url)
      fail("competing first release");
    if (firstCopy.release.sha256 !== receipt.release.sha256) {
      const copy = await first(join(root, exact), receipt),
        verified = parseSource(copy, new Date().toISOString());
      if (
        copy.release.sha256 !== signal.source.sha256 ||
        verified.value !== f.value ||
        verified.url !== f.url
      )
        fail("competing changed release");
    }
  } catch (error) {
    console.error(
      "Private SCE release capture failed.",
      error instanceof Error ? error.message : String(error),
    );
  }
  return signal;
}

type Proof = { file: string; sha256: string };
export async function retailInput(
  root: string,
  signal: Signal,
  session: string,
  cutoff: string,
  registeredAt: string,
) {
  validateNyFedStockOutlook(signal);
  const current = signal.series[0],
    date = signal.source.releasedAt!,
    next = exchangeSessions(date, session).find((day) => day > date),
    target = exchangeSession(session);
  if (!target || next !== session || Date.parse(target.closeAt) - Date.parse(target.openAt) !== 390 * 60_000)
    return { reason: "outside-survey-release-target" } as const;
  const month = period(current.date),
    prev = period(new Date(Date.parse(month + "-01") - 86_400_000).toISOString());
  const canonicalPath = sourcePath(month, "first"),
    priorPath = sourcePath(prev, "first");
  const canonical = await readResearchReceipt<Source>(join(root, canonicalPath)),
    prior = await readResearchReceipt<Source>(join(root, priorPath));
  if (!canonical || !prior) return { reason: "native-proof-missing" } as const;
  const src = parseSource(canonical, cutoff),
    control = parseSource(prior, cutoff),
    exactPath =
      canonical.release.sha256 === signal.source.sha256
        ? canonicalPath
        : sourcePath(month, signal.source.sha256!);
  const c =
    exactPath === canonicalPath ? canonical : await readResearchReceipt<Source>(join(root, exactPath));
  if (!c) return { reason: "native-proof-missing" } as const;
  const exact = parseSource(c, cutoff);
  if (registeredAt >= src.releasedAt) return { reason: "release-predates-registration" } as const;
  if (
    control.observedAt.slice(0, 7) !== prev ||
    current.date !== src.observedAt ||
    src.observedAt !== exact.observedAt ||
    date !== src.urlDate ||
    exact.url !== src.url ||
    src.url !== signal.source.url ||
    exact.value !== current.value ||
    src.value !== current.value ||
    c.release.sha256 !== signal.source.sha256 ||
    prior.sealedAt >= src.releasedAt ||
    control.releasedAt >= src.releasedAt ||
    src.releasedAt !== exact.releasedAt ||
    signal.source.retrievedAt < c.release.retrievedAt
  )
    return { reason: "native-proof-mismatch" } as const;
  const proof = (file: string, v: Source): Proof => ({ file, sha256: digest(v) });
  const proofs = [proof(canonicalPath, canonical), proof(priorPath, prior)];
  if (exactPath !== canonicalPath) proofs.push(proof(exactPath, c));
  return {
    data: {
      candidate: src.value,
      control: control.value,
      eventId: "nyfed-sce:stock:" + month,
      observedThrough: src.releasedAt,
      availableAt: [c.sealedAt, canonical.sealedAt, signal.source.retrievedAt].sort().at(-1)!,
      sourceHashes: [c.release.sha256, prior.release.sha256, c.calendar.sha256, prior.calendar.sha256],
      proofs,
    },
  };
}
