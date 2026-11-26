import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicBytes } from "../lib/consensus/collector.ts";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt, type ResearchPriceReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(web, ".consensus/private-spy-fomc-eve");
const method = "prelaunch-spy-fomc-eve-2016-2025-v1";
export const FOMC_EVE_POLICY_SHA = "0e11673f8c782427843e14faf9eab677d6987cfa9c7de02f47526e4ddc42f7c1";
const FED = "https://www.federalreserve.gov";
const scheduleIds = ["20150511a", "20160628a", "20170511b", "20180525a", "20190517a",
  "20200702a", "20210604a", "20220624a", "20230623a", "20240809a"];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const dayOffset = (day: string, count: number) => new Date(Date.parse(day + "T12:00:00Z") + count * 86_400_000).toISOString().slice(0, 10);
const months = "January February March April May June July August September October November December".split(" ");
const weekdays = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");

function meetingDate(year: number, month: string, date: string, weekday: string) {
  const numericMonth = months.indexOf(month) + 1;
  const day = year + "-" + String(numericMonth).padStart(2, "0") + "-" + date.padStart(2, "0");
  const parsed = new Date(day + "T12:00:00Z");
  if (!numericMonth || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ||
      weekdays[parsed.getUTCDay()] !== weekday) throw new Error("Fed meeting date and weekday disagree");
  return day;
}

/** Read the dates in the original dated announcement, including cross-month meetings. */
export function meetingEnds(html: string, year: number, id: string) {
  const release = /<p class="article__time">([A-Za-z]+) (\d{1,2}), (\d{4})<\/p>/i.exec(html);
  if (!release || Number(release[3]) !== year - 1 || release[3] + String(months.indexOf(release[1]) + 1).padStart(2, "0") +
      release[2].padStart(2, "0") !== id.slice(0, 8)) throw new Error("Wrong original Fed schedule release date");
  const rows = Array.from(html.slice(release.index + release[0].length).matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi),
    m => m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&ndash;|–/g, "-").replace(/\s+/g, " ").trim());
  const heading = rows.findIndex(s => s.includes("meeting schedule for " + year) && s.includes("announced"));
  if (heading < 0) throw new Error("Missing announcement of the original meeting schedule");
  const dates: string[] = [];
  for (const line of rows.slice(heading + 1)) {
    if (line === "For " + (year + 1) + ":") break;
    const compact = /^([A-Za-z]+) (\d{1,2})-([A-Za-z]+ )?(\d{1,2})(?:, (\d{4}))? \(([A-Za-z]+)-([A-Za-z]+)\)\*?$/.exec(line);
    const full = /^([A-Za-z]+), ([A-Za-z]+) (\d{1,2}), and ([A-Za-z]+), ([A-Za-z]+) (\d{1,2})$/.exec(line);
    if (!compact && !full) continue;
    if (compact?.[5] && Number(compact[5]) !== year) break;
    const first = compact ? meetingDate(year, compact[1], compact[2], compact[6]) : meetingDate(year, full![2], full![3], full![1]);
    const end = compact ? meetingDate(year, compact[3]?.trim() || compact[1], compact[4], compact[7]) :
      meetingDate(year, full![5], full![6], full![4]);
    if (dayOffset(first, 1) !== end || dates.some(existing => existing >= first)) throw new Error("Invalid or duplicate Fed meeting range");
    dates.push(end);
  }
  if (dates.length !== 8) throw new Error("The original Fed schedule must contain exactly eight meetings in " + year);
  return dates;
}

function priorSession(day: string) {
  for (let distance = 1; distance <= 7; distance++) {
    const prior = dayOffset(day, -distance);
    if (extendedResearchSession(prior)) return prior;
  }
  throw new Error("Missing preceding exchange session");
}
const fullSession = (day: string) => {
  const session = extendedResearchSession(day);
  return !!session && isFullKibotSession(session.openAt, session.closeAt);
};

export function pairedEves(decisions: string[]) {
  const eves = decisions.map(priorSession);
  if (new Set(eves).size !== eves.length) throw new Error("Dates collide on the same treated session");
  return eves.flatMap((eve, i) => {
    const control = dayOffset(eve, -7);
    if (eves.includes(control) || !fullSession(eve) || !fullSession(control)) return [];
    const evePrior = priorSession(eve), controlPrior = priorSession(control);
    return fullSession(evePrior) && fullSession(controlPrior) ? [{ decision: decisions[i], eve, control, evePrior, controlPrior }] : [];
  });
}

