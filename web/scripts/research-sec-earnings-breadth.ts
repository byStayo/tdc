import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { newYorkDate, newYorkTimestamp } from "../lib/consensus/time.ts";
import { fetchText } from "./collect-editorial-evidence.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-sec-earnings-breadth");
const file = (name: "seal" | "source" | "result") => resolve(directory, name + ".json");
const source = "https://data.sec.gov";
const portfolio = "https://www.sec.gov/Archives/edgar/data/884394/000175272423267659/primary_doc.xml";
const identity = "https://www.sec.gov/files/company_tickers.json";
const dayMs = 86_400_000;
const policy = {
  method: "prelaunch-sec-spy-same-day-quarterly-eps-breadth-v1",
  instrument: "SPY" as const,
  from: "2024-01-01", through: "2026-11-02",
  universe: "The 100 largest equity issuer groups by market value in SPY's September 30, 2023 N-PORT, filed November 28, 2023. Combine classes by LEI, use exact SEC legal-name matches and the declared issuer aliases. Fixed membership throughout.",
  releases: "Non-amended EDGAR 10-Q with original accessions and three-month nondimensional US GAAP diluted EPS in USD/share, plus a unique original Item 2.02 Form 8-K accepted on the same New York date. Require the EPS period to end on the 10-Q report date and compare with that accession's same-quarter prior-year comparative. No fourth-quarter estimates or interpolations.",
  feature: "Equal-weight signed breadth of current less prior-year diluted GAAP EPS. Average issuer signs on the same target session. Exclude ambiguous duplicate issuer contributions. The growth observation does not measure a consensus surprise.",
  timing: "Assign to the first later scheduled exchange session following both records' acceptance and filing dates. Require a full session and a 07:48 New York cutoff. End before the first archived forecast.",
  minimum: 121,
  evaluation: "Open existing private Kibot SPY comparisons only after at least 121 distinct eligible sessions. Fixed purged 60/20/20 split with the training up-rate and 50/50 baselines, and a greater than 0.01 Brier margin against both.",
};

const aliases: Record<string, string> = {
  J3WHBG0MTS7O8ZVMDC91: "XOM", "29DX7H14B9S6O3FD6V18": "COST", UE2136O97NLB5BYP9H04: "MCD",
  "9DJT3UXIJIZJI4WXO774": "BAC", S4BKK9OTCEWQ3YHPFM11: "DHR", PBLD0EJDB5FWOLXP3B76: "WFC",
  H1J8DDZKZP6H7RWC0H53: "QCOM", WAFCR4OKGSC504WU3E95: "LOW", "41BNNE1AFPNAZELZ6K07": "AMAT",
  V167QI9I69W364E2DY52: "TJX", "549300XMP3KDCKJXIU47": "MRSH", "54930015RAQRRZ5ZGJ91": "VRTX",
  "213800ZUA17OK3QLGM62": "SLB", "549300VSGCJ7E698NM85": "SCHW", "529900TACNVLY9DCR586": "PGR",
  "5493006ORUSIL88JOE18": "AMT",
};
type Ticker = { cik_str: number; ticker: string; title: string };
type Member = { cik: number; name: string; lei: string };
type Filing = { acc: string; filed: string; accepted: string; report: string; form: string; items: string };
type Catalog = { accessionNumber: string[]; filingDate: string[]; acceptanceDateTime: string[]; reportDate: string[]; form: string[]; items: string[] };
type Fact = { accn: string; start: string; end: string; filed: string; form: string; val: number };
type Event = { issuer: number; report: Filing; release: Filing; level: number; comparison: number; target: string };
type SourceReceipt = {
  seal: string; portfolioHash: string; mappingHash: string; issuers: Member[]; events: Event[];
  checks: { issuer: number; catalogs: string[]; facts: string | null; forms: number; sameDay: number; matched: number }[];
};

function normalized(name: string) {
  return name.toLowerCase().replaceAll("&amp;", "&").replaceAll("&", " and ").replace(/[^a-z0-9]/g, " ")
    .trim().split(/\s+/).filter(word => !["the", "co", "company", "corp", "corporation", "inc", "plc", "limited", "ltd", "nv", "llc"].includes(word)).join(" ");
}

