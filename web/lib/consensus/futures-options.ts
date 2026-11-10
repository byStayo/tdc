import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind } from "./source-failure.ts";
import type { Instrument, Signal } from "./types.ts";

const contracts = [
  { code: "13874A", symbol: "SPY", label: "S&P 500 E-mini" },
  { code: "209742", symbol: "QQQ", label: "Nasdaq-100 E-mini" },
  { code: "239742", symbol: "IWM", label: "Russell 2000 E-mini" },
  { code: "124603", symbol: "DIA", label: "Dow E-mini" },
  { code: "020601", symbol: "TLT", label: "Treasury bond" },
  { code: "043602", symbol: "TLT", label: "10-year Treasury note" },
] as const;

const url = new URL("https://publicreporting.cftc.gov/resource/udgc-27he.json");
url.searchParams.set("$where", `cftc_contract_market_code in (${contracts.map(({ code }) => `'${code}'`).join(",")})`);
url.searchParams.set("$select", "cftc_contract_market_code,report_date_as_yyyy_mm_dd,market_and_exchange_names,contract_units,open_interest_all,futonly_or_combined");
url.searchParams.set("$order", "report_date_as_yyyy_mm_dd DESC,cftc_contract_market_code,futonly_or_combined");
url.searchParams.set("$limit", "120");

const prefix = "tff-options-";
const unit = "futures equivalents";
const attribution = "US Commodity Futures Trading Commission";
const usage = "Public-domain CFTC report data with attribution";
const labels = ["Options contribution", "Futures-only open interest", "Combined open interest"] as const;
type Contract = typeof contracts[number];

function instruments(contract: Contract): Instrument[] {
  return ["MARKET", contract.symbol];
}

function baseSignal(contract: Contract, retrievedAt: string): Signal {
  return {
    id: prefix + contract.code,
    family: "institutions",
    title: `${contract.label} · futures options positioning`,
    shortLabel: contract.label,
    instruments: instruments(contract),
    directionalInstruments: [],
    status: "unavailable",
    summary: "A matching CFTC futures-only and combined report is unavailable.",
    source: {
      name: "CFTC · Traders in Financial Futures",
      url: url.href,
      retrievedAt,
      observedAt: null,
      releasedAt: null,
      frequency: "weekly",
      attribution,
      usage,
      sha256: null,
    },
    methodology: "Subtract futures-only open interest from combined open interest for the same contract and report date. CFTC converts options into futures equivalents using exchange delta factors.",
    limitation: "Weekly futures positioning context. ETF option chains, put/call totals, IV and gamma require separate data. Changes can reflect changing deltas as well as positions.",
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 14,
    unit,
  };
}

function latestPair(rows: Record<string, unknown>[], contract: Contract, cutoff: string) {
  const matching = rows.filter(row => row.cftc_contract_market_code === contract.code);
  const normalized = matching.map(row => {
    const timestamp = row.report_date_as_yyyy_mm_dd;
    const kind = row.futonly_or_combined;
    const name = row.market_and_exchange_names;
    const units = row.contract_units;
    const rawInterest = row.open_interest_all;
    if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000$/.test(timestamp))
      throw new Error("Invalid CFTC report timestamp");
    const date = timestamp.slice(0, 10);
    const interest = typeof rawInterest === "string" && /^\d+$/.test(rawInterest) ? Number(rawInterest) : NaN;
    if (publicDate(date) !== date || date > cutoff.slice(0, 10) ||
        (kind !== "FutOnly" && kind !== "Combined") ||
        typeof name !== "string" || !name.trim() || typeof units !== "string" || !units.trim() ||
        !Number.isSafeInteger(interest) || interest <= 0)
      throw new Error("Invalid CFTC open-interest record");
    return { date, kind, name, units, interest };
  });
  const date = normalized.map(row => row.date).sort().at(-1);
  const newest = normalized.filter(row => row.date === date);
  const unique = [...new Map(newest.map(row => [JSON.stringify(row), row])).values()];
  const futures = unique.find(row => row.kind === "FutOnly");
  const combined = unique.find(row => row.kind === "Combined");
  if (unique.length !== 2 || !futures || !combined || futures.name !== combined.name ||
      futures.units !== combined.units || combined.interest < futures.interest)
    throw new Error("CFTC open-interest pair is incomplete or inconsistent");
  return { date: futures.date, futures: futures.interest, combined: combined.interest };
}

export async function collectFuturesOptions(
  read: (url: string) => Promise<PublicDocument>,
  now = () => new Date().toISOString(),
): Promise<Signal[]> {
  let doc: PublicDocument;
  let rows: Record<string, unknown>[];
  try {
    doc = await read(url.href);
    if (!publicDate(doc.retrievedAt) || new Date(doc.retrievedAt).toISOString() !== doc.retrievedAt ||
        doc.retrievedAt > now() || createHash("sha256").update(doc.text).digest("hex") !== doc.sha256)
      throw new Error("Invalid CFTC provenance");
    const data: unknown = JSON.parse(doc.text);
    if (!Array.isArray(data) || data.length > 120 ||
        data.some(row => !row || typeof row !== "object" || Array.isArray(row)))
      throw new Error("Invalid CFTC response");
    rows = data;
  } catch (error) {
    return contracts.map(contract => ({ ...baseSignal(contract, now()), failureKind: sourceFailureKind(error) }));
  }
  return contracts.map(contract => {
    const base = baseSignal(contract, doc.retrievedAt);
    try {
      const { date, futures, combined } = latestPair(rows, contract, doc.retrievedAt);
      const value = combined - futures;
      return {
        ...base,
        status: "available",
        summary: `${value.toLocaleString("en-US")} futures equivalents from options on ${date}.`,
        series: [{ date, value }],
        metrics: [value, futures, combined].map((value, i) => ({ label: labels[i], value, unit, date })),
        source: { ...base.source, observedAt: date, sha256: doc.sha256 },
      };
    } catch {
      return { ...base, failureKind: "validation" };
    }
  });
}

export function validateFuturesOptions(signal: Signal): void {
  if (!signal.id.startsWith(prefix)) return;
  const contract = contracts.find(({ code }) => signal.id === prefix + code);
  const { source, series, metrics } = signal;
  if (!contract || signal.family !== "institutions" || signal.instruments.join() !== instruments(contract).join() ||
      signal.directionalInstruments?.length !== 0 || Object.values(signal.scores).some(value => value !== null) ||
      signal.unit !== unit || signal.staleAfterDays !== 14 || source.url !== url.href ||
      source.frequency !== "weekly" || source.attribution !== attribution || source.usage !== usage ||
      source.releasedAt !== null)
    throw new Error("Invalid CFTC futures options scope or provenance");
  if (signal.status === "unavailable") {
    if (series.length || metrics.length || source.observedAt !== null || source.sha256 !== null)
      throw new Error("Unavailable CFTC options signal contains values");
    return;
  }
  const [contribution, futures, combined] = metrics;
  const date = source.observedAt;
  if (signal.status !== "available" || !date || publicDate(date) !== date || date > source.retrievedAt.slice(0, 10) || !source.sha256 ||
      series.length !== 1 || metrics.length !== labels.length ||
      series[0].date !== date || series[0].value !== contribution.value ||
      metrics.some((metric, i) => metric.date !== date || metric.unit !== unit || metric.label !== labels[i] ||
        !Number.isSafeInteger(metric.value) || metric.value < 0) ||
      futures.value <= 0 || combined.value - futures.value !== contribution.value)
    throw new Error("Invalid saved CFTC options comparison");
}
