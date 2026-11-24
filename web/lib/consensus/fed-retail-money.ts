import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { immutableSourceReceipt } from "../publication-storage.ts";
import { publicDate } from "../public-normalization.ts";
import { publicBytes, type Fetcher } from "./public-source.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const FED_RETAIL_MONEY_ID = "fed-h6-retail-balances";
const archive = "https://www.federalreserve.gov/releases/h6/";
const indexUrl = archive + "releaseDates.json";
const firstModern = "2026-07-28";
const method =
  "Use the first verified dated Federal Reserve Board H.6 issue on the gross-component basis introduced July 28, 2026. Compare two consecutive monthly balances within that issue and reconcile both to M1 and M2 after deducting the separately reported retirement accounts.";
const limitation =
  "Balances can change through subscriptions, redemptions, interest and reclassification. The Board does not identify which securities households bought or sold. The retirement-account deduction covers both funds and deposits.";
const usage =
  "Board of Governors of the Federal Reserve System, public statistical release. https://www.federalreserve.gov/disclaimer.htm";
const attribution =
  "Board of Governors of the Federal Reserve System (US), H.6 Money Stock Measures, Tables 1 and 2.";
const stage = "gross-retail-and-time-deposits-separate-ira-v1";
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const url = (day: string) => archive + day.replaceAll("-", "") + "/";
const releaseClock = (day: string) => newYorkTimestamp(day.replaceAll("-", "") + "T130000")!;
const priorMonth = (ym: string) => new Date(Date.parse(ym + "-01") - 86400000).toISOString().slice(0, 7);
const lastDay = (ym: string) =>
  new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).toISOString().slice(0, 10);
const exact = (x: object, keys: string[]) => Object.keys(x).sort().join() === [...keys].sort().join();
class FedMoneyError extends Error {}
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FedMoneyError(message);
}

type Balance = {
  month: string;
  retail: number;
  smallDeposits: number;
  retirement: number;
  retirementEstimated: boolean;
  m1: number;
  m2: number;
};
export type FedRetailMoneyEvidence = {
  definition: typeof stage;
  releaseDay: string;
  scheduledAt: string;
  firstVerifiedAt: string;
  indexSHA256: string;
  current: Balance;
  previous: Balance;
};
type RetailSignal = Signal & { fedRetailMoney?: FedRetailMoneyEvidence };
type Capture = { url: string; at: string; sha256: string; gzip: string };
type Receipt = { index: Capture; original: Capture; firstVerifiedAt: string };