type Bar = { open: number; close: number };
export function pairedLabels(pairs: ReturnType<typeof pairedEves>, raw: Map<string, Bar>, splits: Map<string, Bar>) {
  const agree = (day: string) => {
    const a = raw.get(day), b = splits.get(day);
    return a && b && Math.sign(a.close - a.open) === Math.sign(b.close - b.open);
  };
  const rows: TrainingRow[] = [];
  for (const { control, controlPrior, eve, evePrior } of pairs) {
    if (![control, controlPrior, eve, evePrior].every(agree)) continue;
    for (const [day, previous] of [[control, controlPrior], [eve, evePrior]]) {
      const bar = raw.get(day)!, prev = raw.get(previous)!;
      rows.push({ id: "SPY:" + day, issuedAt: newYorkTimestamp(day.replaceAll("-", "") + "T074800")!,
        labelKnownAt: extendedResearchSession(day)!.closeAt, engineVersion: method,
        features: [Math.log(prev.close / prev.open), Number(day === eve)], up: bar.close > bar.open ? 1 : 0 });
    }
  }
  return rows.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

async function checkedOriginal(name: string, url: string, cached: boolean, sealedAt: string) {
  const dir = resolve(directory, "sources");
  await durableDirectory(dir, 0o700);
  const path = resolve(dir, name + ".html"), meta = resolve(dir, name + ".json");
  let receipt = await readResearchReceipt<{ url: string; sha256: string; capturedAt: string }>(meta);
  if (!receipt) {
    if (cached) throw new Error("Missing saved Fed original " + name);
    const { bytes, sha256, retrievedAt } = await publicBytes(url, fetch, 750_000, "text/html");
    try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha(await readFile(path)) !== sha256) throw error;
    }
    receipt = { url, sha256, capturedAt: retrievedAt };
    await durableJSON(meta, receipt, true);
  }
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077 || !info.size || info.size > 750_000 || receipt.url !== url ||
      !Number.isFinite(Date.parse(receipt.capturedAt)) || Date.parse(receipt.capturedAt) < Date.parse(sealedAt) ||
      Date.parse(receipt.capturedAt) > Date.now())
    throw new Error("Invalid private Fed source " + name);
  const bytes = await readFile(path);
  if (sha(bytes) !== receipt.sha256) throw new Error("Changed Fed source body " + name);
  return { html: bytes.toString("utf8"), receipt };
}

async function scheduleEvidence(cached: boolean) {
  const policy = await readFile(resolve(web, "scripts/spy-fomc-eve-policy.json"));
  if (sha(policy) !== FOMC_EVE_POLICY_SHA) throw new Error("Changed FOMC-eve study policy");
  const sealPath = resolve(directory, "registration.json");
  let seal = await readResearchReceipt<{ sha256: string; sealedAt: string }>(sealPath);
  if (!seal) {
    if (cached) throw new Error("Missing FOMC study preregistration");
    seal = { sha256: sha(policy), sealedAt: new Date().toISOString() };
    await durableJSON(sealPath, seal, true);
  }
  if (seal.sha256 !== sha(policy) || !Number.isFinite(Date.parse(seal.sealedAt))) throw new Error("Invalid FOMC study preregistration");
  const currentCalendar = await checkedOriginal("calendar-current", FED + "/monetarypolicy/fomccalendars.htm", cached, seal.sealedAt);
  const years = [];
  for (const id of scheduleIds) {
    const year = Number(id.slice(0, 4)) + 1;
    const schedule = await checkedOriginal("schedule-" + year, FED + "/newsevents/pressreleases/monetary" + id + ".htm", cached, seal.sealedAt);
    const planned = meetingEnds(schedule.html, year, id);
    const calendar = year <= 2020 || !currentCalendar.html.includes('fomcminutes' + year)
      ? await checkedOriginal("calendar-" + year, FED + "/monetarypolicy/fomchistorical" + year + ".htm", cached, seal.sealedAt)
      : currentCalendar;
    const actual = [...new Set(Array.from(calendar.html.matchAll(/href="[^"]*\/fomcminutes(\d{4})(\d{2})(\d{2})\.htm"/gi),
      m => m[1] + "-" + m[2] + "-" + m[3]).filter(day => day.startsWith(String(year))))];
    if (actual.length < 7) throw new Error("Official meeting archive lacks a complete year");
    years.push({ year, planned, datesWithoutMatchingMinutes: planned.filter(day => !actual.includes(day)),
      schedule: schedule.receipt, calendar: calendar.receipt });
  }
  const pairs = pairedEves(years.flatMap(row => row.planned));
  if (pairs.length * 2 < 120) throw new Error("Pre-registered dates cannot reach the 120-target research minimum");
  return { seal, years, pairs };
}

