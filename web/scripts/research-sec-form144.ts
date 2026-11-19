import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { normalizeCik, publicDate, secDocumentUrl } from "../lib/public-normalization.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { publicBytes } from "../lib/consensus/collector.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { REVIEWED_ISSUERS } from "../lib/consensus/issuer-context.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkDate, newYorkTimestamp } from "../lib/consensus/time.ts";

const METHOD = "prelaunch-sec-form144-disclosure-breadth-v1";
const FROM = "2024-01-01", FIRST_PRICE = "2024-01-02", LAST_TARGET = "2026-11-02";
const DAY_MS = 86_400_000;
const CATALOG = "https://data.sec.gov/submissions/";
const ISSUERS = { ...REVIEWED_ISSUERS, PLTR: { cik: "1321655" }, JPM: { cik: "19617" }, WMT: { cik: "104169" } };
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-form144");

type Form = "144" | "144/A" | "4";
type Filing = { ticker: string; cik: string; accession: string; kind: Form; filingDate: string; acceptedAt: string; document: string };
type Proof = { url: string; text: string; sha256: string; retrievedAt: string };
type HistoryPart = { name: string; filingFrom: string; filingTo: string };
type Notice = { cik: string; noticeDate: string; planAdoptionDates: string[];
  proposals: { security: string; approxSaleDate: string; shares: number; marketValue: number }[] };

const day = (value: unknown) => typeof value === "string" && publicDate(value) === value;
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function filingBreadth(filings: Pick<Filing, "ticker" | "kind" | "acceptedAt">[], previous: string, cutoff: string) {
  const proposals = new Set<string>(), transactions = new Set<string>();
  for (const row of filings) {
    if (row.acceptedAt < previous || row.acceptedAt >= cutoff) continue;
    if (row.kind === "144") proposals.add(row.ticker);
    if (row.kind === "4") transactions.add(row.ticker);
  }
  return { proposals: proposals.size, transactions: transactions.size };
}

function columns(page: Record<string, unknown>) {
  const values = ["accessionNumber", "filingDate", "acceptanceDateTime", "form", "primaryDocument"].map(key => page[key]);
  if (!values.every(Array.isArray) || !values[0].length || !values.every(column => column.length === values[0].length))
    throw new Error("Missing EDGAR submissions columns");
  return values;
}

function extract(ticker: string, cik: string, page: Record<string, unknown>, from: string, cutoff: string): Filing[] {
  const [accessions, dates, accepted, forms, documents] = columns(page);
  return accessions.flatMap((accession, index) => {
    const kind = forms[index];
    if (kind !== "144" && kind !== "144/A" && kind !== "4") return [];
    const filingDate = dates[index], acceptedAt = accepted[index], path = documents[index];
    if (!day(filingDate)) throw new Error(`Invalid EDGAR filing date for ${ticker}`);
    if (filingDate < from || filingDate > newYorkDate(cutoff)) return [];
    const original = typeof path === "string" ? path.split("/").at(-1) : null;
    const document = secDocumentUrl(cik, accession, original);
    if (typeof accession !== "string" || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || !document || !instant(acceptedAt) ||
        (kind === "144" && !document.endsWith(".xml")))
      throw new Error(`Invalid EDGAR disclosure metadata for ${ticker}`);
    return acceptedAt < cutoff ? [{ ticker, cik, accession, kind, filingDate, acceptedAt, document }] : [];
  });
}

async function sec(url: string): Promise<Proof> {
  await setTimeout(180);
  const catalog = /^https:\/\/data\.sec\.gov\/submissions\/CIK\d{10}(?:-submissions-\d+)?\.json$/.test(url);
  const { bytes, sha256, retrievedAt } = await publicBytes(url, fetch, catalog ? 8_000_000 : 250_000)
    .catch((error: Error) => { throw new Error(`${url} returned ${error.message}`, { cause: error }); });
  return { url, text: bytes.toString("utf8"), sha256, retrievedAt };
}

const provenance = ({ url, sha256, retrievedAt }: Proof) => ({ url, sha256, retrievedAt });

