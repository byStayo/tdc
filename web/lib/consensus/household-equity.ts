import { createHash } from "node:crypto";
import type { PublicDocument } from "./calendars.ts";
import type { Point, Signal } from "./types.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";

export const HOUSEHOLD_EQUITY_ID = "fed-household-equity-transactions";
export const HOUSEHOLD_EQUITY_CURRENT = "https://www.federalreserve.gov/releases/z1/current/html/S1M_t.htm";
export const HOUSEHOLD_EQUITY_RELEASE = "https://www.federalreserve.gov/releases/z1/";
/** Historical v1 citation; recurring collection derives its dated URL from the original release. */
export const HOUSEHOLD_EQUITY_DATED = "https://www.federalreserve.gov/releases/z1/20260911/html/S1M_t.htm";
export const HOUSEHOLD_EQUITY_SERIES = "FA153064105.Q";
export const HOUSEHOLD_EQUITY_UNIT = "$bn SAAR";
const RELEASE = "2026-09-11", QUARTER = "2026:Q2", OBSERVED = "2026-06-30";
// Independently checked native September row, including annual columns; not a raw HTML hash.
const SEPTEMBER_ROW_SHA256 = "a544718d65b9c6c8df1dcb7bc3fd31271f6ed2f9451af4c4bff3abd04418d068";
const ATTRIBUTION = "Board of Governors of the Federal Reserve System, Financial Accounts of the United States";
const USAGE = "Board-produced public-domain data, with source attribution. No third-party microdata, Board seal or endorsement is reproduced.";
const METHODOLOGY = "FA153064105.Q: household-and-nonprofit net corporate-equity asset transactions, calculated residually from total equity assets less other identified sectors. Billions of dollars at a seasonally adjusted annual rate (SAAR), not cash moved during the quarter or a change in market value. Only the latest quarter of the reviewed original release is admitted. No directional vote.";
const LIMITATION = "Combined households and nonprofit institutions, private-equity funds and personal trusts; a residual national-account estimate, not retail brokerage orders, all individual investors or ETF clicks. Includes directly held corporate equities and the fund shares defined by the Fed. The September 11, 2026 release separates hedge funds and revises the household definition from 2012Q4. Earlier current-vintage rows are not earlier publication observations.";
const plain = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
const attr = (s: string, key: string) => s.match(new RegExp(`(?:^|\\s)${key}=["']([^"']*)["']`, "i"))?.[1];
const instant = (s: string) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (s: string) => /^[a-f0-9]{64}$/.test(s);
const datedURL = (date: string, table = "S1M_t") => `https://www.federalreserve.gov/releases/z1/${date.replaceAll("-", "")}/html/${table}.htm`;
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SECTOR = "Sector includes domestic hedge funds (through 2012q3), private equity funds, and personal trusts.";
const EQUITIES = "Directly held corporate equities, including shares of closed-end funds, exchange-traded funds, real estate investment trusts, business development companies, and interval and tender offer funds.";

function publishedDate(text: string, cutoff: string): string {
  const m = /^([A-Za-z]+) (\d{1,2}), (20\d{2})$/.exec(text);
  const month = m ? months.indexOf(m[1]) + 1 : 0;
  const date = m && month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
      date < RELEASE || !instant(cutoff) || newYorkDate(cutoff) <= date)
    throw new Error("Household-equity date-only publication requires a valid subsequent New York date and the reviewed methodology");
  return date;
}

function quarter(label: string) {
  const m = /^(20\d{2}):Q([1-4])$/.exec(label);
  if (!m) throw new Error("Invalid household-equity quarter");
  return { date: `${m[1]}-${["03-31", "06-30", "09-30", "12-31"][+m[2] - 1]}`, index: +m[1] * 4 + +m[2] - 1 };
}

function publicationQuarter(label: string, releaseDate: string) {
  const period = quarter(label), lag = (Date.parse(releaseDate) - Date.parse(period.date)) / 86400000;
  if (label < QUARTER || lag < 1 || lag > 150) throw new Error("Household-equity quarter or quarterly release cadence mismatch");
  return period;
}

function bounded(html: string) {
  if (html.length > 2_000_000) throw new Error("Household-equity Fed evidence exceeds limit");
  return html;
}

