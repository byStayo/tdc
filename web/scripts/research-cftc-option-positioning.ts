import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { publicDate } from "../lib/public-normalization.ts";
import { publicBytes } from "../lib/consensus/collector.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const METHOD = "prelaunch-tff-option-positioning-v1";
const FROM = "2023-05-09", THROUGH = "2026-10-20", LAST_TARGET = "2026-11-02";
const CONTRACTS = { SPY: "13874A", QQQ: "209742", IWM: "239742", DIA: "124603", TLT: "020601" } as const;
type Instrument = keyof typeof CONTRACTS;
const symbols = Object.keys(CONTRACTS) as Instrument[];
const dayMs = 86_400_000;
type Source = { url: string; sha256: string; retrievedAt: string; source: string };
type Row = Record<string, unknown>;
type Positions = { label: string; units: string; interest: number; net: number };
type Report = { date: string; futures: Positions; combined: Positions };
type ReportPair = Partial<Record<"FutOnly" | "Combined", Positions>>;
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-cftc-options");
const url = new URL("https://publicreporting.cftc.gov/resource/udgc-27he.json");
url.searchParams.set("$where", "cftc_contract_market_code in (" + Object.values(CONTRACTS).map(code => "'" + code + "'").join(",") +
  `) AND report_date_as_yyyy_mm_dd between '${FROM}T00:00:00' and '${THROUGH}T00:00:00'`);
url.searchParams.set("$select", "cftc_contract_market_code,report_date_as_yyyy_mm_dd,market_and_exchange_names,contract_units,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,futonly_or_combined");
url.searchParams.set("$order", "report_date_as_yyyy_mm_dd,cftc_contract_market_code,futonly_or_combined");
url.searchParams.set("$limit", "2100");

function integer(value: unknown) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) throw new Error("Malformed CFTC position or open interest");
  return number;
}

export function pairedOptionReports(rows: Row[], contract: string) {
  const pairs = new Map<string, ReportPair>();
  for (const row of rows.filter(row => row.cftc_contract_market_code === contract)) {
    const { report_date_as_yyyy_mm_dd: time, futonly_or_combined: type,
      market_and_exchange_names: label, contract_units: units } = row;
    const date = typeof time === "string" ? time.slice(0, 10) : "";
    if (time !== date + "T00:00:00.000" || publicDate(date) !== date || date < FROM || date > THROUGH ||
        (type !== "FutOnly" && type !== "Combined") || typeof label !== "string" || !label ||
        typeof units !== "string" || !units)
      throw new Error("Unexpected CFTC report date, contract or position basis");
    const interest = integer(row.open_interest_all);
    const long = integer(row.asset_mgr_positions_long), short = integer(row.asset_mgr_positions_short);
    const pair = pairs.get(date) ?? {};
    if (interest <= 0 || long > interest || short > interest || pair[type])
      throw new Error("Impossible or duplicate CFTC position record");
    pair[type] = { label, units, interest, net: long - short };
    pairs.set(date, pair);
  }
  return [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([date, pair]): Report => {
    const futures = pair.FutOnly, combined = pair.Combined;
    if (!futures || !combined || combined.label !== futures.label || combined.units !== futures.units ||
        combined.interest < futures.interest)
      throw new Error(`Inconsistent CFTC futures and combined pair for ${contract} on ${date}`);
    return { date, futures, combined };
  });
}

export function optionPositionTargets(reports: Report[]) {
  const sessions = extendedResearchSessions(FROM, LAST_TARGET);
  const delayed = (date: string) => date >= "2025-09-30" && date <= "2025-12-23";
  const targets = new Map<string, { reportDate: string; previous: string; availabilityProxy: string;
    futuresChange: number; optionsChange: number }>();
  for (let i = 1; i < reports.length; i++) {
    const report = reports[i], previous = reports[i - 1];
    if (Date.parse(report.date) - Date.parse(previous.date) !== 7 * dayMs ||
        delayed(report.date) || delayed(previous.date) || report.futures.units !== previous.futures.units) continue;
    const proxy = new Date(Date.parse(report.date) + 10 * dayMs).toISOString().slice(0, 10);
    const target = sessions.find(day => day > proxy);
    if (!target) continue;
    const clock = extendedResearchSession(target)!;
    if (!isFullKibotSession(clock.openAt, clock.closeAt)) continue;
    const futuresChange = (report.futures.net - previous.futures.net) / report.futures.interest;
    const combinedChange = (report.combined.net - previous.combined.net) / report.futures.interest;
    targets.set(target, { reportDate: report.date, previous: previous.date, availabilityProxy: proxy,
      futuresChange, optionsChange: combinedChange - futuresChange });
  }
  return targets;
}