async function filingPanel(from: string, cutoff: string) {
  const filings = new Map<string, Filing>(), sources = [];
  for (const [ticker, { cik: localId }] of Object.entries(ISSUERS)) {
    const cik = normalizeCik(localId)!;
    const receipt = await sec(`${CATALOG}CIK${cik}.json`);
    const data = JSON.parse(receipt.text) as { cik: string; filings: { recent: Record<string, unknown>; files: HistoryPart[] } };
    if (normalizeCik(data.cik) !== cik || !data.filings?.recent || !Array.isArray(data.filings.files))
      throw new Error(`Missing SEC submissions for ${ticker}`);
    sources.push({ ticker, ...provenance(receipt) });
    let coveredFrom = false;
    const addPage = (page: Record<string, unknown>) => {
      coveredFrom ||= columns(page)[1].some(date => day(date) && date <= from);
      for (const filing of extract(ticker, cik, page, from, cutoff)) {
        const key = `${ticker}:${filing.accession}`;
        const prior = filings.get(key);
        if (prior && digest(prior) !== digest(filing)) throw new Error(`Conflicting SEC metadata for ${filing.accession}`);
        filings.set(key, filing);
      }
    };
    addPage(data.filings.recent);
    const history = data.filings.files.filter(file => day(file.filingFrom) && day(file.filingTo) &&
      file.filingTo >= from && file.filingFrom <= newYorkDate(cutoff));
    if (history.length > 24) throw new Error(`Unexpected history breadth for ${ticker}`);
    for (const file of history) {
      if (!new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(file.name))
        throw new Error(`Unexpected SEC historical catalog for ${ticker}`);
      const older = await sec(CATALOG + file.name);
      sources.push({ ticker, ...provenance(older) });
      addPage(JSON.parse(older.text));
    }
    if (!coveredFrom)
      throw new Error(`Saved disclosure range is too short for ${ticker}`);
  }
  return { sources, filings: [...filings.values()].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt)) };
}

async function original(filing: Filing) {
  const path = resolve(directory, "original", `${filing.cik}-${filing.accession}.json`);
  const saved = await readResearchReceipt<Proof>(path);
  const doc = saved ?? await sec(filing.document);
  if (doc.url !== filing.document || !instant(doc.retrievedAt) || doc.retrievedAt < filing.acceptedAt ||
      createHash("sha256").update(doc.text).digest("hex") !== doc.sha256)
    throw new Error(`Original Form 144 capture changed for ${filing.accession}`);
  return { filing, path, doc, saved: Boolean(saved) };
}