function tableRelease(html: string, cutoff: string) {
  const updates = [...bounded(html).matchAll(/<div\b[^>]*\bid=["']lastUpdate["'][^>]*>([\s\S]*?)<\/div>/gi)];
  if (updates.length !== 1) throw new Error("Missing or duplicate household-equity Fed table date");
  const update = /^Last Update:\s*(.+)$/.exec(plain(updates[0][1]));
  return publishedDate(update?.[1] ?? "", cutoff);
}

function releaseIndex(html: string, cutoff: string) {
  const dates = [...bounded(html).matchAll(/<div\b[^>]*class=["']dates["'][^>]*>([\s\S]*?)<\/div>/gi)];
  const m = dates.length === 1 ? /^Release Date:\s*([A-Za-z]+ \d{1,2}, 20\d{2}) (20\d{2}:Q[1-4]) Release$/.exec(plain(dates[0][1])) : null;
  if (!m) throw new Error("Missing or ambiguous original household-equity Fed release and quarter");
  const releaseDate = publishedDate(m[1], cutoff);
  publicationQuarter(m[2], releaseDate);
  return { releaseDate, quarter: m[2] };
}

function documentClock(doc: PublicDocument, releaseDate: string, collectedAt: string) {
  if (!digest(doc.sha256) || !instant(doc.retrievedAt) || doc.retrievedAt > collectedAt || newYorkDate(doc.retrievedAt) <= releaseDate)
    throw new Error("Invalid household-equity source provenance or pre-release capture");
}

/** Parse explicit native field and period identities; never infer earlier publication observations. */
export function householdEquityTable(html: string, cutoff: string) {
  const releaseDate = tableRelease(html, cutoff);
  const text = plain(html);
  if (!/S1M\.t Households and nonprofit organizations/.test(text) ||
      !text.includes(SECTOR) || !text.includes(EQUITIES))
    throw new Error("Household-equity sector definition or method break is missing");
  for (const m of html.matchAll(/<span\b[^>]*class=["']tableunit["'][^>]*>([\s\S]*?)<\/span>/gi))
    if (plain(m[1]) !== "Billions of dollars; seasonally adjusted annual rates") throw new Error("Changed household-equity table units");
  const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].filter(m => attr(m[1], "id") === "s1mt");
  if (tables.length !== 1) throw new Error("Missing or duplicate household-equity transaction table");
  const table = tables[0][2], head = table.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1];
  if (!head) throw new Error("Missing household-equity period header");
  const periods = new Map<string, string>(), labels = new Set<string>();
  for (const m of head.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)) {
    const id = attr(m[1], "id");
    if (!id || !/^t\d+$/.test(id)) continue;
    const label = plain(m[2]);
    if (periods.has(id) || labels.has(label)) throw new Error("Duplicate household-equity period");
    if (!/^20\d{2}$/.test(label) && quarter(label).date >= releaseDate)
      throw new Error("Future or duplicate household-equity quarter");
    periods.set(id, label); labels.add(label);
  }
  const window = [...periods.values()].filter(label => label.includes(":Q"));
  if (window.length < 2 || window.length > 8 || window.some((p, i) => i > 0 && quarter(p).index !== quarter(window[i - 1]).index + 1))
    throw new Error("Incomplete household-equity quarter window");
  const latestQuarter = window.at(-1)!;
  publicationQuarter(latestQuarter, releaseDate);
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter(m =>
    [...m[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].some(cell => plain(cell[1]) === "FA153064105"));
  if (rows.length !== 1) throw new Error("Missing or duplicate household-equity series");
  if (![...rows[0][1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].some(m => plain(m[1]).replace(/\s*\(5\)$/, "") === "Corporate equities"))
    throw new Error("Changed household-equity field");
  const values = new Map<string, number>();
  for (const cell of rows[0][1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const keys = (attr(cell[1], "headers") ?? "").split(/\s+/).filter(k => periods.has(k));
    if (!keys.length) continue;
    const value = plain(cell[2]);
    if (keys.length !== 1 || values.has(keys[0])) throw new Error("Ambiguous or duplicate household-equity cell");
    if (!/^-?\d+\.\d$/.test(value) || !Number.isFinite(Number(value))) throw new Error("Invalid household-equity transaction value");
    values.set(keys[0], Number(value));
  }
  if (values.size !== periods.size) throw new Error("Incomplete household-equity series");
  const row = [...periods].map(([key, period]) => ({ period, value: values.get(key)! }));
  const seriesRowSHA256 = sha(row);
  if (releaseDate === RELEASE && seriesRowSHA256 !== SEPTEMBER_ROW_SHA256)
    throw new Error("Household-equity September native row revised without a new verified vintage");
  return { releaseDate, quarter: latestQuarter, seriesRowSHA256,
    points: row.filter(p => p.period.includes(":Q")).map((p): Point => ({ date: quarter(p.period).date, value: p.value })) };
}

function unitMatrix(html: string, cutoff: string, releaseDate: string) {
  if (tableRelease(html, cutoff) !== releaseDate) throw new Error("Mixed household-equity unit vintage");
  const units = [...html.matchAll(/<span\b[^>]*class=["']tableunit["'][^>]*>([\s\S]*?)<\/span>/gi)];
  const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].filter(m => attr(m[1], "id") === "M3.t.c");
  if (units.length !== 1 || plain(units[0][1]) !== "Billions of dollars; seasonally adjusted" || tables.length !== 1 ||
      !/<th\b[^>]*\bid=["']s1["'][^>]*>\s*Households and Nonprofit Organizations\s*<\/th>/i.test(tables[0][2]))
    throw new Error("Changed household-equity Fed unit scale or classification");
  const rows = [...tables[0][2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter(m =>
    [...m[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].some(c => plain(c[1]) === "Corporate equities"));
  const cells = rows.length === 1 ? [...rows[0][1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].filter(m =>
    (attr(m[1], "headers") ?? "").split(/\s+/).includes("s1") && plain(m[2]) === "FA153064105") : [];
  if (cells.length !== 1 || !(attr(cells[0][1], "headers") ?? "").split(/\s+/).includes("i1"))
    throw new Error("Household-equity coded matrix does not identify the native asset-transaction series");
  // The reviewed Fed code convention FA denotes transactions at a seasonally adjusted annual rate.
}

function nativeIdentity(releaseDate: string, label: string, seriesRowSHA256: string, point: Point) {
  return sha({ releaseDate, quarter: label, seriesId: HOUSEHOLD_EQUITY_SERIES, field: "Corporate equities", unit: HOUSEHOLD_EQUITY_UNIT,
    methodBreakRelease: RELEASE, revisedDefinitionFrom: "2012-10-01", seriesRowSHA256, point });
}

function baseline(retrievedAt: string): Signal {
  return {
    id: HOUSEHOLD_EQUITY_ID, family: "retail", title: "Household and nonprofit equity transactions", shortLabel: "Household equity transactions",
    instruments: ["MARKET", "SPY", "QQQ", "IWM", "DIA"], directionalInstruments: [], status: "unavailable",
    summary: "Verified household-and-nonprofit equity transactions are unavailable.",
    source: { name: "Federal Reserve · Financial Accounts S1M.t", url: HOUSEHOLD_EQUITY_CURRENT, retrievedAt,
      observedAt: null, releasedAt: null, frequency: "quarterly", attribution: ATTRIBUTION, usage: USAGE, sha256: null },
    methodology: METHODOLOGY, limitation: LIMITATION, series: [], metrics: [],
    scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 210, unit: HOUSEHOLD_EQUITY_UNIT,
  };
}

function checkpointSignal(checkpoint: NonNullable<Signal["householdEquityCheckpoint"]>): Signal {
  if (!checkpoint.source || !checkpoint.point || !checkpoint.receipt) throw new Error("Incomplete household-equity checkpoint");
  return { ...baseline(checkpoint.source.retrievedAt), status: "available", source: checkpoint.source,
    series: [checkpoint.point], metrics: [{ label: "Net corporate-equity asset transactions", ...checkpoint.point, unit: HOUSEHOLD_EQUITY_UNIT }],
    householdEquity: checkpoint.receipt };
}

export async function collectHouseholdEquity(
  read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString(), previous?: Signal,
): Promise<Signal> {
  const base = baseline(now());
  let prior: Signal | undefined;
  try {
    if (previous?.householdEquity || previous?.householdEquityCheckpoint) {
      validateHouseholdEquity(previous);
      const verified = previous.householdEquityCheckpoint ? checkpointSignal(previous.householdEquityCheckpoint) : previous;
      if (verified.source.retrievedAt > now()) throw new Error("Future household-equity checkpoint");
      prior = verified;
    }
    const releaseDoc = await read(HOUSEHOLD_EQUITY_RELEASE), release = releaseIndex(releaseDoc.text, now());
    const currentDoc = await read(HOUSEHOLD_EQUITY_CURRENT), current = householdEquityTable(currentDoc.text, now());
    const url = datedURL(release.releaseDate), doc = await read(url), dated = householdEquityTable(doc.text, now());
    if (JSON.stringify(current) !== JSON.stringify(dated)) throw new Error("Current and dated household-equity evidence disagree");
    if (release.releaseDate !== dated.releaseDate || release.quarter !== dated.quarter)
      throw new Error("Original release and household-equity tables disagree");
    const unitURL = datedURL(release.releaseDate, "M3_t_c"), unitDoc = await read(unitURL);
    unitMatrix(unitDoc.text, now(), release.releaseDate);
    const collectedAt = now();
    if (!instant(collectedAt)) throw new Error("Invalid household-equity product collection clock");
    for (const evidence of [releaseDoc, currentDoc, doc, unitDoc]) documentClock(evidence, release.releaseDate, collectedAt);
    const point = dated.points.at(-1)!;
    const nativeSHA256 = nativeIdentity(dated.releaseDate, dated.quarter, dated.seriesRowSHA256, point);
    let meta: NonNullable<Signal["householdEquity"]> = {
      reviewVersion: "fed-household-equity-v2", seriesId: HOUSEHOLD_EQUITY_SERIES, quarter: dated.quarter,
      publicationClock: "date-only", firstObservedAt: collectedAt, firstObservedSHA256: doc.sha256,
      firstEvidenceRetrievedAt: doc.retrievedAt, nativeSHA256, seriesRowSHA256: dated.seriesRowSHA256,
      publicationEvidence: { url: HOUSEHOLD_EQUITY_RELEASE, sha256: releaseDoc.sha256, retrievedAt: releaseDoc.retrievedAt },
      unitEvidence: { url: unitURL, sha256: unitDoc.sha256, retrievedAt: unitDoc.retrievedAt },
      methodBreakRelease: RELEASE, revisedDefinitionFrom: "2012-10-01",
    };
    if (prior?.householdEquity) {
      if (prior.source.releasedAt! > dated.releaseDate || prior.householdEquity.quarter > dated.quarter)
        throw new Error("Household-equity vintage or quarter moved backwards");
      if (prior.source.releasedAt === dated.releaseDate && prior.householdEquity.reviewVersion === "fed-household-equity-v2") {
        if (prior.householdEquity.nativeSHA256 !== nativeSHA256)
          throw new Error("Household-equity native series revised without a new verified vintage");
        if (prior.householdEquity.firstObservedAt > collectedAt) throw new Error("Future household-equity first collection");
        meta = structuredClone(prior.householdEquity);
      }
    }
    const signal: Signal = {
      ...base, status: "available", summary: `The Fed estimated ${point.value.toFixed(1)} $bn SAAR of household-and-nonprofit corporate-equity transactions for the quarter ended ${point.date}.`,
      source: { ...base.source, url, retrievedAt: collectedAt, observedAt: point.date, releasedAt: dated.releaseDate, sha256: doc.sha256 },
      series: [point], metrics: [{ label: "Net corporate-equity asset transactions", ...point, unit: HOUSEHOLD_EQUITY_UNIT }],
      householdEquity: meta,
    };
    validateHouseholdEquity(signal);
    return signal;
  } catch (error) {
    return { ...base, failureKind: sourceFailureKind(error),
      ...(prior?.householdEquity ? { householdEquityCheckpoint: structuredClone({ source: prior.source, point: prior.series[0], receipt: prior.householdEquity }) } : {}),
      summary: `Household-equity source withheld: ${error instanceof Error ? error.message : "source failure"}.` };
  }
}

export function validateHouseholdEquity(signal: Signal): void {
  if (signal.id !== HOUSEHOLD_EQUITY_ID) {
    if (signal.householdEquity || signal.householdEquityCheckpoint) throw new Error("Household-equity metadata attached to another signal");
    return;
  }
  const base = baseline(signal.source.retrievedAt), source = signal.source;
  if (signal.family !== "retail" || signal.title !== base.title || signal.shortLabel !== base.shortLabel ||
      signal.instruments.join(",") !== base.instruments.join(",") || signal.directionalInstruments?.length !== 0 ||
      Object.values(signal.scores).some(score => score !== null) || signal.unit !== HOUSEHOLD_EQUITY_UNIT ||
      signal.staleAfterDays !== base.staleAfterDays || signal.methodology !== METHODOLOGY || signal.limitation !== LIMITATION ||
      source.name !== base.source.name || source.attribution !== ATTRIBUTION || source.usage !== USAGE || source.frequency !== "quarterly")
    throw new Error("Invalid household-equity nonvoting admission or definition");
  if (signal.status === "unavailable") {
    if (signal.householdEquity || signal.series.length || signal.metrics.length || source.url !== HOUSEHOLD_EQUITY_CURRENT ||
        source.observedAt !== null || source.releasedAt !== null || source.sha256 !== null)
      throw new Error("Unavailable household-equity source contains observations");
    if (signal.householdEquityCheckpoint) {
      const prior = checkpointSignal(signal.householdEquityCheckpoint);
      validateHouseholdEquity(prior);
      if (prior.source.retrievedAt > source.retrievedAt) throw new Error("Future household-equity validation checkpoint");
    }
    return;
  }
  const meta = signal.householdEquity, point = signal.series[0], metric = signal.metrics[0];
  if (signal.status !== "available" || signal.householdEquityCheckpoint || !meta || !["fed-household-equity-v1", "fed-household-equity-v2"].includes(meta.reviewVersion) ||
      meta.seriesId !== HOUSEHOLD_EQUITY_SERIES || meta.publicationClock !== "date-only" ||
      meta.methodBreakRelease !== RELEASE || meta.revisedDefinitionFrom !== "2012-10-01" ||
      !instant(meta.firstObservedAt) || !/^[a-f0-9]{64}$/.test(meta.firstObservedSHA256) ||
      !instant(source.retrievedAt) || meta.firstObservedAt > source.retrievedAt || newYorkDate(meta.firstObservedAt) <= RELEASE ||
      !source.sha256 || !/^[a-f0-9]{64}$/.test(source.sha256) || signal.series.length !== 1 || !point ||
      !Number.isFinite(point.value) || signal.metrics.length !== 1 || !metric ||
      metric.date !== point.date || metric.value !== point.value || metric.label !== "Net corporate-equity asset transactions" || metric.unit !== HOUSEHOLD_EQUITY_UNIT)
    throw new Error("Household-equity vintage, clock, units or evidence mismatch");
  if (meta.reviewVersion === "fed-household-equity-v1") {
    // Preserve the original immutable v1 archive contract; v2 never inherits its capture clock.
    if (meta.quarter !== QUARTER || source.url !== HOUSEHOLD_EQUITY_DATED || source.releasedAt !== RELEASE ||
        source.observedAt !== OBSERVED || point.date !== OBSERVED)
      throw new Error("Household-equity legacy vintage mismatch");
    return;
  }
  const releaseDate = source.releasedAt;
  if (!releaseDate || !/^20\d{2}-\d{2}-\d{2}$/.test(releaseDate) || !Number.isFinite(Date.parse(releaseDate)) ||
      new Date(releaseDate).toISOString().slice(0, 10) !== releaseDate || releaseDate < RELEASE ||
      source.url !== datedURL(releaseDate) || source.observedAt !== publicationQuarter(meta.quarter, releaseDate).date || point.date !== source.observedAt ||
      newYorkDate(meta.firstObservedAt) <= releaseDate || !digest(meta.seriesRowSHA256) || !digest(meta.nativeSHA256) ||
      meta.nativeSHA256 !== nativeIdentity(releaseDate, meta.quarter, meta.seriesRowSHA256, point) ||
      (releaseDate === RELEASE && meta.seriesRowSHA256 !== SEPTEMBER_ROW_SHA256) ||
      !instant(meta.firstEvidenceRetrievedAt) || meta.firstEvidenceRetrievedAt > meta.firstObservedAt ||
      newYorkDate(meta.firstEvidenceRetrievedAt) <= releaseDate)
    throw new Error("Household-equity native vintage or first product collection mismatch");
  for (const [evidence, expectedURL] of [[meta.publicationEvidence, HOUSEHOLD_EQUITY_RELEASE], [meta.unitEvidence, datedURL(releaseDate, "M3_t_c")]] as const)
    if (!evidence || evidence.url !== expectedURL || !digest(evidence.sha256) || !instant(evidence.retrievedAt) ||
        evidence.retrievedAt > meta.firstObservedAt || newYorkDate(evidence.retrievedAt) <= releaseDate)
      throw new Error("Household-equity original publication or units evidence mismatch");
}
