import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { publicDate } from "../lib/public-normalization.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { sourceResponse, SourceTransportError } from "../lib/consensus/source-failure.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const board = "https://www.federalreserve.gov/releases/h8/";
const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-h8-small-bank-loans");
const sealPath = resolve(directory, "preregistration.json");
const sourcePath = resolve(directory, "original-releases.json");
const resultPath = resolve(directory, "result.json");
const DAY = 86_400_000;
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const policy = {
  method: "prelaunch-h8-small-bank-business-lending-v1",
  family: "capital",
  instrument: "IWM",
  releaseFrom: "2024-01-05",
  releaseThrough: "2026-10-30",
  outcomeFrom: "2024-01-01",
  outcomeThrough: "2026-11-02",
  archive: board + "releaseDates.json",
  terms: "https://www.federalreserve.gov/disclaimer.htm",
  feature: "100 × log(latest / prior) from successive Wednesday balances shown together on the originally dated H.8 Table 8 line 10. Small domestically chartered commercial banks, seasonally adjusted billions of dollars. Use only the first dated issue with each latest observation.",
  cutoff: "Require the official release date to precede the target date. This conservative rule uses full New York calendar dates and treats the first following exchange session as eligible only when it is a full 6.5-hour session. Feature cut at 07:48 New York. Reject shared target dates.",
  target: "IWM as-traded regular close above its open. Use existing owner-only reviewed Kibot captures. End before the first archived forecast.",
  evaluation: "One feature. Existing purged 60/20/20 historical evaluator with training-only scaling, 120 total / 20 holdout minimum, train base rate and 50/50 baselines, and more than 0.01 Brier improvement against both. No retrospective change to split, dates, feature or instrument.",
  exclusions: "Missing or invalid original releases, stale periods over 16 calendar days, repeated latest periods, missing sessions, shortened sessions, and multiple releases mapped to one target. Do not substitute a rolling vintage.",
};

type Seal = { policy: typeof policy; scriptHash: string; sealedAt: string };
type Release = { day: string; observed: string; priorDay: string; level: number; priorLevel: number; url: string; sha256: string; collectedAt: string };
type Receipt = { scriptHash: string; indexSha256: string; expectedDates: string[]; releases: Release[]; omissions: { day: string; reason: string }[] };

function plain(html: string) {
  return html.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/\s+/g, " ").trim();
}

