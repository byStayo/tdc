import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { publicDate } from "../public-normalization.ts";
import { immutableSourceReceipt } from "../publication-storage.ts";
import { sourceChunk, sourceFailureKind, sourceResponse } from "./source-failure.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const BLS_PAYROLL_NEWS_ID = "bls-payroll-revision-news";
const catalog = "https://www.bls.gov/bls/news-release/empsit.htm";
const origin = "https://www.bls.gov";
const usage =
  "Bureau of Labor Statistics numerical news release data. BLS permits reuse with source credit. https://www.bls.gov/opub/copyright-information.htm";
const methodology =
  "Use the originally announced monthly headline and the two signed payroll revisions. Reconcile the reported combined change to the components and to the prior published release. Keep the first verified capture and the original 8:30 a.m. Eastern release time.";
const limitation =
  "This describes a change in estimates of prior U.S. employment. Revisions can include sampling and seasonal changes. The reading supplies context for the broad market and long Treasuries.";
const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthPattern = months.join("|");
const numeric = "[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?: (?:million|thousand))?";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type ReleaseLink = { period: string; day: string; url: string };
type Revision = { period: string; before: number; after: number };
type Release = {
  period: string;
  releasedAt: string;
  headline: number;
  revisions: Revision[];
  combined: number | null;
};
type SourceDoc = { url: string; sha256: string; retrievedAt: string; bytes: Buffer };
export type BlsPayrollNewsEvidence = {
  period: string;
  releasedAt: string;
  headline: number;
  revisions: Revision[];
  combined: number;
  previous: {
    period: string;
    url: string;
    releasedAt: string;
    sha256: string;
    headline: number;
    olderRevised: number;
  };
  firstVerifiedAt: string;
};
type BlsSignal = Signal & { blsPayrollNews?: BlsPayrollNewsEvidence };
class PayrollError extends Error {}
const instant = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shaOK = (s: string) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const stamp = (day: string) => newYorkTimestamp(day.replaceAll("-", "") + "T083000")!;
const periodOK = (v: string) => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
function changeMonth(period: string, shift: number): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + shift, 1)).toISOString().slice(0, 7);
}
function monthEnd(period: string): string {
  return new Date(Date.parse(changeMonth(period, 1) + "-01") - 86400000).toISOString().slice(0, 10);
}
function originalUrl(day: string) {
  return origin + "/news.release/archives/empsit_" + day.slice(5, 7) + day.slice(8) + day.slice(0, 4) + ".htm";
}
function plain(text: string) {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:ndash|mdash|minus);|[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
function monthNumber(name: string) {
  return String(months.findIndex((m) => m.toLowerCase() === name.toLowerCase()) + 1).padStart(2, "0");
}
function jobs(text: string): number {
  const [count, unit] = text.replaceAll(",", "").split(" ");
  const whole = Number(count) * (unit === "million" ? 1_000_000 : unit === "thousand" ? 1_000 : 1);
  if (!Number.isSafeInteger(whole)) throw new PayrollError("Invalid BLS employment unit");
  return whole;
}
export function selectPayrollReleases(html: string, checkedAt: string): [ReleaseLink, ReleaseLink] {
  const byMonth = new Map<string, Map<string, ReleaseLink>>();
  const anchor =
    /<a\b[^>]*?\bhref=["']((?:https:\/\/www\.bls\.gov)?\/news\.release\/archives\/empsit_(\d{2})(\d{2})(\d{4})\.htm)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const title = plain(match[5]).match(new RegExp("^(" + monthPattern + ") (\\d{4}) Employment Situation$", "i"));
    if (!title) continue;
    const day = match[4] + "-" + match[2] + "-" + match[3];
    if (publicDate(day) !== day || stamp(day) > checkedAt) continue;
    const period = title[2] + "-" + monthNumber(title[1]);
    if (period >= day.slice(0, 7)) throw new PayrollError("BLS archive contains an inconsistent reference month");
    const link = { period, day, url: originalUrl(day) };
    const issues = byMonth.get(period) ?? new Map<string, ReleaseLink>();
    issues.set(link.url, link);
    byMonth.set(period, issues);
  }
  const newest = [...byMonth.keys()].sort().at(-1);
  if (!newest) throw new PayrollError("BLS archive did not identify a completed release");
  const pair = [newest, changeMonth(newest, -1)].map((period) => {
    const issues = byMonth.get(period);
    if (issues?.size !== 1)
      throw new PayrollError("BLS archive does not uniquely identify each of the two releases");
    return [...issues.values()][0];
  });
  if (pair[1].day >= pair[0].day) throw new PayrollError("Two consecutive BLS releases are unavailable");
  return [pair[0], pair[1]];
}
function headline(t: string) {
  const parts = t.slice(0, 1350).split(/(?:total )?nonfarm payroll employment/i);
  const clause = parts[1]?.slice(0, 140) ?? "";
  const direct = clause.match(
    new RegExp(
      "^ (rose|increased|grew|advanced|fell|declined|decreased|dropped|edged up|edged down)(?: (?:sharply|substantially|further|again|slightly|modestly|significantly))?(?: by|, by|) (" +
        numeric +
        ")",
      "i",
    ),
  );
  if (direct)
    return jobs(direct[2]) * (/^(fell|declined|decreased|dropped|edged down)$/i.test(direct[1]) ? -1 : 1);
  const small = clause.match(
    new RegExp(
      "^ (?:was (?:little|essentially|virtually) changed|changed little|was essentially unchanged|was unchanged|was flat)[^(.;]{0,40}\\((" +
        numeric +
        ")\\)",
      "i",
    ),
  );
  const stated = clause.match(
    new RegExp("^ (?:edged (?:up|down) in (?:" + monthPattern + ") |)\\((" + numeric + ")\\)", "i"),
  );
  const signed = (small ?? stated)?.[1];
  if (!signed || !/^[+-]/.test(signed))
    throw new PayrollError("BLS payroll headline lacks an explicit signed change");
  return jobs(signed);
}
export function parsePayrollRelease(html: string, link: ReleaseLink): Release {
  const narrative = html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
  if (!narrative || narrative.index === undefined)
    throw new PayrollError("BLS original news release narrative is missing");
  const prefix = plain(html.slice(Math.max(0, narrative.index - 20_000), narrative.index));
  if (
    /(?:this|the) (?:news )?release (?:was|has been|is being) (?:re-?issued|corrected|re-released)|release (?:was|has been) (?:updated|amended) (?:on|to correct)/i.test(
      prefix,
    )
  ) {
    throw new PayrollError("BLS identified a corrected release");
  }
  const text = plain(narrative[1]);
  if (/re-?issued|corrected version|news release was corrected|re-released/i.test(text.slice(0, 1000)))
    throw new PayrollError("BLS identified a corrected release");
  const embargo = text
    .slice(0, 270)
    .match(
      new RegExp(
        "embargoed(?: USDL-\\d{2}-\\d+)? until.{0,60}?8:30 a\\.m\\. \\((E[DS]?T)\\) (Monday|Tuesday|Wednesday|Thursday|Friday), (" +
          monthPattern +
          ") (\\d{1,2}), (\\d{4})",
        "i",
      ),
    );
  if (!embargo) throw new PayrollError("BLS original release clock is missing");
  const day = embargo[5] + "-" + monthNumber(embargo[3]) + "-" + embargo[4].padStart(2, "0");
  if (day !== link.day || link.url !== originalUrl(day))
    throw new PayrollError("BLS original release date differs from archive");
  const releasedAt = stamp(day);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" }).format(
    new Date(releasedAt),
  );
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: "America/New_York" })
    .formatToParts(new Date(releasedAt))
    .find((x) => x.type === "timeZoneName")?.value;
  if (weekday !== embargo[2] || (embargo[1] !== "ET" && embargo[1] !== zone))
    throw new PayrollError("BLS release clock and date disagree");
  const title = text.match(
    new RegExp("THE EMPLOYMENT SITUATION\\s*-+\\s*(" + monthPattern + ")\\s+(\\d{4})", "i"),
  );
  if (!title || title[2] + "-" + monthNumber(title[1]) !== link.period)
    throw new PayrollError("BLS release title differs from archive");
  const payrollHeadline = headline(text.slice(title.index! + title[0].length));
  const marker = text.match(/The changes? in total nonfarm (?:payroll )?employment for /i);
  if (!marker) throw new PayrollError("BLS original revision paragraph is missing");
  const revisionText = text.slice(marker.index, marker.index! + 1100);
  const values = new Map<string, { before: number; after: number }>();
  function add(month: string, before: number, after: number) {
    const number = monthNumber(month);
    if (values.has(number)) throw new PayrollError("Duplicate BLS revision month");
    values.set(number, { before, after });
  }
  const changed = new RegExp(
    "\\b(?:employment|change) (?:for|from) (" +
      monthPattern +
      ") was (?:revised|adjusted)(?:(?!\\band the change\\b).){0,75}?\\bfrom (" +
      numeric +
      ") to (" +
      numeric +
      ")",
    "gi",
  );
  for (const m of revisionText.matchAll(changed)) add(m[1], jobs(m[2]), jobs(m[3]));
  const held = new RegExp(
    "\\b(?:employment|change) (?:for|from) (" +
      monthPattern +
      ") (?:remained (?:at |)|was (?:unchanged|unrevised) at )(" +
      numeric +
      ")",
    "gi",
  );
  for (const m of revisionText.matchAll(held)) add(m[1], jobs(m[2]), jobs(m[2]));
  const revisions = [-2, -1].map((offset) => {
    const period = changeMonth(link.period, offset),
      pair = values.get(period.slice(-2));
    if (!pair) throw new PayrollError("BLS did not report both prior monthly changes with numerical levels");
    return { period, ...pair };
  });
  if (values.size !== 2) throw new PayrollError("BLS revisions cover an unexpected reporting period");
  const total = revisionText.match(
    new RegExp(
      "(?:were|was|is|are) (" +
        numeric +
        ") (higher|lower|more|less|greater|fewer) than (?:was |had been |)previously reported",
      "i",
    ),
  );
  const combined = total ? jobs(total[1]) * (/^(lower|less|fewer)$/i.test(total[2]) ? -1 : 1) : null;
  if (combined !== null && revisions.reduce((sum, x) => sum + x.after - x.before, 0) !== combined)
    throw new PayrollError("BLS stated and computed combined revisions differ");
  return { period: link.period, releasedAt, headline: payrollHeadline, revisions, combined };
}