async function pricesFor(pairs: ReturnType<typeof pairedEves>, cached: boolean, splitAdjusted: boolean) {
  const receipts: ResearchPriceReceipt[] = [];
  const needed = pairs.flatMap(p => [p.eve, p.evePrior, p.control, p.controlPrior]);
  for (const year of [...new Set(needed.map(day => day.slice(0, 4)))]) {
    const fullYear = extendedResearchSessions(year + "-01-01", year + "-12-31");
    const shared = resolve(web, ".consensus/private-technical-momentum");
    const name = ["SPY", year, fullYear[0], fullYear.at(-1), splitAdjusted ? "splits" : "raw"].join("-") + ".json";
    const reuseFullYear = Number(year) >= 2022;
    const available = reuseFullYear && await lstat(resolve(shared, name)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false; throw error;
    });
    const dates = reuseFullYear ? fullYear : needed.filter(day => day.startsWith(year));
    const captures = await collectResearchPrices(available ? shared : directory, "SPY", dates,
      { cachedOnly: available || cached, splitAdjusted });
    receipts.push(...captures);
  }
  return receipts;
}

export async function replayFomcEveStudy(cached: boolean, sourcesOnly: boolean, before: string) {
  const evidence = await scheduleEvidence(cached);
  if (evidence.pairs.some(p => extendedResearchSession(p.eve)!.closeAt >= before)) throw new Error("Study overlaps a public forecast");
  const sourceHash = digest(evidence), sourceSummary = { years: evidence.years.length, meetings: evidence.years.flatMap(y => y.planned).length,
    eligiblePairs: evidence.pairs.length, scheduledDatesWithoutMinutes: evidence.years.flatMap(y => y.datesWithoutMatchingMinutes) };
  if (sourcesOnly) return { sourceHash, sourceSummary, result: null };
  const raw = await pricesFor(evidence.pairs, cached, false);
  const split = await pricesFor(evidence.pairs, cached, true);
  const indexed = (list: ResearchPriceReceipt[]) => new Map(list.flatMap(r => r.sessions.map(b => [b.session, b] as const)));
  const rows = pairedLabels(evidence.pairs, indexed(raw), indexed(split));
  const combined = trainCandidate(rows, before), control = trainCandidate(rows.map(row => ({ ...row, features: [row.features[0]] })), before);
  if (combined.status !== "evaluated" || control.status !== "evaluated" || digest(combined.split) !== digest(control.split))
    throw new Error("FOMC paired tests lack the registered chronological sample");
  const heldOut = rows.filter(row => row.issuedAt >= combined.split.testStarts && row.labelKnownAt <= combined.split.testEnds);
  const slope = combined.model.weights[1];
  const margin = Math.min(control.candidateBrier, combined.baseRateBrier, combined.coinBrier) - combined.candidateBrier;
  const summary = { samples: rows.length, heldOut: heldOut.length, heldOutEves: heldOut.filter(row => row.features[1] === 1).length,
    coefficient: slope, modelBrier: combined.candidateBrier, controlBrier: control.candidateBrier,
    baseRateBrier: combined.baseRateBrier, coinBrier: combined.coinBrier, clearsMargin: slope > 0 && margin > 0.01 };
  const result = { method, before, policySha256: FOMC_EVE_POLICY_SHA, sourceHash, priceSource: KIBOT_PRICE_CITATION,
    prices: [...raw, ...split].map(r => ({ from: r.from, through: r.through, sha256: r.sha256, priceDigest: r.priceDigest })),
    rowsDigest: digest(rows), sourceSummary, combined, control, summary };
  const path = resolve(directory, "study.json"), saved = await readResearchReceipt<typeof result>(path);
  if (saved && digest(saved) !== digest(result)) throw new Error("Saved FOMC study differs from the source and price replay");
  if (!saved) {
    if (cached) throw new Error("Missing initial FOMC study receipt");
    await durableJSON(path, result, true);
  }
  return { result, sourceSummary, sourceHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some(arg => !["--sources-only", "--cached-only"].includes(arg)))
    throw new Error("Usage: consensus:research-fomc-eve [--sources-only] [--cached-only]");
  const { history } = await verifyPublicationTree(web);
  await durableDirectory(directory, 0o700);
  const lock = resolve(directory, "capture.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    const report = await replayFomcEveStudy(args.includes("--cached-only"), args.includes("--sources-only"), history[0].issuedAt);
    console.log(JSON.stringify({ ...report.sourceSummary, sourceHash: report.sourceHash, ...(report.result?.summary ?? {}) }));
  } finally { await rmdir(lock); }
}
