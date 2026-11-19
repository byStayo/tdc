import { publicDate } from "./public-normalization.ts";
import { newYorkTimestamp } from "./consensus/time.ts";
import type { EditorialEvidence, EditorialSource } from "../scripts/collect-editorial-evidence.ts";

export const FED_MINUTES_ID = "FED_FOMC_MINUTES";
export const FED_MINUTES_FEED = "https://www.federalreserve.gov/feeds/press_monetary.xml";
export const FED_MINUTES_USAGE = {
  scope: "editorial-context-only", policyUrl: "https://www.federalreserve.gov/disclaimer.htm",
  attribution: "Board of Governors of the Federal Reserve System",
  basis: "Board-authored website text is public domain unless otherwise indicated; cite the Board. Third-party material, seals and logos are excluded.",
} as const;
type Stamp = { url: string; sha256: string; retrievedAt: string };
type Capture = Omit<Stamp, "url"> & { text: string };
export type FedMinutesReader = (url: string) => Promise<Capture>;
export type FedMinutesData = {
  publishedAt: string; releaseClock: string; meetingStartedOn: string; meetingEndedOn: string; cutoff: string;
  catalog: Stamp; release: Stamp; minutes: Stamp; excerpt: string; excerptTruncated: boolean; contentCharacters: number; usage: typeof FED_MINUTES_USAGE;
};
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const day = (v: unknown): v is string => typeof v === "string" && publicDate(v) === v;
const months = "January February March April May June July August September October November December".split(" ");
const monthPattern = months.join("|");
function plain(html: string): string {
  return html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|nbsp|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
      const named: Record<string, string> = { "&amp;": "&", "&nbsp;": " ", "&quot;": '"', "&apos;": "'" };
      const code = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      return named[entity] ?? (Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ");
    }).replace(/\s+/g, " ").trim();
}
export function assertFedMinutesURL(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "www.federalreserve.gov" || url.username || url.password || url.port || url.search || url.hash ||
      !/^(?:\/feeds\/press_monetary\.xml|\/newsevents\/pressreleases\/monetary\d{8}[a-z]\.htm|\/monetarypolicy\/fomcminutes\d{8}\.htm|\/disclaimer\.htm)$/.test(url.pathname))
    throw new Error("Fed minutes need an exact official release, minutes or catalog URL");
  return url.href;
}
function meeting(text: string): [string, string] {
  const match = text.match(new RegExp(`(${monthPattern}) (\\d{1,2})(?:\\s*[-–]\\s*(?:(${monthPattern}) )?(\\d{1,2}))?, (\\d{4})`));
  if (!match) throw new Error("Missing FOMC meeting dates");
  const date = (month: string, date: string) => `${match[5]}-${String(months.indexOf(month) + 1).padStart(2, "0")}-${date.padStart(2, "0")}`;
  const start = date(match[1], match[2]), end = date(match[3] ?? match[1], match[4] ?? match[2]);
  if (!day(start) || !day(end) || start > end || Date.parse(end) - Date.parse(start) > 2 * 86400000) throw new Error("Invalid FOMC meeting dates");
  return [start, end];
}
function publication(date: string, clock: string): string {
  const match = clock.match(/^(\d{1,2}):(\d{2}) (a|p)\.m\. (EST|EDT)$/);
  if (!day(date) || !match || +match[1] < 1 || +match[1] > 12 || +match[2] > 59) throw new Error("Missing explicit Fed release clock");
  const hour = (+match[1] % 12) + (match[3] === "p" ? 12 : 0);
  const at = newYorkTimestamp(date.replaceAll("-", "") + "T" + String(hour).padStart(2, "0") + match[2] + "00");
  const zone = at && new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).formatToParts(new Date(at)).find(p => p.type === "timeZoneName")?.value;
  if (!at || zone !== match[4]) throw new Error("Fed release clock disagrees with New York time");
  return at;
}

