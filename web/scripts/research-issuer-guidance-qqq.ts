import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { isFullKibotSession, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { newYorkDate, newYorkTimestamp } from "../lib/consensus/time.ts";
import { readResearchReceipt, type ResearchPriceReceipt } from "../lib/consensus/research-price-capture.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(web, ".consensus/private-issuer-guidance-archive-qualification");
export const QQQ_GUIDANCE_METHOD = "prelaunch-qqq-original-revenue-guidance-v1";
export const QQQ_GUIDANCE_POLICY_SHA256 = "bae158de7cfd520381a0985be6944ac95cfb982826ed9531d0e9adb4a3650c57";
const firstForecast = "2026-11-03T06:28:30.460Z";
const dayMs = 86_400_000;
const sha = (s: Buffer | string) => createHash("sha256").update(s).digest("hex");
const fileSHA = {
  register: "7b9b5b1f6762d4936ac4f0ff8ee49388b8c40d6ad00f23b929bee9da3116f320",
  originalFilings: "3d114c74b8d668179967e77f6af8934a9e286eb5c97b071616091504506cba48",
  texasFilings: "38e62183fd0c78d527c2ce783a6a391c80969342e0c032b9b035bff6bd655207",
  originalExhibits: "7917f6127ff4f40c54e049b9e4bb6803583c92fa53375b1c84a866afc3b9a3bb",
  texasExhibits: "445b0dd3773b0df76e21f97907c4038801f07e38adda6b1883528b74892ad6b3",
  result: "81061a52a2cb7987f658ee56d06e2ac43723dce3307f113e93781be4d4cd591a",
} as const;

type Symbol = "AMD" | "NVDA" | "TXN";
const ciks: Record<Symbol, string> = { AMD: "0000002488", NVDA: "0001045810", TXN: "0000097476" };
type Filing = {
  ticker: Symbol;
  cik: string;
  accessionNumber: string;
  form: string;
  items: string;
  reportDate: string;
  filingDate: string;
  acceptanceDateTime: string;
};
type Pair = {
  ticker: Symbol;
  prior: string;
  actual: string;
  filedAccn: string;
  priorAt: string;
  actualAt: string;
  filedAt: string;
  periodEnd: string;
  actualMillions: string;
  rangeMillions: [string, string, string];
  priorExhibitSha: string;
  actualExhibitSha: string;
  independentBasis: string;
  availableNoEarlierThan: string;
};
type Exhibit = Filing & { index?: [string, string]; original?: [string, string] };
type Receipt = { url: string; sha256: string; bytes: number };
type OldCalendar = { days: Record<string, { early: boolean }>; sources: Record<string, Receipt> };
type Registration = {
  registeredAt: string;
  policySHA256: string;
  policy: { id: string; dependencies: Record<string, string> };
};
type Clock = NonNullable<ReturnType<typeof extendedResearchSession>>;
type YearPrices = {
  year: string;
  from: string;
  through: string;
  raw: string;
  splits: string;
  rawNormalized: string;
  splitsNormalized: string;
  rawRef: string;
  splitsRef: string;
};
type PriceSeal = {
  method: string;
  asOf: string;
  policySHA256: string;
  prices: YearPrices[];
  sourceSHA256: string;
  dropped: unknown[];
  combined: unknown;
  control: unknown;
  summary: unknown;
};
type Target = {
  day: string;
  clock: Clock;
  asOfCutoff: string;
  control: number;
  feature: number;
  filings: { ticker: Symbol; prior: string; actual: string; filed: string; afterDay: string }[];
};

async function bytes(path: string, limit: number) {
  const s = await lstat(path);
  if (!s.isFile() || s.mode & 0o077 || s.size < 1 || s.size > limit)
    throw new Error("Missing or unprotected historical earnings receipt");
  return readFile(path);
}
async function sealed<T>(name: string, hash: string): Promise<T> {
  const b = await bytes(resolve(directory, name), 4_000_000);
  if (sha(b) !== hash) throw new Error("Historical earnings receipt changed: " + name);
  return JSON.parse(b.toString());
}
async function sourceBytes(receipt: Pick<Receipt, "sha256">) {
  if (!/^[0-9a-f]{64}$/.test(receipt.sha256)) throw new Error("Invalid original source checksum");
  const compressed = await bytes(resolve(directory, "objects", receipt.sha256 + ".gz"), 5_000_000);
  const raw = gunzipSync(compressed, { maxOutputLength: 16_000_000 });
  if (sha(raw) !== receipt.sha256) throw new Error("Compressed original source differs from its receipt");
  return raw;
}
function stamp(day: string, clock: string) {
  return newYorkTimestamp(day.replaceAll("-", "") + "T" + clock)!;
}
function studyClock(old: OldCalendar, day: string): Clock | null {
  if (day >= "2016-01-01") return extendedResearchSession(day);
  const entry = old.days[day];
  return entry
    ? { session: day, openAt: stamp(day, "093000"), closeAt: stamp(day, entry.early ? "130000" : "160000") }
    : null;
}
function dates(from: string, through: string, calendar: (d: string) => Clock | null) {
  const result: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(through); t += dayMs) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (calendar(day)) result.push(day);
  }
  return result;
}
export function firstEligibleGuidanceSession(filings: Filing[], calendar: (day: string) => Clock | null) {
  const after = filings
    .flatMap((r) => [r.reportDate, r.filingDate, newYorkDate(r.acceptanceDateTime)])
    .sort()
    .at(-1)!;
  if (after < "2013-01-01" || after >= firstForecast.slice(0, 10)) return null;
  for (let i = 1; i <= 8; i++) {
    const day = new Date(Date.parse(after) + i * dayMs).toISOString().slice(0, 10);
    const clock = calendar(day);
    if (clock)
      return isFullKibotSession(clock.openAt, clock.closeAt) && clock.closeAt < firstForecast
        ? { after, clock }
        : null;
  }
  throw new Error("No following scheduled QQQ session");
}

