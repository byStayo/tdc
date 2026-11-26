import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { durableJSON } from "../lib/publication-storage.ts";
import { parseEcbChunk, type EcbPoint } from "../lib/consensus/canada-equity-flow-research.ts";
import { publicText } from "../lib/consensus/collector.ts";
import { EXTENDED_CALENDAR_IDS, extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt, type ResearchPriceReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(web, ".consensus/private-ft900");
const scripts = resolve(web, "scripts");
const policySHA256 = "6f0d082ab9781009179f04a14f17226699f5fd744155750659e15d91508f8bbd";
const method = "prelaunch-ft900-exports-dia-v1";
const first = "2016-01-01", last = "2026-11-02", fxFrom = "2015-12-15";
const fxSource = `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=${fxFrom}&endPeriod=${last}&format=csvdata`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const hex = /^[0-9a-f]{64}$/;
type Vintage = { release: string; kind: "reported" | "strict-bound"; monthlyExportHeadlineMillions: number;
  changeOrBoundMillions: number; beaSHA256: string; pdfSHA256: string };
type Audit = { policySHA256: string; expected: number; verified: number; errors: Record<string, string>;
  asPreviouslyPublishedFootnoteMismatch: string[]; records: Record<string, Vintage> };
type Seal = { createdAt: string; sha256: string; spec: Record<string, string> };
type Feature = { period: string; target: string; cutoff: string; releasedAt: string; exportChangePercent: number;
  beaSHA256: string; pdfSHA256: string };
type FxReceipt = Awaited<ReturnType<typeof publicText>> & { source: string };

async function python(name: string) {
  await promisify(execFile)("python3", ["-B", resolve(scripts, name)], { cwd: web, timeout: 420_000, maxBuffer: 128_000 });
}

async function sourceAudit(cached: boolean) {
  if (!cached) await python("collect-ft900-vintages.py");
  const spec = JSON.parse(await readFile(resolve(scripts, "ft900-study-policy.json"), "utf8")) as Record<string, string>;
  const seal = await readResearchReceipt<Seal>(resolve(directory, "policy.json"));
  if (!seal || seal.sha256 !== policySHA256 || !Number.isFinite(Date.parse(seal.createdAt)) ||
      [spec, seal.spec].some(v => hash(JSON.stringify(v, Object.keys(v).sort())) !== policySHA256))
    throw new Error("Source audit requires the sealed FT900 research specification");
  await python("verify-ft900-vintages.py");
  const audit = await readResearchReceipt<Audit>(resolve(directory, "independent-table-audit.json"));
  if (!audit || audit.policySHA256 !== policySHA256 || audit.expected !== 130 || audit.verified !== audit.expected ||
      Object.keys(audit.errors).length || audit.asPreviouslyPublishedFootnoteMismatch.length || Object.keys(audit.records).length !== 130)
    throw new Error("Expected the complete independent Census and BEA release replay before reading outcomes");
  return { audit, seal };
}

// Select the first eligible cutoff before inspecting any outcomes. If the first session
// is shortened, exclude the release entirely. If two releases share a target, exclude both.
export function ft900Targets(records: Record<string, Vintage>, sessions: string[]) {
  const targets = sessions.map(target => ({ target, cutoff: newYorkTimestamp(target.replaceAll("-", "") + "T074800")!,
    clock: extendedResearchSession(target)! }));
  const features = new Map<string, Feature>(), duplicates = new Set<string>();
  const excluded: Record<string, string> = {};
  for (const [period, row] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^20\d\d-(?:0[1-9]|1[0-2])$/.test(period) || !hex.test(row.beaSHA256) || !hex.test(row.pdfSHA256) ||
        !Number.isSafeInteger(row.monthlyExportHeadlineMillions) || !Number.isSafeInteger(row.changeOrBoundMillions) ||
        row.monthlyExportHeadlineMillions <= 0 || row.monthlyExportHeadlineMillions <= row.changeOrBoundMillions ||
        !["reported", "strict-bound"].includes(row.kind) || !Number.isFinite(Date.parse(row.release)))
      throw new Error("Invalid FT900 replay record");
    if (row.kind === "strict-bound") { excluded[period] = "bounded change"; continue; }
    const releasedAt = new Date(row.release).toISOString();
    const entry = targets.find(t => t.cutoff > releasedAt);
    if (!entry || !isFullKibotSession(entry.clock.openAt, entry.clock.closeAt)) {
      excluded[period] = entry ? "shortened first session" : "outside reserved research period";
      continue;
    }
    const prior = features.get(entry.target);
    if (prior || duplicates.has(entry.target)) {
      if (prior) excluded[prior.period] = "shared target";
      excluded[period] = "shared target";
      features.delete(entry.target);
      duplicates.add(entry.target);
      continue;
    }
    features.set(entry.target, { period, target: entry.target, cutoff: entry.cutoff, releasedAt,
      exportChangePercent: 100 * row.changeOrBoundMillions / (row.monthlyExportHeadlineMillions - row.changeOrBoundMillions),
      beaSHA256: row.beaSHA256, pdfSHA256: row.pdfSHA256 });
  }
  return { features, excluded };
}