async function collectCurrent() {
  const cutoff = new Date().toISOString();
  const from = new Date(Date.parse(newYorkDate(cutoff)) - 10 * DAY_MS).toISOString().slice(0, 10);
  const { filings, sources } = await filingPanel(from, cutoff);
  const proposals = filings.filter(row => row.kind === "144");
  if (proposals.length > 80) throw new Error("Form 144 collection exceeds the reviewed recent document bound");
  const originals = [];
  for (const filing of proposals) originals.push(await original(filing));
  const parsed: Notice[] = JSON.parse(execFileSync("python3", ["-B", resolve(root, "scripts/parse-sec-form144.py")],
    { input: JSON.stringify(originals.map(row => row.doc.text)), encoding: "utf8", timeout: 8_000, maxBuffer: 400_000 }));
  if (parsed.length !== originals.length) throw new Error("Incomplete Form 144 parsing result");
  const notices = originals.map(({ filing, doc }, index) => {
    const item = parsed[index];
    if (!item || item.cik !== filing.cik || item.noticeDate > filing.filingDate)
      throw new Error(`Form 144 document does not match ${filing.accession}`);
    return { ...filing, ...item, source: provenance(doc) };
  });
  for (const { filing, path, doc, saved } of originals) {
    if (saved) continue;
    try { await durableJSON(path, doc, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await original(filing);
      if (concurrent.doc.sha256 !== doc.sha256) throw new Error(`Conflicting Form 144 capture for ${filing.accession}`);
    }
  }
  const output = resolve(directory, "captures", cutoff.replace(/[:.]/g, "-") + ".json");
  const amended = filings.filter(row => row.kind === "144/A");
  await durableJSON(output, { cutoff, from, sources, notices, amended }, true);
  return { status: "collected_private_context", cutoff, from, output, issuers: Object.keys(ISSUERS).length,
    notices: notices.length, planned: notices.filter(item => item.planAdoptionDates.length).length, amendments: amended.length };
}

function clock(day: string) {
  return newYorkTimestamp(day.replaceAll("-", "") + "T080000")!;
}

async function benchmark() {
  const { history } = await verifyPublicationTree(root);
  const before = history[0]?.issuedAt;
  if (!before || before <= extendedResearchSession(LAST_TARGET)!.closeAt)
    throw new Error("Form 144 experiment overlaps the public forecast archive");
  const output = resolve(directory, METHOD + ".json");
  const saved = await readResearchReceipt<{ method: string; before: string; summary: unknown }>(output);
  if (saved) {
    if (saved.method !== METHOD || saved.before !== before) throw new Error("Form 144 study has a different archive boundary");
    return { status: "reused", summary: saved.summary };
  }
  const { filings, sources } = await filingPanel(FROM, before);
  const sessions = extendedResearchSessions(FIRST_PRICE, LAST_TARGET);
  const targets = sessions.slice(1).flatMap((day, i) => {
    const previous = sessions[i], issuedAt = clock(day);
    const current = extendedResearchSession(day)!, prior = extendedResearchSession(previous)!;
    if (![current, prior].every(session => isFullKibotSession(session.openAt, session.closeAt))) return [];
    return [{ day, previous, issuedAt, ...filingBreadth(filings, clock(previous), issuedAt) }];
  });
  const cohorts = [];
  for (const instrument of ["SPY", "QQQ", "IWM", "DIA"] as const) {
    const evidence = await collectResearchPrices(resolve(root, ".consensus/private-technical-momentum"), instrument, sessions,
      { cachedOnly: true });
    const prices = new Map(evidence.flatMap(receipt => receipt.sessions.map(row => [row.session, row] as const)));
    const rows = targets.map((target): TrainingRow => {
      const bar = prices.get(target.day), prior = prices.get(target.previous);
      if (!bar || !prior || prior.closeAt >= target.issuedAt || target.issuedAt >= bar.openAt || bar.closeAt >= before)
        throw new Error(`Missing or mistimed Form 144 price evidence for ${instrument} on ${target.day}`);
      return { id: `${instrument}:${target.day}`, engineVersion: METHOD, issuedAt: target.issuedAt, labelKnownAt: bar.closeAt,
        features: [Math.log(prior.close / prior.open), target.transactions, -target.proposals], up: bar.close > bar.open ? 1 : 0 };
    });
    const reference = trainCandidate(rows.map(row => ({ ...row, features: row.features.slice(0, 2) })), before);
    const candidate = trainCandidate(rows, before);
    cohorts.push({ instrument, rows, priceHashes: evidence.map(row => row.sha256), reference, candidate });
  }
  const summary = { issuers: Object.keys(ISSUERS), filings: filings.filter(row => row.kind === "144").length,
    form4: filings.filter(row => row.kind === "4").length, nonzeroDays: targets.filter(row => row.proposals > 0).length,
    from: targets[0].day, through: targets.at(-1)!.day, cohorts: cohorts.map(({ instrument, reference, candidate }) => ({
      instrument, samples: candidate.samples, status: candidate.status,
      ...(reference.status === "evaluated" && candidate.status === "evaluated" ? {
        test: candidate.split.test, startsTestAt: candidate.split.testStarts, candidateBrier: candidate.candidateBrier,
        referenceBrier: reference.candidateBrier, baseBrier: candidate.baseRateBrier, coinBrier: candidate.coinBrier,
        clearsResearchMargin: candidate.promoted && candidate.model.weights[2] > 0 &&
          candidate.candidateBrier < reference.candidateBrier - 0.01,
      } : {}),
    })) };
  await durableJSON(output, { method: METHOD, before, summary, filings, sources, targets,
    prices: KIBOT_PRICE_CITATION, calendars: EXTENDED_CALENDAR_IDS, cohorts,
    basis: "Distinct issuers with originally accepted Form 144 notices between consecutive 08:00 New York cutoffs. The baseline is Form 4 issuer breadth across the same window and preceding cash-session log body. The candidate adds negatively signed notice breadth. EDGAR acceptance timestamps control availability. The panel is fixed and the notices count proposed securities sales without assuming completion or separating past plan flags. Targets precede the public forecast archive." }, true);
  return { status: "saved_private_study", summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--collect-only"))
    throw new Error("Use --collect-only for the current private Form 144 check");
  console.log(JSON.stringify(args.length ? await collectCurrent() : await benchmark()));
}
