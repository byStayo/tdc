import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import type { PublicDocument } from "../lib/consensus/calendars.ts";
import { EXTENDED_CALENDAR_IDS, extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { ONS_CODES, ONS_ORIGIN, onsHistoricalClock, onsPath, onsInstant, pairOnsRates, parseOnsSeries,
  priorOnsMonth, type OnsCode, type OnsPair, type OnsReading } from "../lib/consensus/ons-inflation.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

export const web = fileURLToPath(new URL("../", import.meta.url));
export const directory = resolve(web, ".consensus/private-ons-services-tlt/v1");
export const registration = "851c11d510dbb61a646aa46d5e2ca0d982e5b7f3adbc62594993de2bc83cb8af";
export const before = "2026-11-03T06:28:30.460Z";
export const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
type Original = PublicDocument & { url: string };
const timingUrl = ONS_ORIGIN + "/aboutus/transparencyandgovernance/freedomofinformationfoi/historicalukcpifirstreleasedatesandhistoricalconsensusinflationforecasts2004to2025";

async function original(name: string, url: string): Promise<Original> {
  const root = resolve(directory, "source");
  const meta = JSON.parse(await readFile(resolve(root, name + ".json"), "utf8"));
  if (meta.url !== url || !/^[a-f0-9]{64}$/.test(meta.sha256) || !onsInstant(meta.retrievedAt) ||
      !Number.isSafeInteger(meta.bytes) || meta.bytes <= 0 || meta.bytes > 1_500_000)
    throw Error("Invalid ONS original receipt for " + name);
  const bytes = gunzipSync(await readFile(resolve(root, meta.sha256 + ".gz")), {maxOutputLength: 1_500_000});
  if (bytes.length !== meta.bytes || sha(bytes) !== meta.sha256) throw Error("ONS original checksum differs for " + name);
  return { url, retrievedAt: meta.retrievedAt, sha256: meta.sha256, text: bytes.toString("utf8") };
}

async function firstMonths(code: OnsCode) {
  const path = onsPath(code);
  const catalog = await original(code + "-catalog", ONS_ORIGIN + path + "/data");
  const index = parseOnsSeries(catalog, code, path);
  const first = new Map<string, OnsReading | null>();
  let lastPeriod = "";
  for (const [i, v] of index.versions.entries()) {
    const archived = await original(code + "-" + v.label, ONS_ORIGIN + v.uri + "/data");
    const result = parseOnsSeries(archived, code, v.uri);
    if (result.versions.length !== i || result.versions.some((p, n) => p.uri !== index.versions[n].uri ||
        p.updateDate !== index.versions[n].updateDate)) throw Error("ONS original disagrees with its predecessor chain");
    if (result.period < lastPeriod) throw Error("ONS series rewound a monthly publication");
    if (!first.has(result.period)) {
      first.set(result.period, result.reading);
    }
    lastPeriod = result.period;
    if (v.updateDate >= before) break;
  }
  return { first, catalogue: catalog.sha256 };
}

export async function onsFeatures() {
  const stored = await readFile(resolve(directory, "registration.json"));
  if (sha(stored) !== registration || sha(await readFile(resolve(web,"scripts/ons-services-study-policy.json"))) !== registration)
    throw Error("ONS pre-price registration differs");
  const clock = await original("timing", timingUrl);
  if (!["25 March 2020","9.30am","7am"].every(s => clock.text.includes(s))) throw Error("Unconfirmed prior ONS release convention");
  const [h, s] = await Promise.all(ONS_CODES.map(firstMonths));
  const pairs = new Map<string, OnsPair>();
  type Bulletin = { period: string; headline: number; services: number; releaseAt: string; calendarSha256: string;
    bulletinSha256: string; url: string; calendarUrl: string };
  const bulletins: {accepted: Record<string, Bulletin>; excluded: Record<string, string>} = JSON.parse(
    execFileSync("python3", ["-B",resolve(web, "scripts/collect-ons-cpi-vintages.py"), "--bulletin-priors"], { encoding:"utf8" }));
  const priors = new Map<string, {period:string; headline:OnsReading; services:OnsReading; availableAt:string; bulletin:Bulletin}>();
  const excluded: { period: string; reason: string }[] = [];
  const eligible: { target: string; period: string; decision: string; openAt: string; closeAt: string;
    headlineChange: number; servicesChange: number; current: OnsPair;
    previous: OnsPair | {period:string; headline:OnsReading; services:OnsReading; availableAt:string; bulletin:Bulletin} }[] = [];
  const periods = [...new Set([...h.first.keys(),...s.first.keys()])].sort();
  for (const period of periods) {
    const headline = h.first.get(period), services = s.first.get(period);
    if (!headline || !services) {
      excluded.push({period,reason:"Missing verified introduction for one or both originals"}); continue;
    }
    const releaseAt = onsHistoricalClock(headline.nativeDay);
    try {
      pairs.set(period, pairOnsRates(headline, services, releaseAt, clock.sha256));
    } catch (error) {
      const bulletin = bulletins.accepted[period];
      if (bulletin && bulletin.period === period && headline.rate === bulletin.headline && services.rate === bulletin.services) {
        const availableAt = [bulletin.releaseAt, ...[headline,services].flatMap(r => [r.nativeDate,r.observationUpdate,r.introducedAt])].sort().at(-1)!;
        priors.set(period,{period,headline,services,availableAt,bulletin});
      }
      excluded.push({period, reason: error instanceof Error ? error.message : "Inconsistent release clocks"}); continue;
    }
    const current = pairs.get(period)!;
    const day = headline.nativeDay;
    if (day < "2016-01-01" || current.releaseAt >= before) continue;
    const prior = priorOnsMonth(period);
    const previous = pairs.get(prior) ?? priors.get(prior);
    const decision = newYorkTimestamp(day.replaceAll("-", "") + "T074800")!;
    const session = extendedResearchSession(day);
    if (!previous || previous.availableAt >= current.releaseAt) {
      excluded.push({period, reason:"Missing preceding first monthly release"}); continue;
    }
    if (!session || Date.parse(session.closeAt) - Date.parse(session.openAt) !== 390 * 60_000) {
      excluded.push({period,reason:"No full US trading session"}); continue;
    }
    if (current.availableAt >= decision || !(decision < session.openAt && session.closeAt < before)) {
      excluded.push({period,reason:"Release outside the registered cutoff"}); continue;
    }
    const delta = (n: number, p: number) => (Math.round(n*10) - Math.round(p*10))/10;
    eligible.push({target:day,period,decision,openAt:session.openAt,closeAt:session.closeAt,
      headlineChange: delta(headline.rate,previous.headline.rate), servicesChange:delta(services.rate,previous.services.rate), current, previous});
  }
  if (new Set(eligible.map(r => r.target)).size !== eligible.length) throw Error("Duplicated UK release target");
  return { registration, before, catalogues:[h.catalogue,s.catalogue], clock:clock.sha256, exchangeCalendars:EXTENDED_CALENDAR_IDS,
    periods:periods.length, bulletinPriors: [...priors.keys()], unverifiedBulletins: bulletins.excluded, eligible, excluded };
}

export async function sealedOnsFeatures(seal = false) {
  const result = await onsFeatures(), file = resolve(directory,"features-final.json");
  const expected = JSON.stringify(result, null, 2) + "\n";
  if (seal) {
    await durableDirectory(directory, 0o700);
    try { await durableJSON(file, result, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if ((await readFile(file, "utf8")) !== expected) throw Error("ONS pre-price feature selection differs from its seal");
  return { result, featureSeal: sha(expected) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--seal")) throw Error("Use --seal for the first feature capture");
  const {result,featureSeal} = await sealedOnsFeatures(args[0] === "--seal");
  console.log(JSON.stringify({featureSeal, periods:result.periods, eligible:result.eligible.length, exclusions:result.excluded}));
}