type Fact = {
  accn: string;
  form: string;
  start?: string;
  end: string;
  filed: string;
  fy: number;
  fp: string;
  val: number;
};
type TaggedFact = Fact & { tag: string };
async function statutoryFacts() {
  const originalHashes: [string, string][] = [];
  const submissions = new Map<string, Filing>();
  async function official<T>(url: string, name: string) {
    const receipt = await readResearchReceipt<Receipt>(resolve(directory, "receipts", name + ".json"));
    if (receipt?.url !== url) throw new Error("Missing original official issuer source");
    const raw = await sourceBytes(receipt);
    if (raw.length !== receipt.bytes) throw new Error("Truncated official SEC source");
    originalHashes.push([url, receipt.sha256]);
    return JSON.parse(raw.toString()) as T;
  }
  type SubmissionPage = Record<string, string[]>;
  const facts = new Map<string, TaggedFact[]>();
  for (const ticker of Object.keys(ciks) as Symbol[]) {
    const source = "https://data.sec.gov/submissions/";
    const sub = await official<{
      filings: { recent: SubmissionPage; files: { name: string; filingFrom: string; filingTo: string }[] };
    }>(source + "CIK" + ciks[ticker] + ".json", ticker + "-submissions");
    const start = ticker === "TXN" ? "2015-09-01" : "2009-01-01";
    const end = ticker === "TXN" ? "2026-11-02" : "2026-11-23";
    const pages = [sub.filings.recent];
    for (const file of sub.filings.files.filter((f) => f.filingTo >= start && f.filingFrom <= end)) {
      if (!/^CIK\d{10}-submissions-\d{3}\.json$/.test(file.name))
        throw new Error("Unexpected SEC filing history page");
      pages.push(await official<SubmissionPage>(source + file.name, sha(source + file.name)));
    }
    for (const page of pages) {
      for (const [i, accessionNumber] of page.accessionNumber.entries()) {
        const form = page.form[i],
          filed = page.filingDate[i];
        if (
          filed < start ||
          filed > end ||
          !(form === "10-K" || form === "10-Q" || (form === "8-K" && page.items[i].split(",").includes("2.02")))
        )
          continue;
        submissions.set(accessionNumber, {
          ticker,
          cik: ciks[ticker],
          accessionNumber,
          form,
          items: page.items[i],
          reportDate: page.reportDate[i],
          filingDate: filed,
          acceptanceDateTime: page.acceptanceDateTime[i],
        });
      }
    }
    const tags =
      ticker === "AMD"
        ? ["contract", "Revenues", "SalesRevenueNet"]
        : ticker === "NVDA"
          ? ["contract", "Revenues"]
          : ["contract", "SalesRevenueNet"];
    for (const tag of tags) {
      const officialTag = tag === "contract" ? "RevenueFromContractWithCustomerExcludingAssessedTax" : tag;
      const url =
        "https://data.sec.gov/api/xbrl/companyconcept/CIK" + ciks[ticker] + "/us-gaap/" + officialTag + ".json";
      const concept = await official<{ cik: number; tag: string; units: { USD: Fact[] } }>(
        url,
        ticker + "-" + tag,
      );
      if (concept.cik !== Number(ciks[ticker]) || concept.tag !== officialTag)
        throw new Error("Incorrect issuer or units in SEC original");
      for (const v of concept.units.USD) {
        if (!v.start) continue;
        const a = facts.get(v.accn) ?? [];
        a.push({ ...v, tag });
        facts.set(v.accn, a);
      }
    }
  }
  const hashes = Object.fromEntries(originalHashes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (digest(hashes) !== "1ea05eca175526e50936c011039de44f5f3832070f147b11d8f6d78d92ebc474")
    throw new Error("Original SEC archive index or statutory fact source differs from the pinned receipt");
  return { facts, submissions };
}
/** Exact period facts from the first statute. A 10-K may need its same-basis original nine-month comparator. */
export function matchesStatutoryQuarter(
  amount: number,
  filing: Filing,
  filings: Filing[],
  facts: Map<string, TaggedFact[]>,
) {
  const local = (facts.get(filing.accessionNumber) ?? []).filter(
    (v) => v.form === filing.form && v.filed === filing.filingDate && v.end === filing.reportDate && v.start,
  );
  const span = (v: Fact) => (Date.parse(v.end) - Date.parse(v.start!)) / dayMs;
  const quarterly = new Set(local.filter((v) => span(v) >= 75 && span(v) <= 105).map((v) => v.val));
  if (quarterly.size || filing.form !== "10-K") return quarterly.size === 1 && quarterly.has(amount);
  const values = new Set<number>();
  const third = filings.filter(
    (r) =>
      r.ticker === filing.ticker &&
      r.form === "10-Q" &&
      r.acceptanceDateTime < filing.acceptanceDateTime &&
      (Date.parse(filing.reportDate) - Date.parse(r.reportDate)) / dayMs >= 75 &&
      (Date.parse(filing.reportDate) - Date.parse(r.reportDate)) / dayMs <= 105,
  );
  for (const annual of local.filter((v) => span(v) >= 350 && span(v) <= 379)) {
    for (const q3 of third)
      for (const ytd of facts.get(q3.accessionNumber) ?? []) {
        if (
          ytd.start === annual.start &&
          ytd.end === q3.reportDate &&
          ytd.form === "10-Q" &&
          ytd.filed === q3.filingDate &&
          ytd.tag === annual.tag &&
          ytd.fy === annual.fy &&
          ytd.fp === "Q3"
        )
          values.add(annual.val - ytd.val);
      }
  }
  return values.size === 1 && values.has(amount);
}

async function verifyCalendar(old: OldCalendar) {
  for (const [name, receipt] of Object.entries(old.sources)) {
    const raw = (await sourceBytes(receipt)).toString();
    if (!name.endsWith(" Cboe")) continue;
    const year = name.slice(0, 4),
      lines = raw.trim().split(/\r?\n/);
    const headers = lines.shift()!.split(",");
    const venues = new Map(["NASDAQ (Q)", "NYSE (N)", "NYSE Arca (P)"].map((v) => [v, new Set<string>()]));
    for (const line of lines) {
      const row = line.split(",");
      if (+row[headers.indexOf("Total Shares")] > 0 && +row[headers.indexOf("Total Trade Count")] > 0)
        venues.get(row[headers.indexOf("Market Participant")])?.add(row[headers.indexOf("Day")]);
    }
    const expected = Object.keys(old.days)
      .filter((d) => d.startsWith(year))
      .sort();
    if (expected.length !== 252 || [...venues.values()].some((v) => digest([...v].sort()) !== digest(expected)))
      throw new Error("Original exchange activity does not confirm the older session calendar");
  }
}

async function loadSources(reg: Registration) {
  const dep = reg.policy.dependencies;
  const [native, ti, old, cached, filingsA, filingsT, exhibitsA, exhibitsT, statutory] = await Promise.all([
    sealed<{ pairs: Pair[] }>("source-only-matches.json", dep["source-only-matches.json"]),
    sealed<{ pairs: Pair[] }>("txn-source-matches.json", dep["txn-source-matches.json"]),
    sealed<OldCalendar>("older-calendar-private.json", dep["older-calendar-private.json"]),
    sealed<Target[]>("qqq-source-candidates.json", dep["qqq-source-candidates.json"]),
    sealed<Record<string, Filing[]>>("filings.json", fileSHA.originalFilings),
    sealed<Record<string, Filing[]>>("txn-filings.json", fileSHA.texasFilings),
    sealed<Exhibit[]>("originals.json", fileSHA.originalExhibits),
    sealed<Exhibit[]>("txn-official-exhibits.json", fileSHA.texasExhibits),
    statutoryFacts(),
  ]);
  await verifyCalendar(old);
  const filings = Object.values({ ...filingsA, ...filingsT }).flat();
  for (const f of filings) {
    const original = statutory.submissions.get(f.accessionNumber);
    if (!original || (Object.keys(original) as (keyof Filing)[]).some((k) => original[k] !== f[k]))
      throw new Error("SEC submission and the source's original acceptance and filing clocks disagree");
  }
  const byId = new Map(filings.map((f) => [f.accessionNumber, f]));
  const exhibits = new Map([...exhibitsA, ...exhibitsT].map((e) => [e.accessionNumber, e]));
  const verified = new Set<string>();
  async function checkExhibit(filing: Filing, expected: string) {
    const e = exhibits.get(filing.accessionNumber);
    const folder =
      "https://www.sec.gov/Archives/edgar/data/" +
      Number(filing.cik) +
      "/" +
      filing.accessionNumber.replaceAll("-", "") +
      "/";
    if (
      filing.form !== "8-K" ||
      !filing.items.split(",").includes("2.02") ||
      !e?.original ||
      !e.index ||
      e.original[1] !== expected ||
      e.index[0] !== folder + filing.accessionNumber + "-index.htm" ||
      !e.original[0].startsWith(folder) ||
      e.acceptanceDateTime !== filing.acceptanceDateTime ||
      e.ticker !== filing.ticker
    )
      throw new Error("Original issuer exhibit or acceptance time mismatch");
    if (verified.has(expected)) return;
    const index = await sourceBytes({ sha256: e.index[1] });
    if (!index.toString().includes(basename(e.original[0])))
      throw new Error("Exhibit is absent from its original SEC index");
    await sourceBytes({ sha256: expected });
    verified.add(expected);
  }
  const grouped = new Map<string, { p: Pair; after: string; clock: Clock }[]>();
  const pairs = [...native.pairs, ...ti.pairs];
  for (const p of pairs) {
    const prior = byId.get(p.prior),
      actual = byId.get(p.actual),
      ledger = byId.get(p.filedAccn);
    if (
      !prior ||
      !actual ||
      !ledger ||
      [prior, actual, ledger].some((r) => r.ticker !== p.ticker) ||
      ledger.reportDate !== p.periodEnd ||
      prior.acceptanceDateTime !== p.priorAt ||
      actual.acceptanceDateTime !== p.actualAt ||
      ledger.acceptanceDateTime !== p.filedAt ||
      prior.filingDate >= p.periodEnd ||
      p.periodEnd > actual.reportDate
    )
      throw new Error("Quarter, issuer or original filing clocks do not agree");
    const [low, high, mid] = p.rangeMillions.map(Number);
    if (
      !(low > 0 && high >= low && Number.isFinite(mid) && Math.abs((low + high) / 2 - mid) < 1e-7) ||
      !matchesStatutoryQuarter(Math.round(Number(p.actualMillions) * 1e6), ledger, filings, statutory.facts)
    )
      throw new Error("Original consolidated statutory revenue or management range cannot be verified");
    await checkExhibit(prior, p.priorExhibitSha);
    await checkExhibit(actual, p.actualExhibitSha);
    const selection = firstEligibleGuidanceSession([prior, actual, ledger], (d) => studyClock(old, d));
    if (!selection || (p.ticker === "AMD" && selection.after < "2018-12-24")) continue;
    const day = selection.clock.session;
    const members = grouped.get(day) ?? [];
    members.push({ p, ...selection });
    grouped.set(day, members);
  }
  const average = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const targets: Target[] = [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, members]) => ({
      day,
      clock: members[0].clock,
      asOfCutoff: stamp(day, "074800"),
      control: average(
        members.map(({ p }) => Math.log1p((Date.parse(day) - Date.parse(newYorkDate(p.actualAt))) / dayMs)),
      ),
      feature: average(members.map(({ p }) => 100 * (Number(p.actualMillions) / Number(p.rangeMillions[2]) - 1))),
      filings: members.map(({ p, after }) => ({
        ticker: p.ticker,
        prior: p.prior,
        actual: p.actual,
        filed: p.filedAccn,
        afterDay: after,
      })),
    }));
  if (digest(targets) !== digest(cached))
    throw new Error("Original filing chronology no longer reproduces the sealed earnings inputs");
  return {
    old,
    targets,
    sourceSummary: {
      pairedIssuerQuarters: pairs.length,
      prelaunchIssuerQuarters: pairs.filter((p) => p.availableNoEarlierThan < firstForecast).length,
      distinctFeatureTargets: targets.length,
      confirmedOlderSessions: Object.keys(old.days).length,
      verifiedOriginalExhibits: verified.size,
      inputSHA256: dep["qqq-source-candidates.json"],
    },
  };
}