async function fetchDocument(url: string, fetcher: Fetcher, now: () => string): Promise<SourceDoc> {
  const response = await sourceResponse(fetcher, url, {
    redirect: "error",
    signal: AbortSignal.timeout(18_000),
    headers: {
      "User-Agent": "The Daily Consensus economic research support@thedailyconsensus.com",
      Accept: "text/html",
    },
  });
  if (response.url && response.url !== url) throw new PayrollError("BLS source URL changed");
  const reader = response.body!.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      size += part.value.length;
      if (size > 3 * 1024 * 1024) throw new PayrollError("BLS original exceeds the supported document size");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new PayrollError("Empty BLS original");
  const bytes = Buffer.concat(parts);
  return { url, sha256: hash(bytes), retrievedAt: now(), bytes };
}
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
type Original = { url: string; sha256: string; retrievedAt: string; gzip: string };
function storeOriginal(doc: SourceDoc): Original {
  return {
    url: doc.url,
    sha256: doc.sha256,
    retrievedAt: doc.retrievedAt,
    gzip: gzipSync(doc.bytes).toString("base64"),
  };
}
function replayOriginal(source: Original, link: ReleaseLink, checkedAt: string): Release {
  if (
    source.url !== link.url ||
    !instant(source.retrievedAt) ||
    source.retrievedAt > checkedAt ||
    source.retrievedAt < stamp(link.day)
  )
    throw new PayrollError("Invalid first BLS source capture");
  const bytes = gunzipSync(Buffer.from(source.gzip, "base64"), { maxOutputLength: 3 * 1024 * 1024 });
  if (!bytes.length || hash(bytes) !== source.sha256)
    throw new PayrollError("The private BLS original failed its checksum");
  return parsePayrollRelease(decode(bytes), link);
}
function base(checkedAt: string): BlsSignal {
  return {
    id: BLS_PAYROLL_NEWS_ID,
    family: "news",
    title: "U.S. payroll revisions",
    shortLabel: "Payroll revisions",
    instruments: ["MARKET", "TLT"],
    directionalInstruments: [],
    status: "unavailable",
    summary: "A verified BLS employment release and its prior vintage are pending.",
    source: {
      name: "U.S. Bureau of Labor Statistics · Employment Situation",
      url: catalog,
      retrievedAt: checkedAt,
      observedAt: null,
      releasedAt: null,
      frequency: "monthly",
      attribution: "U.S. Bureau of Labor Statistics, Employment Situation news releases.",
      usage,
      sha256: null,
    },
    methodology,
    limitation,
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 70,
    unit: "jobs",
  };
}
function reading(e: BlsPayrollNewsEvidence) {
  const date = monthEnd(e.period);
  const sign = (v: number) => v.toLocaleString("en-US", { signDisplay: "exceptZero" });
  const metrics = [
    { label: "Originally announced payroll change", value: e.headline, unit: "jobs", date },
    ...e.revisions.map((r) => ({
      label: "Revision to " + r.period + " payroll change",
      value: r.after - r.before,
      unit: "jobs",
      date: monthEnd(r.period),
    })),
  ];
  return {
    summary: `BLS reported a payroll change of ${sign(e.headline)} jobs for ${e.period}. It revised the previous two months by a combined ${sign(e.combined)} jobs.`,
    metrics,
    series: [{ value: e.combined, date }],
  };
}
export async function collectBlsPayrollNews(
  fetcher: Fetcher = fetch,
  now: () => string = () => new Date().toISOString(),
  receiptDirectory?: string,
): Promise<BlsSignal> {
  const start = now(),
    baseline = base(start);
  try {
    const index = await fetchDocument(catalog, fetcher, now);
    const [latest, prior] = selectPayrollReleases(decode(index.bytes), start);
    const [currentDoc, priorDoc] = await Promise.all([
      fetchDocument(latest.url, fetcher, now),
      fetchDocument(prior.url, fetcher, now),
    ]);
    const current = parsePayrollRelease(decode(currentDoc.bytes), latest);
    const previous = parsePayrollRelease(decode(priorDoc.bytes), prior);
    if (latest.period.endsWith("-01") || current.combined === null)
      throw new PayrollError("BLS did not provide comparable nonbenchmark payroll revisions");
    if (
      current.revisions[1].before !== previous.headline ||
      current.revisions[0].period !== previous.revisions[1].period ||
      current.revisions[0].before !== previous.revisions[1].after
    )
      throw new PayrollError("The two payroll changes differ from their previously published BLS levels");
    type Pair = { current: Original; previous: Original; firstVerifiedAt: string };
    const receipt = await immutableSourceReceipt<Pair>(
      receiptDirectory,
      "bls-payroll-" + latest.period + ".json",
      async () => ({
        current: storeOriginal(currentDoc),
        previous: storeOriginal(priorDoc),
        firstVerifiedAt: now(),
      }),
      (stored) => {
        const checkedAt = now();
        if (
          !instant(stored.firstVerifiedAt) ||
          stored.firstVerifiedAt > checkedAt ||
          stored.firstVerifiedAt < stored.current.retrievedAt ||
          stored.firstVerifiedAt < stored.previous.retrievedAt
        )
          throw new PayrollError("BLS first-pair verification clock is inconsistent");
        const oldCurrent = replayOriginal(stored.current, latest, checkedAt),
          oldPrior = replayOriginal(stored.previous, prior, checkedAt);
        if (
          JSON.stringify(oldCurrent) !== JSON.stringify(current) ||
          JSON.stringify(oldPrior) !== JSON.stringify(previous)
        )
          throw new PayrollError("The BLS originals changed since first verification");
      },
    );
    const evidence: BlsPayrollNewsEvidence = {
      period: current.period,
      releasedAt: current.releasedAt,
      headline: current.headline,
      revisions: current.revisions,
      combined: current.combined,
      previous: {
        period: previous.period,
        url: prior.url,
        releasedAt: previous.releasedAt,
        sha256: receipt.previous.sha256,
        headline: previous.headline,
        olderRevised: previous.revisions[1].after,
      },
      firstVerifiedAt: receipt.firstVerifiedAt,
    };
    const signal: BlsSignal = {
      ...baseline,
      status: "available",
      ...reading(evidence),
      blsPayrollNews: evidence,
      source: {
        ...baseline.source,
        url: latest.url,
        observedAt: monthEnd(current.period),
        releasedAt: current.releasedAt,
        retrievedAt: now(),
        sha256: receipt.current.sha256,
      },
    };
    validateBlsPayrollNews(signal);
    return signal;
  } catch (error) {
    const failureKind = sourceFailureKind(error);
    let collectionNote =
      failureKind === "transport"
        ? "The BLS source connection failed."
        : "The BLS source or private receipt could not be verified.";
    if (error instanceof PayrollError) collectionNote = error.message;
    return { ...baseline, failureKind, collectionNote };
  }
}
function exact(value: object, fields: string[]) {
  return Object.keys(value).sort().join(",") === fields.sort().join(",");
}
export function validateBlsPayrollNews(signal: BlsSignal, cutoff?: string) {
  const e = signal.blsPayrollNews;
  if (signal.id !== BLS_PAYROLL_NEWS_ID) {
    if (e !== undefined) throw new PayrollError("BLS payroll evidence is attached to another signal");
    return;
  }
  const s = signal.source,
    b = base(s.retrievedAt);
  if (
    signal.family !== "news" ||
    signal.instruments.join(",") !== "MARKET,TLT" ||
    signal.directionalInstruments?.length !== 0 ||
    !exact(signal.scores, ["daily", "weekly", "monthly"]) ||
    Object.values(signal.scores).some((v) => v !== null)
  )
    throw new PayrollError("Invalid BLS news-only scope");
  if (
    s.name !== b.source.name ||
    s.attribution !== b.source.attribution ||
    s.usage !== usage ||
    s.frequency !== b.source.frequency ||
    signal.methodology !== methodology ||
    signal.limitation !== limitation ||
    signal.staleAfterDays !== b.staleAfterDays ||
    signal.unit !== b.unit ||
    !instant(s.retrievedAt) ||
    (cutoff !== undefined && (!instant(cutoff) || s.retrievedAt > cutoff))
  )
    throw new PayrollError("Invalid BLS provenance or archive cutoff");
  if (signal.status === "unavailable") {
    if (
      e !== undefined ||
      s.url !== catalog ||
      s.releasedAt !== null ||
      s.observedAt !== null ||
      s.sha256 !== null ||
      signal.metrics.length ||
      signal.series.length
    )
      throw new PayrollError("Unavailable BLS news contains a reading");
    return;
  }
  if (
    signal.status !== "available" ||
    !e ||
    !e.previous ||
    !Array.isArray(e.revisions) ||
    e.revisions.length !== 2 ||
    !exact(e, ["period", "releasedAt", "headline", "revisions", "combined", "previous", "firstVerifiedAt"]) ||
    !exact(e.previous, ["period", "url", "releasedAt", "sha256", "headline", "olderRevised"]) ||
    !periodOK(e.period) ||
    e.period.endsWith("-01") ||
    e.previous.period !== changeMonth(e.period, -1) ||
    ![e.headline, e.combined, e.previous.headline, e.previous.olderRevised].every(Number.isSafeInteger)
  )
    throw new PayrollError("Invalid BLS release or prior-vintage identity");
  if (
    !instant(e.releasedAt) ||
    !instant(e.previous.releasedAt) ||
    !instant(e.firstVerifiedAt) ||
    e.firstVerifiedAt < e.releasedAt ||
    e.firstVerifiedAt > s.retrievedAt ||
    e.previous.releasedAt >= e.releasedAt ||
    e.period >= newYorkDate(e.releasedAt).slice(0, 7) ||
    e.previous.period >= newYorkDate(e.previous.releasedAt).slice(0, 7) ||
    stamp(newYorkDate(e.releasedAt)) !== e.releasedAt ||
    stamp(newYorkDate(e.previous.releasedAt)) !== e.previous.releasedAt ||
    s.releasedAt !== e.releasedAt ||
    s.observedAt !== monthEnd(e.period) ||
    s.url !== originalUrl(newYorkDate(e.releasedAt)) ||
    e.previous.url !== originalUrl(newYorkDate(e.previous.releasedAt)) ||
    !s.sha256 ||
    !shaOK(s.sha256) ||
    !shaOK(e.previous.sha256)
  )
    throw new PayrollError("Invalid BLS source URL, digest or public clock");
  const expectedMonths = [changeMonth(e.period, -2), changeMonth(e.period, -1)];
  if (
    e.revisions.some(
      (r, i) =>
        !exact(r, ["period", "before", "after"]) ||
        r.period !== expectedMonths[i] ||
        !Number.isSafeInteger(r.before) ||
        !Number.isSafeInteger(r.after),
    ) ||
    e.revisions[0].before !== e.previous.olderRevised ||
    e.revisions[1].before !== e.previous.headline ||
    e.revisions.reduce((sum, r) => sum + r.after - r.before, 0) !== e.combined
  )
    throw new PayrollError("BLS combined revision disagrees with the two original vintages");
  const expect = reading(e);
  if (
    signal.summary !== expect.summary ||
    signal.series.length !== 1 ||
    signal.metrics.length !== expect.metrics.length
  )
    throw new PayrollError("Incomplete BLS payroll display");
  const point = signal.series[0];
  if (
    !exact(point, ["date", "value"]) ||
    point.date !== expect.series[0].date ||
    point.value !== expect.series[0].value ||
    signal.metrics.some(
      (m, i) =>
        !exact(m, ["label", "value", "date", "unit"]) ||
        m.label !== expect.metrics[i].label ||
        m.value !== expect.metrics[i].value ||
        m.unit !== expect.metrics[i].unit ||
        m.date !== expect.metrics[i].date,
    )
  )
    throw new PayrollError("BLS payroll display disagrees with the original releases");
}