/** Full normalized text is for ignored private captures, never the public manifest. */
export function privateFedMinutesText(html: string): string {
  const article = html.match(/<div\b[^>]*id=["']article["'][^>]*>([\s\S]*?)<a\b[^>]*id=["']back-top["']/i)?.[1];
  return plain(article ?? "");
}

export function validateFedMinutesSource(source: EditorialSource, now = Date.now()): void {
  const fed = [source.url, source.retrievalUrl].some(url => new URL(url).hostname === "www.federalreserve.gov");
  if (!fed && source.kind !== "fed_minutes" && source.id !== FED_MINUTES_ID) return;
  const invalid = () => { throw new Error("Invalid original Fed minutes editorial evidence"); };
  if (!fed || source.id !== FED_MINUTES_ID || source.kind !== "fed_minutes" ||
      !instant(source.retrievedAt) || Date.parse(source.retrievedAt) > now) return invalid();
  assertFedMinutesURL(source.url); assertFedMinutesURL(source.retrievalUrl);
  if (source.status === "unavailable") {
    if (source.data !== null || source.url !== FED_MINUTES_FEED || source.retrievalUrl !== FED_MINUTES_FEED || source.observationDates.length) return invalid();
    return;
  }
  const data = source.data as FedMinutesData | null;
  const keys = ["publishedAt", "releaseClock", "meetingStartedOn", "meetingEndedOn", "cutoff", "catalog", "release", "minutes", "excerpt", "excerptTruncated", "contentCharacters", "usage"];
  if (source.status !== "ok" || !data || !instant(data.publishedAt) || !instant(data.cutoff) ||
      Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key)) ||
      !day(data.meetingStartedOn) || !day(data.meetingEndedOn) || data.meetingStartedOn > data.meetingEndedOn ||
      Date.parse(data.meetingEndedOn) - Date.parse(data.meetingStartedOn) > 2 * 86400000 ||
      data.meetingEndedOn > data.publishedAt.slice(0, 10) || data.publishedAt > data.cutoff || data.cutoff > source.retrievedAt ||
      source.url !== data.release?.url || source.retrievalUrl !== data.minutes?.url || data.catalog?.url !== FED_MINUTES_FEED ||
      source.observationDates.length !== 1 || source.observationDates[0] !== data.publishedAt.slice(0, 10) ||
      typeof data.excerpt !== "string" || data.excerpt.length < 100 || data.excerpt.length > 1200 ||
      !Number.isSafeInteger(data.contentCharacters) || data.contentCharacters < 500 || data.contentCharacters > 2 * 1024 * 1024 ||
      data.excerpt.length !== Math.min(1200, data.contentCharacters) || data.excerptTruncated !== (data.contentCharacters > data.excerpt.length) ||
      JSON.stringify(data.usage) !== JSON.stringify(FED_MINUTES_USAGE)) return invalid();
  if (!data.excerpt.startsWith("Minutes of the Federal Open Market Committee ") ||
      JSON.stringify(meeting(data.excerpt)) !== JSON.stringify([data.meetingStartedOn, data.meetingEndedOn])) return invalid();
  const releasedOn = source.url.match(/\/monetary(\d{4})(\d{2})(\d{2})[a-z]\.htm$/);
  if (!releasedOn || publication(`${releasedOn[1]}-${releasedOn[2]}-${releasedOn[3]}`, data.releaseClock) !== data.publishedAt ||
      source.retrievalUrl !== `https://www.federalreserve.gov/monetarypolicy/fomcminutes${data.meetingEndedOn.replaceAll("-", "")}.htm`) return invalid();
  let preceding = data.cutoff;
  for (const capture of [data.catalog, data.release, data.minutes]) {
    assertFedMinutesURL(capture.url);
    if (!instant(capture.retrievedAt) || capture.retrievedAt < preceding || capture.retrievedAt > source.retrievedAt ||
        !/^[a-f0-9]{64}$/.test(capture.sha256)) return invalid();
    preceding = capture.retrievedAt;
  }
  if (data.minutes.retrievedAt !== source.retrievedAt) return invalid();
}