async function basisRows(year: YearPrices, basis: "raw" | "splits", old: OldCalendar) {
  const ref = basis === "raw" ? year.rawRef : year.splitsRef;
  const name = basename(ref);
  const reused = ref.startsWith("private-technical-momentum/");
  const allowed = reused ? "private-technical-momentum/" : "private-issuer-guidance-archive-qualification/prices/";
  if (
    ref !== allowed + name ||
    !new RegExp("^QQQ-" + year.year + "-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}-" + basis + "\\.json$").test(
      name,
    )
  )
    throw new Error("Unexpected private price reference");
  const path = resolve(web, ".consensus", ref),
    receipt = await readResearchReceipt<ResearchPriceReceipt>(path);
  const sourceHash = year[basis],
    normalized = basis === "raw" ? year.rawNormalized : year.splitsNormalized;
  if (
    !receipt ||
    receipt.instrument !== "QQQ" ||
    !receipt.from.startsWith(year.year) ||
    !receipt.through.startsWith(year.year) ||
    receipt.from > year.from ||
    receipt.through < year.through ||
    receipt.through >= firstForecast.slice(0, 10) ||
    receipt.sha256 !== sourceHash ||
    receipt.priceDigest !== normalized ||
    digest(receipt.sessions) !== normalized
  )
    throw new Error("Private QQQ price checksum, ticker or date range mismatch");
  const clock = (d: string) => studyClock(old, d),
    sessions = dates(receipt.from, receipt.through, clock);
  if (
    receipt.sessions.length !== sessions.length ||
    receipt.sessions.some((p, i) => {
      const c = clock(sessions[i])!;
      return (
        p.session !== c.session ||
        p.openAt !== c.openAt ||
        p.closeAt !== c.closeAt ||
        ![p.open, p.close].every((n) => Number.isFinite(n) && n > 0)
      );
    })
  )
    throw new Error("QQQ prices disagree with the independently confirmed exchange sessions");
  if (!reused) {
    const csv = await bytes(path.replace(/\.json$/, ".csv"), 65_536);
    if (sha(csv) !== sourceHash || digest(parseKibotDaily(csv.toString(), sessions, clock)) !== normalized)
      throw new Error("QQQ original price bytes do not reproduce the dated full and shortened sessions");
  }
  return new Map(receipt.sessions.map((s) => [s.session, s]));
}