async function run() {
  if (process.argv.length !== 2) throw new Error("The fixed options-positioning screen takes no arguments");
  const unlock = await acquirePublicationLock(root, "private-cftc-options-study");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || before <= `${LAST_TARGET}T21:00:00.000Z`) throw new Error("CFTC research overlaps published forecasts");
    const output = resolve(directory, METHOD + ".json");
    const saved = await readResearchReceipt<{ method: string; before: string; summary: unknown }>(output);
    if (saved) {
      if (saved.method !== METHOD || saved.before !== before) throw new Error("CFTC study has a different archive boundary");
      console.log(JSON.stringify({ status: "reused", summary: saved.summary }));
      return;
    }
    await durableDirectory(directory, 0o700);
    const path = resolve(directory, "cftc-tff-options-history-v1.json");
    const cached = await readResearchReceipt<Source>(path);
    let source = cached;
    if (!source) {
      const capture = await publicBytes(url.href);
      source = { url: url.href, sha256: capture.sha256, retrievedAt: capture.retrievedAt, source: capture.bytes.toString("utf8") };
    }
    if (source.url !== url.href || !Number.isFinite(Date.parse(source.retrievedAt)) ||
        createHash("sha256").update(source.source).digest("hex") !== source.sha256)
      throw new Error("CFTC report source bytes differ from their private capture");
    const rows: unknown = JSON.parse(source.source);
    if (!Array.isArray(rows) || rows.length !== 1810 || rows.some(row => !row || typeof row !== "object"))
      throw new Error("CFTC paired source inventory differs from its reviewed bounds");
    if (!cached) await durableJSON(path, source, true);
    const cohorts = [];
    for (const instrument of symbols) {
      const reports = pairedOptionReports(rows, CONTRACTS[instrument]);
      if (reports.length !== 181 || reports[0].date !== FROM || reports.at(-1)!.date !== THROUGH)
        throw new Error(`CFTC ${instrument} reports do not cover the frozen weekly scope`);
      const targets = optionPositionTargets(reports);
      const captures = await collectResearchPrices(directory, instrument, [...targets.keys()]);
      const training = captures.flatMap(capture => capture.sessions).flatMap(bar => {
        const feature = targets.get(bar.session);
        if (!feature || bar.closeAt >= before) return [];
        const row: TrainingRow = { id: `${instrument}:${bar.session}`, engineVersion: METHOD,
          issuedAt: newYorkTimestamp(bar.session.replaceAll("-", "") + "T080000")!, labelKnownAt: bar.closeAt,
          features: [feature.futuresChange, feature.optionsChange], up: bar.close > bar.open ? 1 : 0 };
        return [row];
      });
      const reference = trainCandidate(training.map(row => ({ ...row, features: [row.features[0]] })), before);
      const candidate = trainCandidate(training, before);
      cohorts.push({ instrument, reference, candidate, priceHashes: captures.map(row => row.sha256),
        reports: reports.length, featureEvidence: [...targets], training });
    }
    const summary = { sourceRows: rows.length, cohorts: cohorts.map(({ instrument, reports, reference, candidate }) => ({
      instrument, reportPairs: reports, samples: candidate.samples, status: candidate.status,
      ...(reference.status === "evaluated" && candidate.status === "evaluated" ? { test: candidate.split.test,
        futuresBrier: reference.candidateBrier, combinedBrier: candidate.candidateBrier,
        baseBrier: candidate.baseRateBrier, coinBrier: candidate.coinBrier,
        clearsResearchMargin: candidate.promoted && candidate.model.weights[1] > 0 &&
          candidate.candidateBrier < reference.candidateBrier - 0.01 } : {}),
    })) };
    const { source: _raw, ...proof } = source;
    await durableJSON(output, { method: METHOD, before, source: proof, calendar: EXTENDED_CALENDAR_IDS,
      priceSource: KIBOT_PRICE_CITATION, summary, cohorts,
      policy: "Compare asset-manager futures-only changes with the same signal plus the incremental combined-report net position change, normalized by current futures open interest. A positive option-component coefficient and more than 0.01 improvement over the futures-only and simple baselines are required. One subsequent full session after a fixed ten-calendar-day posting proxy, with the 2025 catch-up weeks and intervening missing reports excluded. The CFTC tables are retrospective and may include corrections. Classifications and delta changes can affect the difference." }, true);
    console.log(JSON.stringify({ status: "saved", summary }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(unlock, failure); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