function topHoldings(xml: string, securities: Ticker[]) {
  const tag = (body: string, key: string) => new RegExp(`<${key}>([^<]*)<\/${key}>`).exec(body)?.[1] ?? "";
  if (tag(xml, "regCik") !== "0000884394" || tag(xml, "repPdDate") !== "2023-09-30") throw new Error("Unexpected SPY holdings vintage");
  const groups = new Map<string, { name: string; lei: string; value: number }>();
  for (const [, holding] of xml.matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/g)) {
    if (tag(holding, "assetCat") !== "EC") continue;
    const name = tag(holding, "name"), lei = tag(holding, "lei"), value = Number(tag(holding, "valUSD"));
    if (!name || !Number.isFinite(value) || value <= 0) continue;
    const key = /^[A-Z0-9]{20}$/.test(lei) ? lei : normalized(name);
    const current = groups.get(key);
    if (current) current.value += value;
    else groups.set(key, { name, lei, value });
  }
  if (groups.size < 480 || groups.size > 520) throw new Error("Incomplete or unexpected holdings universe");
  const members = [...groups.values()].sort((a, b) => b.value - a.value).slice(0, 100).map(({ name, lei }): Member => {
    const alias = aliases[lei];
    const ids = [...new Set(securities.filter(row => alias ? row.ticker === alias : normalized(row.title) === normalized(name)).map(row => row.cik_str))];
    if (ids.length !== 1 || !Number.isSafeInteger(ids[0])) throw new Error(`Unresolved SEC identifier for ${name}`);
    return { name, lei, cik: ids[0] };
  });
  if (new Set(members.map(row => row.cik)).size !== members.length) throw new Error("Ambiguous duplicate fund issuer mapping");
  return members;
}

async function read(url: string) {
  // All study requests are serialized and spaced through the product's bounded EDGAR client.
  await sleep(200);
  return fetchText(url, fetch);
}

function filings(table: Catalog) {
  const keys = ["accessionNumber", "filingDate", "acceptanceDateTime", "reportDate", "form", "items"] as const;
  if (!keys.every(key => Array.isArray(table[key]) && table[key].length === table.form?.length)) throw new Error("SEC submission columns differ in size");
  const result: Filing[] = [];
  for (const [i, form] of table.form.entries()) {
    if (form !== "10-Q" && !(form === "8-K" && table.items[i].split(/[,\s]+/).includes("2.02"))) continue;
    const filed = table.filingDate[i];
    if (filed < policy.from || filed > policy.through) continue;
    const acc = table.accessionNumber[i], report = table.reportDate[i], acceptedAt = new Date(table.acceptanceDateTime[i]);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(acc) || publicDate(filed) !== filed || publicDate(report) !== report || !Number.isFinite(acceptedAt.getTime()))
      throw new Error("Invalid original SEC accession clocks");
    const accepted = acceptedAt.toISOString();
    if (newYorkDate(accepted) > filed || report > filed) throw new Error("Inconsistent filing or fiscal date");
    result.push({ form, acc, filed, accepted, report, items: table.items[i] });
  }
  return result;
}

function comparableEPS(report: Filing, facts: Fact[]) {
  const dates = (row: Fact) => Date.parse(row.end) - Date.parse(row.start);
  const series = facts.filter(row => row.form === "10-Q" && row.accn === report.acc && row.filed === report.filed &&
    publicDate(row.start) === row.start && publicDate(row.end) === row.end && Number.isFinite(row.val) &&
    dates(row) >= 80 * dayMs && dates(row) <= 103 * dayMs);
  const latest = series.filter(row => row.end === report.report);
  if (new Set(latest.map(row => [row.start, row.val].join(":"))).size !== 1) return null;
  const current = latest[0];
  const prior = series.filter(row => ["start", "end"].every(key =>
    Math.abs((Date.parse(current[key as "start" | "end"]) - Date.parse(row[key as "start" | "end"])) / dayMs - 365) <= 10));
  if (new Set(prior.map(row => [row.start, row.end, row.val].join(":"))).size !== 1) return null;
  return { level: current.val, comparison: prior[0].val };
}