export function priorDollarFix(target: string, fixes: EcbPoint[]) {
  const i = fixes.findLastIndex(fix => fix.date < target);
  if (i < 1 || Date.parse(target) - Date.parse(fixes[i].date) > 7 * 86_400_000 ||
      Date.parse(fixes[i].date) - Date.parse(fixes[i - 1].date) > 7 * 86_400_000) return null;
  return { value: 10_000 * Math.log(fixes[i].value / fixes[i - 1].value), dates: [fixes[i - 1].date, fixes[i].date] };
}

async function dollarFixes(cached: boolean) {
  const file = resolve(directory, "ecb.json");
  const saved = await readResearchReceipt<FxReceipt>(file);
  if (!saved && cached) throw new Error("Private original ECB fixing receipt is missing");
  const fx = saved ?? { source: fxSource, ...await publicText(fxSource) };
  if (fx.source !== fxSource || !Number.isFinite(Date.parse(fx.retrievedAt)) || hash(fx.text) !== fx.sha256)
    throw new Error("Original ECB fixing receipt differs");
  const fixes = parseEcbChunk(fx.text, "USD", fxFrom, last);
  if (!saved) await durableJSON(file, fx, true);
  return { fx, fixes };
}

async function priceReceipts(sessions: string[], cached: boolean) {
  const result: { raw: ResearchPriceReceipt[]; splits: ResearchPriceReceipt[] } = { raw: [], splits: [] };
  const previousStudy = resolve(web, ".consensus/private-technical-momentum");
  for (const year of new Set(sessions.map(day => day.slice(0, 4)))) {
    const days = sessions.filter(day => day.startsWith(year));
    for (const basis of ["raw", "splits"] as const) {
      // Reuse a validated prior study receipt when present. A clean checkout can
      // acquire the same calendar and basis directly into this experiment.
      const name = `DIA-${year}-${days[0]}-${days.at(-1)}-${basis}.json`;
      const existing = year >= "2022" && await readResearchReceipt(resolve(previousStudy, name));
      result[basis].push(...await collectResearchPrices(existing ? previousStudy : directory, "DIA", days,
        { splitAdjusted: basis === "splits", cachedOnly: cached }));
    }
  }
  return result;
}