function isoDay(year: number, month: string, day: string) {
  const index = months.indexOf(month.slice(0, 3).toLowerCase()) + 1;
  const result = `${year}-${String(index).padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (publicDate(result) !== result) throw new Error("Invalid Board date");
  return result;
}

function observationDate(label: string, released: string) {
  const match = /^([A-Za-z]+)\.? (\d{1,2})$/.exec(label);
  if (!match) throw new Error("Missing H.8 Wednesday column");
  const year = Number(released.slice(0, 4));
  const local = isoDay(year, match[1], match[2]);
  const day = local < released ? local : isoDay(year - 1, match[1], match[2]);
  if (new Date(day).getUTCDay() !== 3) throw new Error("H.8 observation is outside a Wednesday");
  return day;
}

function balance(value: string | undefined) {
  if (!value || !/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d$/.test(value)) throw new Error("Unexpected H.8 loan balance precision");
  const amount = Number(value.replaceAll(",", ""));
  if (!(amount > 0)) throw new Error("Nonpositive H.8 loan balance");
  return amount;
}

function extractIssue(day: string, doc: { text: string; url: string; sha256: string; collectedAt: string }): Release {
  const { text, ...provenance } = doc;
  const title = /\bRelease Date:\s*([A-Z][a-z]+) (\d{1,2}), (20\d{2})\b/.exec(plain(text));
  if (!title || isoDay(Number(title[3]), title[1], title[2]) !== day) throw new Error("Archive issue date differs from its index");
  const match = /<table\b[^>]*\bid="h8t8"[^>]*>([\s\S]*?)<\/table>/i.exec(text);
  if (!match || !/Table 8\. Assets and Liabilities of Small Domestically Chartered Commercial Banks in the United States Seasonally adjusted, billions of dollars\.$/.test(plain(text.slice(match.index - 600, match.index))))
    throw new Error("Missing seasonally adjusted small-bank Table 8");
  const rows = [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
    [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => plain(cell)));
  const weeklyColumns = rows[1];
  const loans = rows.filter(row => row[0] === "10" && row[1] === "Commercial and industrial loans");
  if (rows[0].at(-1) !== "Week ending" || weeklyColumns.length < 2 || loans.length !== 1 ||
      loans[0].length !== rows[0].length + weeklyColumns.length)
    throw new Error("Ambiguous H.8 weekly loan columns");
  const observed = observationDate(weeklyColumns.at(-1)!, day);
  const priorDay = observationDate(weeklyColumns.at(-2)!, day);
  if (Date.parse(observed) - Date.parse(priorDay) !== 7 * DAY || Date.parse(day) - Date.parse(observed) > 16 * DAY)
    throw new Error("Stale or nonadjacent H.8 observations");
  return { day, observed, priorDay, level: balance(loans[0].at(-1)), priorLevel: balance(loans[0].at(-2)), ...provenance };
}

async function request(url: string) {
  const response = await sourceResponse(fetch, url, { signal: AbortSignal.timeout(12_000), redirect: "error" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 1_000_000) throw new Error("Unexpected Board document size");
  return { url, text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex"), collectedAt: new Date().toISOString() };
}

async function readIssue(day: string) {
  const url = board + day.replaceAll("-", "") + "/default.htm";
  let doc;
  try { doc = await request(url); }
  catch (error) {
    if (!(error instanceof SourceTransportError)) throw error;
    await sleep(500);
    doc = await request(url);
  }
  return extractIssue(day, doc);
}

async function collect(seal: Seal) {
  const index = await request(policy.archive);
  const years = JSON.parse(index.text) as { Months: { Dates: string[] }[] }[];
  const expectedDates = years.flatMap(year => year.Months.flatMap(month => month.Dates)).map(day => {
    if (!/^(?:19|20)\d{6}$/.test(day)) throw new Error("Unexpected Board index date");
    const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    if (publicDate(date) !== date) throw new Error("Invalid Board index date");
    return date;
  }).sort().filter(day => day >= policy.releaseFrom && day <= policy.releaseThrough);
  if (expectedDates.length < 120 || expectedDates.length > 160 || new Set(expectedDates).size !== expectedDates.length)
    throw new Error("Board archive did not supply the expected bounded release dates");

  const releases: Release[] = [];
  const omissions: Receipt["omissions"] = [];
  for (let start = 0; start < expectedDates.length; start += 3) {
    const batch = expectedDates.slice(start, start + 3);
    const attempts = await Promise.allSettled(batch.map(readIssue));
    for (const [position, attempt] of attempts.entries()) {
      if (attempt.status === "fulfilled") releases.push(attempt.value);
      else omissions.push({ day: batch[position], reason: attempt.reason instanceof Error ? attempt.reason.message : "Unknown issue error" });
    }
    if (!releases.length) throw new Error("No successful opening archive requests: " + JSON.stringify(omissions));
    if (start + 3 < expectedDates.length) await sleep(125);
  }
  const receipt = { scriptHash: seal.scriptHash, indexSha256: index.sha256, expectedDates, releases, omissions };
  await durableJSON(sourcePath, { ...receipt, digest: digest(receipt) }, true);
  console.log(JSON.stringify({ stage: "collected", indexed: expectedDates.length, parsed: releases.length, omissions }));
}

async function evaluate(seal: Seal, outcomeDirectory: string) {
  const envelope = await readResearchReceipt<Receipt & { digest: string }>(sourcePath);
  if (!envelope) throw new Error("Collect the original releases before evaluating");
  const { digest: receiptDigest, ...receipt } = envelope;
  if (receipt.scriptHash !== seal.scriptHash || receiptDigest !== digest(receipt)) throw new Error("Collector receipt differs from sealed study");
  const saved = await readResearchReceipt<{ scriptHash: string; sourceReceipt: string; summary: unknown }>(resultPath);
  if (saved) {
    if (saved.scriptHash !== seal.scriptHash || saved.sourceReceipt !== receiptDigest) throw new Error("Historical result differs from sealed evidence");
    console.log(JSON.stringify(saved.summary));
    return;
  }

  const { history } = await verifyPublicationTree(root);
  const before = history[0]?.issuedAt;
  if (!before || before <= extendedResearchSession(policy.outcomeThrough)!.closeAt)
    throw new Error("Historical study overlaps the first archived forecast");
  const days = extendedResearchSessions(policy.outcomeFrom, policy.outcomeThrough);
  const receipts = await collectResearchPrices(outcomeDirectory, policy.instrument as "IWM", days, { cachedOnly: true });
  const sessions = receipts.flatMap(archive => archive.sessions);
  const byTarget = new Map<string, TrainingRow[]>();
  const omitted = { repeatedPeriod: 0, missingTarget: 0, shortenedSession: 0, sharedTarget: 0 };
  let lastObserved = "";
  for (const issue of receipt.releases) {
    if (issue.observed <= lastObserved) { omitted.repeatedPeriod++; continue; }
    lastObserved = issue.observed;
    const bar = sessions.find(session => session.session > issue.day);
    if (!bar) { omitted.missingTarget++; continue; }
    if (!isFullKibotSession(bar.openAt, bar.closeAt)) { omitted.shortenedSession++; continue; }
    const issuedAt = newYorkTimestamp(bar.session.replaceAll("-", "") + "T074800")!;
    if (!issuedAt || issuedAt >= bar.openAt || bar.closeAt >= before) throw new Error("Invalid cutoff or forecast overlap");
    const row: TrainingRow = { id: `IWM:${bar.session}`, engineVersion: policy.method, issuedAt,
      labelKnownAt: bar.closeAt, features: [100 * Math.log(issue.level / issue.priorLevel)], up: bar.close > bar.open ? 1 : 0 };
    const matches = byTarget.get(bar.session) ?? [];
    matches.push(row);
    byTarget.set(bar.session, matches);
  }
  const rows = [...byTarget.values()].filter(matches => {
    if (matches.length === 1) return true;
    omitted.sharedTarget += matches.length;
    return false;
  }).map(([row]) => row);
  const result = trainCandidate(rows, before);
  const summary = { method: policy.method, indexed: receipt.expectedDates.length, parsed: receipt.releases.length,
    omitted, samples: result.samples, status: result.status, firstTargetAt: rows[0]?.issuedAt,
    lastTargetAt: rows.at(-1)?.issuedAt,
    ...(result.status === "evaluated" ? { split: result.split, candidateBrier: result.candidateBrier,
      baseRateBrier: result.baseRateBrier, coinBrier: result.coinBrier, clearedResearchMargin: result.promoted } : {}),
  };
  await durableJSON(resultPath, { scriptHash: seal.scriptHash, sourceReceipt: receiptDigest,
    forecastBoundary: before, calendar: EXTENDED_CALENDAR_IDS, priceSource: KIBOT_PRICE_CITATION,
    outcomeDigests: receipts.map(({ sha256, priceDigest }) => ({ sha256, priceDigest })), summary, privateResult: result }, true);
  console.log(JSON.stringify(summary));
}

const [stage, outcomeDirectory] = process.argv.slice(2);
const scriptHash = createHash("sha256").update(await readFile(script)).digest("hex");
if (stage === "--seal" && !outcomeDirectory) {
  await durableDirectory(directory, 0o700);
  if ((await stat(directory)).mode & 0o077) throw new Error("Study directory must be private");
  await durableJSON(sealPath, { policy, scriptHash, sealedAt: new Date().toISOString() }, true);
  console.log(JSON.stringify({ stage: "sealed", method: policy.method, scriptHash }));
} else if ((stage === "--collect" && !outcomeDirectory) || (stage === "--evaluate" && outcomeDirectory)) {
  const seal = await readResearchReceipt<Seal>(sealPath);
  if (!seal || seal.scriptHash !== scriptHash || digest(seal.policy) !== digest(policy)) throw new Error("Missing frozen study policy or script changed");
  if (stage === "--collect") {
    if (await readResearchReceipt(sourcePath)) throw new Error("Use the existing original-release receipt for this immutable study");
    await collect(seal);
  } else await evaluate(seal, resolve(outcomeDirectory!));
} else {
  throw new Error("Use --seal, then --collect, then --evaluate <existing private Kibot capture directory>");
}