async function sourceEvents(member: Member, days: string[]) {
  const cik = String(member.cik).padStart(10, "0");
  const first = await read(`${source}/submissions/CIK${cik}.json`);
  const info = JSON.parse(first.text) as { cik: string; filings: { recent: Catalog; files: { name: string; filingFrom: string; filingTo: string }[] } };
  if (Number(info.cik) !== member.cik || !Array.isArray(info.filings?.files)) throw new Error("SEC filing catalog has a different issuer");
  const all = filings(info.filings.recent);
  const documents = [first.sha256];
  const older = info.filings.files.filter(item => item.filingTo >= policy.from && item.filingFrom <= policy.through);
  if (older.length > 6) throw new Error("Submission comparison exceeds per-issuer history limit");
  for (const item of older) {
    if (!new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(item.name)) throw new Error("Unexpected SEC historical submission shard");
    const archive = await read(`${source}/submissions/${item.name}`);
    documents.push(archive.sha256);
    all.push(...filings(JSON.parse(archive.text)));
  }
  if (new Set(all.map(doc => doc.acc)).size !== all.length) throw new Error("Duplicate SEC reference within issuer catalog");
  const reports = all.filter(doc => doc.form === "10-Q").sort((a, b) => a.accepted.localeCompare(b.accepted));
  const latestReleases = all.filter(doc => doc.form === "8-K");
  const distinctPeriods = new Set<string>();
  const candidates = reports.flatMap(report => {
    if (distinctPeriods.has(report.report)) return [];
    distinctPeriods.add(report.report);
    const sameDay = latestReleases.filter(release => newYorkDate(release.accepted) === newYorkDate(report.accepted));
    if (sameDay.length !== 1) return [];
    const release = sameDay[0];
    const knownThrough = [report.filed, release.filed].sort().at(-1)!;
    const target = days.find(day => day > knownThrough);
    if (!target) return [];
    const bar = extendedResearchSession(target)!;
    return isFullKibotSession(bar.openAt, bar.closeAt) ? [{ report, release, target }] : [];
  });
  const check = { issuer: member.cik, catalogs: documents, facts: null as string | null, forms: reports.length, sameDay: candidates.length, matched: 0 };
  if (!candidates.length) return { check, events: [] as Event[] };
  const receipt = await read(`${source}/api/xbrl/companyconcept/CIK${cik}/us-gaap/EarningsPerShareDiluted.json`);
  const concept = JSON.parse(receipt.text) as { cik: number; taxonomy: string; tag: string; units: Record<string, Fact[]> };
  const facts = concept.units?.["USD/shares"];
  if (Number(concept.cik) !== member.cik || concept.taxonomy !== "us-gaap" || concept.tag !== "EarningsPerShareDiluted" || !Array.isArray(facts))
    throw new Error("Missing standardized USD/share diluted EPS facts for this issuer");
  check.facts = receipt.sha256;
  const events = candidates.flatMap(item => {
    const pair = comparableEPS(item.report, facts);
    return pair ? [{ issuer: member.cik, ...item, ...pair }] : [];
  });
  check.matched = events.length;
  return { events, check };
}

function daily(sourceReceipt: SourceReceipt) {
  const byDate = new Map<string, Event[]>();
  for (const event of sourceReceipt.events) {
    const values = byDate.get(event.target) ?? [];
    values.push(event);
    byDate.set(event.target, values);
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).flatMap(([date, events]) => {
    const unique = events.filter(event => events.filter(item => item.issuer === event.issuer).length === 1);
    if (!unique.length) return [];
    return [{ date, count: unique.length, breadth: unique.reduce((sum, e) => sum + Math.sign(e.level - e.comparison), 0) / unique.length }];
  });
}

async function collect(seal: string) {
  const holdings = await read(portfolio);
  const registry = await read(identity);
  const issuers = topHoldings(holdings.text, Object.values(JSON.parse(registry.text)) as Ticker[]);
  const days = extendedResearchSessions(policy.from, policy.through);
  const events: Event[] = [], checks: SourceReceipt["checks"] = [];
  const missing: { issuer: number; reason: string }[] = [];
  for (const member of issuers) {
    try {
      const got = await sourceEvents(member, days);
      checks.push(got.check);
      events.push(...got.events);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown source error";
      if (/HTTP (403|429)/.test(reason)) throw new Error("SEC access blocked or throttled: " + reason);
      missing.push({ issuer: member.cik, reason });
    }
  }
  const receipt = { seal, portfolioHash: holdings.sha256, mappingHash: registry.sha256, issuers, events, checks, missing };
  await durableJSON(file("source"), { receipt, hash: digest(receipt) }, true);
  const rows = daily(receipt);
  console.log(JSON.stringify({ originalReports: events.length, coveredIssuers: new Set(events.map(row => row.issuer)).size,
    distinctSessions: rows.length, firstSession: rows.at(0)?.date, lastSession: rows.at(-1)?.date, missing,
    reviewedForms: checks.reduce((n, r) => n + r.forms, 0), coincidentFilings: checks.reduce((n, r) => n + r.sameDay, 0) }));
}