/** Three bounded official requests; release clocks never come from meeting dates. */
export async function collectFedMinutes(read: FedMinutesReader, cutoff = new Date().toISOString()): Promise<EditorialSource> {
  const base = { id: FED_MINUTES_ID, kind: "fed_minutes" as const, title: "Federal Reserve · FOMC minutes",
    url: FED_MINUTES_FEED, retrievalUrl: FED_MINUTES_FEED };
  try {
    if (!instant(cutoff) || cutoff > new Date().toISOString()) throw new Error("Invalid Fed collection cutoff");
    const catalog = await read(FED_MINUTES_FEED);
    const items = [...catalog.text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 30);
    const item = items.find(item => /^Minutes of the Federal Open Market Committee, /.test(plain(item[1].match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "")))?.[1];
    if (!item) throw new Error("No original FOMC minutes release in the bounded official feed");
    const tag = (name: string) => plain(item.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "");
    const releaseURL = assertFedMinutesURL(tag("link")), title = tag("title"), published = tag("pubDate");
    if (!/^https:\/\/www\.federalreserve\.gov\/newsevents\/pressreleases\/monetary\d{8}[a-z]\.htm$/.test(releaseURL) ||
        !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(published) || !Number.isFinite(Date.parse(published)) ||
        new Date(published).toUTCString() !== published.replace(/, (\d) /, ", 0$1 "))
      throw new Error("Missing original release identity or publication timestamp");
    const publishedAt = new Date(published).toISOString();
    if (publishedAt > cutoff) throw new Error("Fed minutes were not released by the cutoff");
    const release = await read(releaseURL);
    const heading = plain(release.text.match(/<h3\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "");
    if (heading.replaceAll("–", "-") !== title.replaceAll("–", "-")) throw new Error("Fed catalog and release disagree");
    const [meetingStartedOn, meetingEndedOn] = meeting(heading);
    const released = plain(release.text.match(/<p\b[^>]*class=["']article__time["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
    const dateMatch = released.match(new RegExp(`^(${monthPattern}) (\\d{1,2}), (\\d{4})$`));
    const releasedDate = dateMatch && `${dateMatch[3]}-${String(months.indexOf(dateMatch[1]) + 1).padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}`;
    const releaseClock = plain(release.text.match(/<p\b[^>]*class=["']releaseTime["'][^>]*>([^<]*)/i)?.[1] ?? "").replace(/^For release at /, "");
    if (!releasedDate || publication(releasedDate, releaseClock) !== publishedAt)
      throw new Error("Original Fed release clock is missing or inconsistent");
    const expected = `https://www.federalreserve.gov/monetarypolicy/fomcminutes${meetingEndedOn.replaceAll("-", "")}.htm`;
    const links = [...release.text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*HTML\s*<\/a>/gi)];
    if (links.length !== 1 || assertFedMinutesURL(new URL(links[0][1], releaseURL).href) !== expected)
      throw new Error("Missing original linked minutes document");
    const minutes = await read(expected);
    const text = privateFedMinutesText(minutes.text);
    if (!text.startsWith("Minutes of the Federal Open Market Committee ") || JSON.stringify(meeting(text)) !== JSON.stringify([meetingStartedOn, meetingEndedOn]))
      throw new Error("Minutes identity differs from the original release");
    const stamp = (url: string, capture: Capture): Stamp => ({ url, sha256: capture.sha256, retrievedAt: capture.retrievedAt });
    const source: EditorialSource = { ...base, title: `${base.title} · released ${publishedAt.slice(0, 10)}`, url: releaseURL,
      retrievalUrl: expected, retrievedAt: minutes.retrievedAt, observationDates: [publishedAt.slice(0, 10)], status: "ok",
      data: { publishedAt, releaseClock, meetingStartedOn, meetingEndedOn, cutoff, catalog: stamp(FED_MINUTES_FEED, catalog),
        release: stamp(releaseURL, release), minutes: stamp(expected, minutes), excerpt: text.slice(0, 1200),
        excerptTruncated: text.length > 1200, contentCharacters: text.length, usage: FED_MINUTES_USAGE } satisfies FedMinutesData };
    validateFedMinutesSource(source);
    return source;
  } catch {
    return { ...base, retrievedAt: new Date().toISOString(), observationDates: [], status: "unavailable", data: null,
      error: "The original Fed minutes release, explicit clock and linked document could not be verified. Do not cite this item." };
  }
}

export function attachFedMinutesSource(evidence: EditorialEvidence, source: EditorialSource, assembledAt: string): EditorialEvidence {
  validateFedMinutesSource(source);
  if (!instant(assembledAt) || !instant(evidence.collectedAt) || assembledAt < evidence.collectedAt || source.retrievedAt > assembledAt ||
      evidence.schemaVersion !== 1 || evidence.scope !== "market" || !Array.isArray(evidence.sources) || !Array.isArray(evidence.limitations))
    throw new Error("Invalid Fed minutes editorial assembly");
  const sources = [...evidence.sources.filter(old => old.id !== FED_MINUTES_ID), source];
  if (sources.length > 30) throw new Error("Editorial evidence already fills the 30-source limit; review it before adding Fed minutes");
  return { ...evidence, collectedAt: assembledAt, sources,
    limitations: [...evidence.limitations, "FOMC minutes describe the earlier meeting. Their release timestamp establishes availability; they are editorial context and do not create a forecast vote."] };
}
