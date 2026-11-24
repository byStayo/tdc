import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const TIC_RELEASE_DISCOVERY = "https://home.treasury.gov/news/press-releases?title=Treasury%20International%20Capital%20Data";
export const TIC_RELEASE_CLOCK = "https://home.treasury.gov/data/treasury-international-capital-tic-system/release-dates-of-tic-data";
const treasury = "https://home.treasury.gov";
const releasePath = /^\/news\/press-releases\/[a-z]+\d+\/?$/;
const months = "January February March April May June July August September October November December".split(" ");
const abbreviations = months.map(month => month.slice(0, 3));
const clockAt = (day: string) => newYorkTimestamp(day.replaceAll("-", "") + "T160000");
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&").replace(/&rsquo;|&#39;|’/g, "'").replace(/[\s\u00a0]+/g, " ").trim();

export function latestTicReleaseLink(html: string): string {
  for (const anchor of html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/^Treasury International Capital Data for [a-z]+(?: and [a-z]+)?(?: \d{4})?$/i.test(plain(anchor[4]))) continue;
    const url = new URL(anchor[1] || anchor[2] || anchor[3], treasury);
    if (url.origin !== treasury || url.username || url.password || url.search || url.hash || !releasePath.test(url.pathname))
      throw new Error("Unexpected Treasury press release URL");
    return treasury + url.pathname.replace(/\/$/, "");
  }
  throw new Error("Treasury search has no monthly TIC press release");
}

function releaseDate(html: string) {
  const times = Array.from(html.matchAll(/<time\b[^>]*?\sdatetime\s*=\s*["']?([0-9T:Z+.-]+)["']?[^>]*>([^<]+)<\/time>/gi));
  const dates = times.flatMap(([, iso, label]) => {
    const parts = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(plain(label));
    if (!parts || !months.includes(parts[1]) || !Number.isFinite(Date.parse(iso))) return [];
    const day = parts[3] + "-" + String(months.indexOf(parts[1]) + 1).padStart(2, "0") + "-" + parts[2].padStart(2, "0");
    if (!publicDate(day) || newYorkDate(iso) !== day) throw new Error("Conflicting Treasury date and dateline");
    return [day];
  });
  if (dates.length !== 1 || dates[0] < "2014-09-16") throw new Error("Missing dated Treasury monthly release");
  return dates[0];
}

const oldNames = ["Gross Purchases of Domestic U.S. Securities", "Gross Sales of Domestic U.S. Securities", "Domestic Securities Purchased, net (line 1 less line 2)"];
const newNames = ["Gross U.S. Sales of Domestic U.S. Securities", "Gross U.S. Purchases of Domestic U.S. Securities", "Domestic Securities, net U.S. sales (line 1 less line 2)"];
const assetLabels = ["Treasury Bonds & Notes, net", "Gov't Agency Bonds, net", "Corporate Bonds, net", "Equities, net"];
export interface TicReleaseReading {
  observationMonth: string; releasedAt: string; grossForeignPurchases: number; grossForeignSales: number;
  netAll: number; netTreasuryPrivate: number; netTreasuryOfficial: number;
}
export interface TicReleaseEvidence extends TicReleaseReading { url: string; sha256: string; retrievedAt: string }

export function parseTicRelease(html: string): TicReleaseReading {
  const day = releaseDate(html);
  const afterDateline = plain(html.slice(html.indexOf("</time>") + 7).slice(0, 16_000));
  const period = /released Treasury International Capital \(TIC\) data for (?:[A-Za-z]+(?: \([^)]*\))? and )?([A-Za-z]+) (\d{4})\b/i.exec(afterDateline);
  if (!period || !months.includes(period[1])) throw new Error("Missing original TIC observation month");
  const month = months.indexOf(period[1]), observationMonth = period[2] + "-" + String(month + 1).padStart(2, "0");
  if (observationMonth >= day.slice(0, 7)) throw new Error("TIC observation must precede the release month");
  // Some Treasury releases placed the heading and units immediately before the HTML table.
  const tables = Array.from(html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi), match => ({
    body: match[1], caption: plain(html.slice(Math.max(0, match.index - 1200), match.index)),
  })).filter(table => /TIC Monthly Reports on Cross-Border Financial Flows/i.test(table.caption + " " + plain(table.body)));
  if (tables.length !== 1) throw new Error("Ambiguous TIC financial-flows table");
  const rows = Array.from(tables[0].body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), row =>
    Array.from(row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi), cell => plain(cell[1])).filter(Boolean));
  const currentMonth = abbreviations[month];
  const header = rows.find(row => row.length === 8 && /^\d{4}$/.test(row[0]));
  const year = Number(period[2]);
  const matchesYear = (label: string, y: number) =>
    [currentMonth + "-" + String(y).slice(-2), String(y).slice(-2) + "-" + currentMonth].includes(label);
  if (!/billions of dollars, not seasonally adjusted/i.test(tables[0].caption + " " + rows.slice(0, 4).flat().join(" ")) ||
      !rows.some(row => row.includes("12 Months Through")) || !header ||
      !matchesYear(header[2], year - 1) || !matchesYear(header[3], year) ||
      header.slice(4).some((label, i) => {
        const d = new Date(Date.UTC(year, month - 3 + i, 1)), mon = abbreviations[d.getUTCMonth()];
        return label !== mon && label !== d.getUTCFullYear() + "-" + mon && label !== mon + "-" + String(d.getUTCFullYear()).slice(-2);
      }))
    throw new Error("TIC monthly, trailing-year or units header differs");
  const numbered = new Map<number, { name: string; value: number }>();
  for (const row of rows) {
    // In Excel-exported HTML, two-digit row identifiers can be displayed as '#'.
    // Accept only the four named subcomponents immediately following the numbered official subtotal.
    const next = numbered.size + 1, masked = next >= 10 && next <= 13 && /^#+$/.test(row[0]) && row[1] === assetLabels[next - 10];
    if (!masked && !/^(?:[1-9]|1[0-3])$/.test(row[0])) continue;
    const number = masked ? next : Number(row[0]), value = row.at(-1)!.replaceAll(",", "");
    if (row.length !== 10 || numbered.has(number) || !/^[+-]?\d+(?:\.\d+)?$/.test(value))
      throw new Error("Missing, ambiguous or nonnumeric monthly TIC row " + number);
    numbered.set(number, { name: row[1].replace(/\s*\/[1-3]\s*$/, "").trim(), value: Number(value) });
  }
  const grossNames = numbered.get(1)?.name === newNames[0] ? newNames : oldNames;
  const expected = [...grossNames, "Private, net", ...assetLabels, "Official, net", ...assetLabels];
  const v = expected.map((name, i) => {
    const cell = numbered.get(i + 1);
    if (!cell || cell.name.toLowerCase() !== name.toLowerCase()) throw new Error("Unexpected TIC line " + (i + 1));
    return cell.value;
  });
  const close = (a: number, b: number, bound: number) => Math.abs(a - b) <= bound + 1e-8;
  if (v[0] <= 0 || v[1] <= 0 || !close(v[0] - v[1], v[2], 0.15) || !close(v[3] + v[8], v[2], 0.15) ||
      !close(v[4] + v[5] + v[6] + v[7], v[3], 0.25) || !close(v[9] + v[10] + v[11] + v[12], v[8], 0.25))
    throw new Error("TIC gross, net or sector subtotals disagree");
  return { observationMonth, releasedAt: clockAt(day)!, grossForeignPurchases: v[0], grossForeignSales: v[1],
    netAll: v[2], netTreasuryPrivate: v[4], netTreasuryOfficial: v[9] };
}