async function evaluate(seal: string, prices: string) {
  const sources = await readResearchReceipt<{ receipt: SourceReceipt; hash: string }>(file("source"));
  if (!sources || sources.receipt.seal !== seal || sources.hash !== digest(sources.receipt)) throw new Error("Missing verified original SEC cohort");
  const dates = daily(sources.receipt);
  if (dates.length < policy.minimum) {
    console.log(JSON.stringify({ status: "insufficient_distinct_original_dates", sessions: dates.length, required: policy.minimum }));
    return;
  }
  const existing = await readResearchReceipt<{ evidence: string; summary: unknown }>(file("result"));
  if (existing) {
    if (existing.evidence !== sources.hash) throw new Error("Saved result does not match the frozen cohort");
    console.log(JSON.stringify(existing.summary));
    return;
  }
  const { history } = await verifyPublicationTree(root);
  const before = history[0]?.issuedAt;
  if (!before || before <= extendedResearchSession(policy.through)!.closeAt) throw new Error("Study overlaps the first public edition");
  const receipts = await collectResearchPrices(prices, policy.instrument, extendedResearchSessions(policy.from, policy.through), { cachedOnly: true });
  const bars = new Map(receipts.flatMap(r => r.sessions).map(bar => [bar.session, bar]));
  const rows: TrainingRow[] = dates.map(({ date, breadth }) => {
    const bar = bars.get(date);
    if (!bar || !isFullKibotSession(bar.openAt, bar.closeAt) || bar.closeAt >= before) throw new Error("Invalid fixed SPY outcome cohort");
    return { id: `SPY:${date}`, engineVersion: policy.method, issuedAt: newYorkTimestamp(date.replaceAll("-", "") + "T074800")!,
      labelKnownAt: bar.closeAt, features: [breadth], up: bar.close > bar.open ? 1 : 0 };
  });
  const result = trainCandidate(rows, before);
  const summary = { status: result.status, method: policy.method, samples: result.samples,
    firstDate: dates.at(0)?.date, lastDate: dates.at(-1)?.date,
    ...(result.status === "evaluated" ? { split: result.split, candidateBrier: result.candidateBrier,
      baseRateBrier: result.baseRateBrier, coinBrier: result.coinBrier, clearedResearchMargin: result.promoted } : {}) };
  await durableJSON(file("result"), { evidence: sources.hash, before, result, summary, calendar: EXTENDED_CALENDAR_IDS,
    priceSource: KIBOT_PRICE_CITATION, priceHashes: receipts.map(r => r.sha256) }, true);
  console.log(JSON.stringify(summary));
}

const [stage, prices] = process.argv.slice(2);
const hash = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
if (stage === "--seal" && !prices) {
  await durableDirectory(directory, 0o700);
  await durableJSON(file("seal"), { hash, policy, sealedAt: new Date().toISOString() }, true);
  console.log(JSON.stringify({ sealed: hash, method: policy.method }));
} else if ((stage === "--collect" && !prices) || (stage === "--evaluate" && prices)) {
  const seal = await readResearchReceipt<{ hash: string; policy: typeof policy }>(file("seal"));
  if (!seal || seal.hash !== hash || digest(seal.policy) !== digest(policy)) throw new Error("Seal the fixed study policy before loading sources or outcomes");
  if (stage === "--collect") {
    if (await readResearchReceipt(file("source"))) throw new Error("Use the frozen original source receipt");
    await collect(hash);
  } else await evaluate(hash, resolve(prices!));
} else throw new Error("Use --seal, then --collect, then --evaluate <existing private Kibot directory>");