/** Fully replay source vintages, fixing dates, price bases and fitted results before staging aggregate output. */
export async function replayFt900Study(cached: boolean, sourcesOnly = false, expectedBefore?: string) {
  const { audit, seal } = await sourceAudit(cached);
  const { history } = await verifyPublicationTree(web);
  const before = history.map(edition => edition.issuedAt).sort()[0];
  if (!before || (expectedBefore !== undefined && expectedBefore !== before) || before <= last + "T23:59:59.999Z") throw new Error("FT900 research overlaps the prospective archive");
  const sessions = extendedResearchSessions(first, last);
  const { features, excluded } = ft900Targets(audit.records, sessions);
  const sourceSummary = { verifiedReleases: audit.verified, eligibleTargets: features.size, excluded };
  if (sourcesOnly || features.size < 120) return { sourceSummary, result: null };
  const { fx, fixes } = await dollarFixes(cached);
  const priced = await priceReceipts(sessions, cached);
  const raw = new Map(priced.raw.flatMap(r => r.sessions.map(b => [b.session, b] as const)));
  const splits = new Map(priced.splits.flatMap(r => r.sessions.map(b => [b.session, b] as const)));
  const pairs = [...features.values()].flatMap(feature => {
    const fix = priorDollarFix(feature.target, fixes);
    if (!fix) { excluded[feature.period] = "missing prior ECB fixes"; return []; }
    const bar = raw.get(feature.target), split = splits.get(feature.target);
    if (!bar || !split || bar.openAt !== split.openAt || bar.closeAt !== split.closeAt ||
        bar.openAt <= feature.cutoff || bar.closeAt >= before || !isFullKibotSession(bar.openAt, bar.closeAt))
      throw new Error("Outcome receipts do not cover the frozen regular session");
    if (Math.sign(bar.close - bar.open) !== Math.sign(split.close - split.open)) {
      excluded[feature.period] = "raw and split-only directions differ"; return [];
    }
    const training: TrainingRow = { id: "DIA:" + feature.target, engineVersion: method, issuedAt: feature.cutoff,
      labelKnownAt: bar.closeAt, features: [fix.value, feature.exportChangePercent], up: bar.close > bar.open ? 1 : 0 };
    return [{ feature, fixDates: fix.dates, training }];
  });
  const rows = pairs.map(p => p.training);
  const control = trainCandidate(rows.map(r => ({ ...r, features: [r.features[0]] })), before);
  const combined = trainCandidate(rows, before);
  const summary = { ...sourceSummary, pairedTargets: pairs.length, ecbFixings: fixes.length, status: combined.status,
    split: combined.status === "evaluated" ? combined.split : null,
    brier: combined.status === "evaluated" && control.status === "evaluated" ? { fxAndExports: combined.candidateBrier,
      fx: control.candidateBrier, baseRate: combined.baseRateBrier, coin: combined.coinBrier } : null,
    exportCoefficient: combined.status === "evaluated" ? combined.model.weights[1] : null,
    clearsResearchMargin: combined.status === "evaluated" && control.status === "evaluated" &&
      combined.promoted && combined.model.weights[1] > 0 && combined.candidateBrier < control.candidateBrier - 0.01 };
  const result = { method, policySHA256, registeredAt: seal.createdAt, before, calendar: EXTENDED_CALENDAR_IDS, summary,
    releaseDigest: digest(audit.records), prices: { source: KIBOT_PRICE_CITATION, raw: priced.raw.map(r => r.sha256),
      splits: priced.splits.map(r => r.sha256) }, ecb: { source: fx.source, sha256: fx.sha256, vintage: "latest historical fixing" },
    pairs, control, combined, limitations: "Prelaunch dates overlap earlier historical studies. Retrospective public archives, private labels, no prospective holdout use." };
  const file = resolve(directory, method + ".json");
  const stored = await readResearchReceipt<typeof result>(file);
  if (stored && digest(stored) !== digest(result)) throw new Error("Replay differs from the original FT900 study");
  if (!stored) {
    if (cached) throw new Error("Offline FT900 replay requires the original completed result");
    await durableJSON(file, result, true);
  }
  return { sourceSummary, result };
}

async function main() {
  const mode = process.argv.slice(2);
  if (mode.length > 1 || mode.some(m => !["--sources-only", "--cached-only"].includes(m)))
    throw new Error("Usage: consensus:research-us-trade [--sources-only | --cached-only]");
  const { sourceSummary, result } = await replayFt900Study(mode.includes("--cached-only"), mode.includes("--sources-only"));
  console.log(JSON.stringify(result?.summary ?? sourceSummary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