export function guidanceBlockInterval(differences: number[]): [number, number] {
  if (differences.length < 3 || differences.some((n) => !Number.isFinite(n)))
    throw new Error("Block resampling needs at least three finite paired errors");
  const deltas: number[] = [];
  let seed = parseInt(QQQ_GUIDANCE_POLICY_SHA256.slice(0, 8), 16);
  for (let sample = 0; sample < 10_000; sample++) {
    const resampled: number[] = [];
    while (resampled.length < differences.length) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const start = Math.floor((seed / 4294967296) * (differences.length - 2));
      resampled.push(...differences.slice(start, start + 3));
    }
    deltas.push(resampled.slice(0, differences.length).reduce((a, b) => a + b, 0) / differences.length);
  }
  deltas.sort((a, b) => a - b);
  return [deltas[249], deltas[9749]];
}

/** Recompute the frozen historical target set and the matched models using original, private receipts. */
export async function replayIssuerGuidanceQqq(cached = true, sourcesOnly = false, expectedBefore?: string) {
  if (!cached) throw new Error("Registered earnings validation requires offline replay");
  const { history } = await verifyPublicationTree(web);
  if (history[0]?.issuedAt !== firstForecast || (expectedBefore !== undefined && expectedBefore !== firstForecast))
    throw new Error("The private earnings study must precede the original public forecast");
  const reg = await sealed<Registration>("qqq-guidance-study-registration.json", fileSHA.register);
  const publicPolicy = JSON.parse(
    await readFile(new URL("./issuer-guidance-qqq-study-policy.json", import.meta.url), "utf8"),
  );
  if (
    reg.policy.id !== QQQ_GUIDANCE_METHOD ||
    reg.policySHA256 !== QQQ_GUIDANCE_POLICY_SHA256 ||
    digest(publicPolicy) !== digest(reg.policy)
  )
    throw new Error("The portable policy differs from the original earnings registration");
  const { old, targets, sourceSummary } = await loadSources(reg);
  if (sourcesOnly) return { sourceSummary, result: null };
  const original = await sealed<PriceSeal>("qqq-sealed-validation.json", fileSHA.result);
  if (
    original.method !== QQQ_GUIDANCE_METHOD ||
    original.asOf !== firstForecast ||
    original.policySHA256 !== QQQ_GUIDANCE_POLICY_SHA256 ||
    original.sourceSHA256 !== sourceSummary.inputSHA256
  )
    throw new Error("Wrong registered study or sealed QQQ source inputs");
  const rows: TrainingRow[] = [],
    dropped: { day: string; reason: string }[] = [];
  for (const year of original.prices) {
    const members = targets.filter((t) => t.day.startsWith(year.year + "-"));
    if (year.from !== members[0]?.day || year.through !== members.at(-1)?.day)
      throw new Error("Target coverage differs from the sealed annual request");
    const [raw, splits] = await Promise.all([basisRows(year, "raw", old), basisRows(year, "splits", old)]);
    for (const target of members) {
      const a = raw.get(target.day),
        b = splits.get(target.day);
      if (!a || !b || a.closeAt !== target.clock.closeAt || target.asOfCutoff >= a.openAt)
        throw new Error("Missing matched full, post-filing QQQ source row");
      if (Math.sign(a.close - a.open) !== Math.sign(b.close - b.open)) {
        dropped.push({ day: target.day, reason: "Direction of original price basis and split-only differs" });
        continue;
      }
      rows.push({
        id: QQQ_GUIDANCE_METHOD + ":" + target.day,
        engineVersion: QQQ_GUIDANCE_METHOD,
        issuedAt: target.asOfCutoff,
        labelKnownAt: a.closeAt,
        up: a.close > a.open ? 1 : 0,
        features: [target.control, target.feature],
      });
    }
  }
  if (rows.length + dropped.length !== targets.length || digest(dropped) !== digest(original.dropped))
    throw new Error("Missing or duplicate QQQ target years");
  const combined = trainCandidate(rows, firstForecast),
    control = trainCandidate(
      rows.map((r) => ({ ...r, features: [r.features[0]] })),
      firstForecast,
    );
  if (
    combined.status !== "evaluated" ||
    control.status !== "evaluated" ||
    digest(combined) !== digest(original.combined) ||
    digest(control) !== digest(original.control) ||
    digest(combined.split) !== digest(control.split)
  )
    throw new Error("Matched QQQ fits differ from the first sealed result");
  const interval = guidanceBlockInterval(
    chronologicalSplit(rows).test.map(
      (r) =>
        (predict(control.model, [r.features[0]]) - r.up) ** 2 - (predict(combined.model, r.features) - r.up) ** 2,
    ),
  );
  const summary = {
    eligible: targets.length,
    paired: rows.length,
    excluded: dropped.length,
    availableFrom: targets[0].day,
    availableThrough: targets.at(-1)!.day,
    status: combined.status,
    split: combined.split,
    combinedBrier: combined.candidateBrier,
    controlBrier: control.candidateBrier,
    trainingRateBrier: combined.baseRateBrier,
    coinBrier: combined.coinBrier,
    earningsCoefficient: combined.model.weights[1],
    controlMinusAugmentedMean: control.candidateBrier - combined.candidateBrier,
    interval95: interval,
    clearsResearchGate:
      combined.model.weights[1] > 0 &&
      combined.candidateBrier <
        Math.min(control.candidateBrier, combined.baseRateBrier, combined.coinBrier) - 0.01,
  };
  if (digest(summary) !== digest(original.summary))
    throw new Error("Recomputed earnings performance differs from its sealed aggregate");
  return {
    sourceSummary,
    result: {
      method: QQQ_GUIDANCE_METHOD,
      policySHA256: QQQ_GUIDANCE_POLICY_SHA256,
      registeredAt: reg.registeredAt,
      before: firstForecast,
      firstEdition: history[0].id,
      sealedSHA256: fileSHA.result,
      combined,
      control,
      summary,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((a) => a !== "--cached-only" && a !== "--sources-only"))
    throw new Error("Use --cached-only or --sources-only");
  const { sourceSummary, result } = await replayIssuerGuidanceQqq(true, process.argv.includes("--sources-only"));
  console.log(JSON.stringify(result?.summary ?? sourceSummary, null, 2));
}