export async function currentTicRelease(read: (url: string) => Promise<PublicDocument>): Promise<TicReleaseEvidence> {
  const index = await read(TIC_RELEASE_DISCOVERY), url = latestTicReleaseLink(index.text);
  const page = await read(url), reading = parseTicRelease(page.text);
  if (reading.releasedAt > page.retrievedAt || !/^[a-f0-9]{64}$/.test(page.sha256)) throw new Error("Unverified Treasury publication time or digest");
  return { ...reading, url, sha256: page.sha256, retrievedAt: page.retrievedAt };
}

const metricNames = ["Original release · foreign private Treasury purchases", "Original release · foreign official Treasury purchases"];
const evidenceFields = ["observationMonth", "releasedAt", "grossForeignPurchases", "grossForeignSales", "netAll",
  "netTreasuryPrivate", "netTreasuryOfficial", "url", "sha256", "retrievedAt"].sort().join(",");
function agreesWithTable(signal: Signal, reading: TicReleaseReading) {
  const last = signal.series.at(-1);
  return signal.id === "tic-for_lt_treas" && signal.family === "capital" && signal.status === "available" && !!last &&
    signal.source.observedAt === last.date && last.date.slice(0, 7) === reading.observationMonth &&
    Math.abs(last.value - reading.netTreasuryPrivate - reading.netTreasuryOfficial) <= 0.100001;
}

export function addTicRelease(signal: Signal, evidence: TicReleaseEvidence): Signal {
  if (!agreesWithTable(signal, evidence)) return signal;
  // Each press component is rounded to $0.1bn. The rolling SLT table is quoted to $0.001bn.
  const values = [evidence.netTreasuryPrivate, evidence.netTreasuryOfficial];
  return { ...signal, ticRelease: evidence, metrics: [...signal.metrics,
    ...metricNames.map((label, i) => ({ label, value: values[i], unit: "$bn", date: signal.source.observedAt! }))] };
}

export function validateTicRelease(signal: Signal, cutoff: string) {
  const e = signal.ticRelease, extra = signal.metrics.filter(metric => metricNames.includes(metric.label));
  if (!e) {
    if (extra.length) throw new Error("TIC original-release metrics lack provenance");
    return;
  }
  const day = publicDate(e.releasedAt.slice(0, 10)), url = new URL(e.url);
  const metrics = [e.netTreasuryPrivate, e.netTreasuryOfficial];
  if (Object.keys(e).sort().join(",") !== evidenceFields || !agreesWithTable(signal, e) ||
      Object.values(signal.scores).some(score => score !== null) || url.origin !== treasury || url.username || url.password ||
      !releasePath.test(url.pathname) || url.search || url.hash || !/^[a-f0-9]{64}$/.test(e.sha256) ||
      !day || e.releasedAt !== clockAt(day) || e.observationMonth >= day.slice(0, 7) ||
      !Number.isFinite(Date.parse(e.retrievedAt)) || new Date(e.retrievedAt).toISOString() !== e.retrievedAt ||
      e.releasedAt > e.retrievedAt || e.retrievedAt > cutoff || ![e.grossForeignPurchases, e.grossForeignSales,
        e.netAll, ...metrics].every(Number.isFinite) || e.grossForeignPurchases <= 0 || e.grossForeignSales <= 0 ||
      Math.abs(e.grossForeignPurchases - e.grossForeignSales - e.netAll) > 0.150001 ||
      extra.length !== 2 || extra.some((m, i) => m.label !== metricNames[i] || m.unit !== "$bn" ||
        m.date !== signal.source.observedAt || m.value !== metrics[i]))
    throw new Error("TIC original release and rolling transaction record disagree");
}