function base(now: string): RetailSignal {
  return {
    id: FED_RETAIL_MONEY_ID,
    family: "retail",
    title: "U.S. retail money funds and small deposits",
    shortLabel: "Household cash balances",
    instruments: ["MARKET"],
    directionalInstruments: [],
    status: "unavailable",
    summary: "A verified Federal Reserve H.6 balance report is pending.",
    source: {
      name: "Federal Reserve Board · H.6 Money Stock Measures",
      url: indexUrl,
      retrievedAt: now,
      observedAt: null,
      releasedAt: null,
      frequency: "monthly",
      attribution,
      usage,
      sha256: null,
    },
    methodology: method,
    limitation,
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 70,
    unit: "USD billions",
  };
}
export function selectFedRetailRelease(text: string, checkedAt: string): string {
  requireFact(instant(checkedAt), "Invalid H.6 collection clock.");
  const parsed: unknown = JSON.parse(text);
  requireFact(Array.isArray(parsed) && parsed.length > 0, "Unrecognized H.6 original release index.");
  const dates = new Set<string>();
  for (const year of parsed) {
    requireFact(year && Array.isArray(year.Months), "Unrecognized H.6 archive year.");
    for (const m of year.Months) {
      if (typeof m.MonthValue !== "string" || m.MonthValue < "202607") continue;
      requireFact(
        Array.isArray(m.Dates) && /^\d{4}(0[1-9]|1[0-2])$/.test(m.MonthValue),
        "Invalid month in the H.6 archive.",
      );
      for (const entry of m.Dates) {
        requireFact(
          typeof entry === "string" && /^\d{8}\*{0,3}$/.test(entry) && entry.startsWith(m.MonthValue),
          "Invalid H.6 issue date.",
        );
        const day = entry.slice(0, 4) + "-" + entry.slice(4, 6) + "-" + entry.slice(6, 8);
        requireFact(publicDate(day) === day && !dates.has(day), "Duplicate or invalid H.6 issue.");
        dates.add(day);
      }
    }
  }
  const latest = [...dates]
    .filter((d) => d >= firstModern && releaseClock(d) <= checkedAt)
    .sort()
    .at(-1);
  requireFact(latest, "No released H.6 gross-basis issue was found.");
  return latest;
}
function plain(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/-\s+/g, "-")
    .trim();
}
function attribute(source: string, name: string) {
  return new RegExp("\\b" + name + "=[\"']([^\"']+)[\"']", "i").exec(source)?.[1] ?? "";
}
function period(value: string) {
  const m = /^([A-Za-z]+)\.? (\d{4})$/.exec(plain(value));
  if (!m) return null;
  const n = months.indexOf(m[1].toLowerCase().slice(0, 3));
  return n < 0 ? null : m[2] + "-" + String(n + 1).padStart(2, "0");
}
function stampMonth(value: string) {
  const r = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  if (!r) return "";
  const n = months.indexOf(r[1].slice(0, 3).toLowerCase());
  return r[3] + "-" + String(n + 1).padStart(2, "0") + "-" + r[2].padStart(2, "0");
}
function table(html: string, which: "1" | "2", title: string) {
  const all = [...html.matchAll(/<table\b([^>]*)>[\s\S]*?<\/table>/gi)];
  const matches = all.filter((m) => attribute(m[1], "id") === "t" + which + "tg1");
  requireFact(matches.length === 1, "Missing or ambiguous H.6 numeric table.");
  const m = matches[0];
  requireFact(
    plain(html.slice(Math.max(0, m.index - 350), m.index)).endsWith(title),
    "H.6 adjustment or currency unit changed.",
  );
  const headers = new Map<string, string>();
  for (const h of (m[0].match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? "").matchAll(
    /<th\b([^>]*)>([\s\S]*?)<\/th>/gi,
  )) {
    const id = attribute(h[1], "id");
    requireFact(id && !headers.has(id), "H.6 contains a duplicate table header.");
    headers.set(id, plain(h[2]));
  }
  const rows = new Map<string, Map<string, string>>();
  for (const r of (m[0].match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "").matchAll(
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const h = /<th\b([^>]*)>([\s\S]*?)<\/th>/i.exec(r[1]);
    if (!h) continue;
    const ym = period(h[2]);
    if (!ym) continue;
    const rowId = attribute(h[1], "id"),
      cells = new Map<string, string>();
    requireFact(rowId && !rows.has(ym), "Repeated monthly H.6 original row.");
    for (const td of r[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
      const tokens = attribute(td[1], "headers").split(/\s+/);
      requireFact(tokens.includes(rowId), "H.6 cell is detached from its reference month.");
      if (!tokens.includes("t" + which + "tg1a2")) continue;
      for (const id of tokens.filter((t) => t !== rowId)) {
        if (cells.has(id))
          cells.set(id, ""); // A spanning column group cannot identify a single reading.
        else cells.set(id, plain(td[2]));
      }
    }
    rows.set(ym, cells);
  }
  return { headers, rows };
}
function number(t: ReturnType<typeof table>, ym: string, id: string, label: RegExp, allowEstimate = false) {
  requireFact(label.test(t.headers.get(id) ?? ""), "H.6 balance field or basis changed.");
  const value = t.rows.get(ym)?.get(id) ?? "";
  const match = /^(\d{1,3}(?:,\d{3})*|\d+)\.(\d)(?: (e))?$/.exec(value);
  requireFact(match && (!match[3] || allowEstimate), "Missing H.6 balance or unexpected estimate.");
  return { tenths: Number(match[1].replaceAll(",", "")) * 10 + Number(match[2]), estimated: Boolean(match[3]) };
}
function validBalance(b: Balance) {
  return (
    b &&
    exact(b, ["month", "retail", "smallDeposits", "retirement", "retirementEstimated", "m1", "m2"]) &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(b.month) &&
    typeof b.retirementEstimated === "boolean" &&
    [b.retail, b.smallDeposits, b.retirement, b.m1, b.m2].every(
      (x) => Number.isSafeInteger(x) && x > 0 && x < 10_000_000,
    ) &&
    Math.abs(b.m2 - b.m1 - b.retail - b.smallDeposits + b.retirement) <= 3
  );
}
export function parseFedRetailBalances(html: string, day: string) {
  const seen = [...plain(html).matchAll(/Release Date:\s*([A-Z][a-z]+ \d{1,2}, \d{4})\b/g)];
  requireFact(
    day >= firstModern && publicDate(day) === day && seen.length === 1 && stampMonth(seen[0][1]) === day,
    "H.6 original date or definition does not match the archive.",
  );
  const totals = table(html, "1", "Money Stock Measures. Billions of dollars unless otherwise noted.");
  const cash = table(
    html,
    "2",
    "Seasonally Adjusted Components of M1 and M2, unless otherwise noted. Billions of dollars.",
  );
  requireFact(totals.headers.get("t1tg1a2") === "Seasonally adjusted", "H.6 aggregate seasonality changed.");
  const latest = priorMonth(day.slice(0, 7)),
    previous = priorMonth(latest);
  requireFact(
    [...totals.rows.keys()].sort().at(-1) === latest && [...cash.rows.keys()].sort().at(-1) === latest,
    "H.6 does not report the expected completed reference month.",
  );
  function one(month: string): Balance {
    const ira = number(
      cash,
      month,
      "t2tg1b4",
      /^Less: Total IRA and Keogh account balances \(NSA\)(?: \d+)?$/,
      true,
    );
    const balance = {
      month,
      retail: number(cash, month, "t2tg1b3", /^Retail money market funds(?: \d+)?$/).tenths,
      smallDeposits: number(cash, month, "t2tg1b2", /^Small-denomination time deposits(?: \d+)?$/).tenths,
      retirement: ira.tenths,
      retirementEstimated: ira.estimated,
      m1: number(totals, month, "t1tg1b1", /^M1(?: \d+)?$/).tenths,
      m2: number(totals, month, "t1tg1b2", /^M2(?: \d+)?$/).tenths,
    };
    requireFact(validBalance(balance), "H.6 components do not reconcile to M2 after retirement accounts.");
    return balance;
  }
  return { current: one(latest), previous: one(previous) };
}
function data(e: FedRetailMoneyEvidence) {
  const date = lastDay(e.current.month);
  const delta = (field: "retail" | "smallDeposits") => (e.current[field] - e.previous[field]) / 10;
  return {
    summary: `U.S. retail money funds held $${(e.current.retail / 10).toLocaleString("en-US")} billion for ${e.current.month}. Small time deposits held $${(e.current.smallDeposits / 10).toLocaleString("en-US")} billion.`,
    metrics: [
      { label: "Retail money funds", value: e.current.retail / 10, unit: "USD billions", date },
      { label: "Monthly change in retail funds", value: delta("retail"), unit: "USD billions", date },
      { label: "Small time deposits", value: e.current.smallDeposits / 10, unit: "USD billions", date },
      { label: "Monthly change in small deposits", value: delta("smallDeposits"), unit: "USD billions", date },
      {
        label: "Retirement accounts deducted from M2" + (e.current.retirementEstimated ? " (estimated)" : ""),
        value: e.current.retirement / 10,
        unit: "USD billions",
        date,
      },
    ],
    series: [
      { date: lastDay(e.previous.month), value: e.previous.retail / 10 },
      { date, value: e.current.retail / 10 },
    ],
  };
}
function original(c: Capture, expected: string, asOf: string) {
  requireFact(
    c &&
      c.url === expected &&
      instant(c.at) &&
      c.at <= asOf &&
      typeof c.gzip === "string" &&
      c.gzip.length < 800_000 &&
      digest(c.sha256),
    "Invalid private H.6 source receipt.",
  );
  const raw = gunzipSync(Buffer.from(c.gzip, "base64"), { maxOutputLength: 500_000 });
  requireFact(hash(raw) === c.sha256, "Private H.6 raw source digest differs.");
  return raw.toString("utf8");
}
export async function collectFedRetailMoney(
  fetcher: Fetcher = fetch,
  now: () => string = () => new Date().toISOString(),
  receiptDirectory?: string,
): Promise<RetailSignal> {
  const start = now(),
    empty = base(start);
  async function capture(address: string): Promise<Capture> {
    const { bytes, sha256 } = await publicBytes(address, fetcher, 500_000);
    return { url: address, at: now(), sha256, gzip: gzipSync(bytes).toString("base64") };
  }
  try {
    const index = await capture(indexUrl);
    const day = selectFedRetailRelease(original(index, indexUrl, now()), index.at);
    const doc = await capture(url(day));
    const current = parseFedRetailBalances(original(doc, url(day), now()), day);
    const stored = await immutableSourceReceipt<Receipt>(
      receiptDirectory,
      "h6-" + day + ".json",
      async () => ({ index, original: doc, firstVerifiedAt: now() }),
      (r) => {
        requireFact(
          instant(r.firstVerifiedAt) &&
            r.index.at <= r.original.at &&
            r.original.at <= r.firstVerifiedAt &&
            r.firstVerifiedAt <= now() &&
            r.index.at >= releaseClock(day),
          "Inconsistent H.6 availability clock.",
        );
        requireFact(
          selectFedRetailRelease(original(r.index, indexUrl, r.firstVerifiedAt), r.index.at) === day,
          "Private H.6 release selection differs.",
        );
        const first = parseFedRetailBalances(original(r.original, url(day), r.firstVerifiedAt), day);
        requireFact(
          JSON.stringify(first) === JSON.stringify(current),
          "The Board revised the pinned H.6 balance report.",
        );
      },
    );
    const e: FedRetailMoneyEvidence = {
      definition: stage,
      releaseDay: day,
      scheduledAt: releaseClock(day),
      firstVerifiedAt: stored.firstVerifiedAt,
      indexSHA256: stored.index.sha256,
      ...current,
    };
    const signal: RetailSignal = {
      ...empty,
      ...data(e),
      status: "available",
      fedRetailMoney: e,
      source: {
        ...empty.source,
        url: url(day),
        retrievedAt: now(),
        observedAt: lastDay(e.current.month),
        releasedAt: day,
        sha256: stored.original.sha256,
      },
    };
    validateFedRetailMoney(signal);
    return signal;
  } catch (error) {
    const failureKind = sourceFailureKind(error);
    return {
      ...empty,
      failureKind,
      collectionNote:
        error instanceof FedMoneyError
          ? error.message
          : failureKind === "transport"
            ? "The Federal Reserve H.6 source connection failed."
            : "The Federal Reserve H.6 source or private receipt could not be verified.",
    };
  }
}
export function validateFedRetailMoney(s: RetailSignal, cutoff?: string) {
  const e = s.fedRetailMoney;
  if (s.id !== FED_RETAIL_MONEY_ID) {
    requireFact(e === undefined, "H.6 evidence is attached to another signal.");
    return;
  }
  const b = base(s.source.retrievedAt);
  requireFact(
    s.family === b.family &&
      s.instruments.join() === "MARKET" &&
      s.directionalInstruments?.length === 0 &&
      exact(s.scores, ["daily", "weekly", "monthly"]) &&
      Object.values(s.scores).every((x) => x === null),
    "Invalid H.6 retail observation scope.",
  );
  requireFact(
    s.source.name === b.source.name &&
      s.source.attribution === attribution &&
      s.source.usage === usage &&
      s.source.frequency === "monthly" &&
      s.methodology === method &&
      s.limitation === limitation &&
      s.staleAfterDays === b.staleAfterDays &&
      s.title === b.title &&
      s.shortLabel === b.shortLabel &&
      s.unit === b.unit &&
      instant(s.source.retrievedAt) &&
      (!cutoff || (instant(cutoff) && s.source.retrievedAt <= cutoff)),
    "Invalid H.6 source provenance.",
  );
  if (s.status === "unavailable") {
    requireFact(
      !e &&
        s.source.url === indexUrl &&
        s.source.observedAt === null &&
        s.source.releasedAt === null &&
        s.source.sha256 === null &&
        !s.series.length &&
        !s.metrics.length &&
        s.summary === b.summary,
      "Unavailable H.6 signal contains a reading.",
    );
    return;
  }
  requireFact(
    s.status === "available" &&
      e &&
      exact(e, [
        "definition",
        "releaseDay",
        "scheduledAt",
        "firstVerifiedAt",
        "indexSHA256",
        "current",
        "previous",
      ]) &&
      e.definition === stage &&
      e.releaseDay >= firstModern &&
      publicDate(e.releaseDay) === e.releaseDay &&
      e.scheduledAt === releaseClock(e.releaseDay) &&
      instant(e.firstVerifiedAt) &&
      e.scheduledAt <= e.firstVerifiedAt &&
      e.firstVerifiedAt <= s.source.retrievedAt &&
      digest(e.indexSHA256) &&
      validBalance(e.current) &&
      validBalance(e.previous) &&
      e.current.month === priorMonth(e.releaseDay.slice(0, 7)) &&
      e.previous.month === priorMonth(e.current.month) &&
      s.source.url === url(e.releaseDay) &&
      s.source.releasedAt === e.releaseDay &&
      s.source.observedAt === lastDay(e.current.month) &&
      digest(s.source.sha256),
    "Invalid gross-basis H.6 evidence, source or release clock.",
  );
  const calculated = data(e);
  requireFact(
    s.summary === calculated.summary &&
      JSON.stringify(s.series) === JSON.stringify(calculated.series) &&
      JSON.stringify(s.metrics) === JSON.stringify(calculated.metrics),
    "H.6 displayed data differs from verified balances.",
  );
}
