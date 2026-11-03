import { INSTRUMENTS, type Signal, type Point, type Snapshot } from "./types.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind } from "./source-failure.ts";

export const PRIVATE_CREDIT_ID = "fed-private-credit-loans";
export const PRIVATE_CREDIT_CURRENT = "https://www.federalreserve.gov/RELEASES/z1/current/html/S124_8_t.htm";
export const PRIVATE_CREDIT_UNIT = "$bn SAAR";
const SERIES = [
  ["FA443067205", "Private-credit loan net acquisition"],
  ["FA444090000", "Financial-asset net acquisition"],
  ["FA443164500", "Net fund share issues"],
] as const;

/** Append reviewed releases. Do not revise metadata for an already issued vintage.
 * The PDF's printed pages 15 and 45 establish input availability and flow units.
 * A new release requires the same source review, rather than assuming its lag.
 */
const VINTAGES: Record<string, { inputThrough: string; lastPeriod: string; pdfHash: string }> = {
  "2026-09-11": {
    inputThrough: "2026-03-31", lastPeriod: "2026-06-30",
    pdfHash: "a3d7709f1037117bb296720afdaaac31dd7128532a80602dd05d7482132183ae",
  },
};
const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/g, " ").trim();
const attr = (s: string, key: string) => s.match(new RegExp(`(?:^|\\s)${key}=["']([^"']*)["']`, "i"))?.[1];
const datedURL = (date: string) => `https://www.federalreserve.gov/releases/z1/${date.replaceAll("-", "")}/html/S124_8_t.htm`;
const pdfURL = (date: string) => `https://www.federalreserve.gov/releases/z1/${date.replaceAll("-", "")}/z1.pdf`;
function quarterEnd(label: string): string | null {
  const m = label.match(/^(20\d{2}):Q([1-4])$/);
  return m ? `${m[1]}-${["03-31", "06-30", "09-30", "12-31"][+m[2] - 1]}` : null;
}
export function privateCreditVintage(html: string, cutoff: string): string {
  if (html.length > 2_000_000) throw new Error("Fed table exceeds limit");
  const updates = [...html.matchAll(/<div\b[^>]*\bid=["']lastUpdate["'][^>]*>([\s\S]*?)<\/div>/gi)];
  if (updates.length !== 1) throw new Error("Missing or duplicate Fed release date");
  const m = plain(updates[0][1]).match(/^Last Update:\s*([A-Za-z]+) (\d{1,2}), (20\d{2})$/);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = m ? months.indexOf(m[1]) + 1 : 0;
  const date = m && month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > cutoff.slice(0, 10))
    throw new Error("Invalid or future Fed release date");
  if (!VINTAGES[date]) throw new Error("New Fed release requires units and input-lag review");
  return date;
}

/** Select by explicit series and column identities, never by a positional number scrape.
 * Annual columns are deliberately excluded; missing/conflicting quarterly cells fail closed.
 */
export function privateCreditTable(html: string, cutoff: string) {
  const releaseDate = privateCreditVintage(html, cutoff), vintage = VINTAGES[releaseDate];
  const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].filter(m => attr(m[1], "id") === "s1248t");
  if (tables.length !== 1) throw new Error("Missing or duplicate private-debt transaction table");
  const table = tables[0][2], head = table.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1];
  if (!head) throw new Error("Missing Fed period header");
  const periods = new Map<string, string>();
  const seenDates = new Set<string>();
  for (const m of head.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)) {
    const id = attr(m[1], "id");
    if (!id || !/^t\d+$/.test(id)) continue;
    const label = plain(m[2]);
    if (/^20\d{2}$/.test(label)) continue;
    const date = quarterEnd(label);
    if (!date || date > releaseDate || date > cutoff.slice(0, 10) || periods.has(id) || seenDates.has(date))
      throw new Error("Invalid, future or duplicate Fed quarter");
    periods.set(id, date); seenDates.add(date);
  }
  const ordered = [...periods.values()];
  if (ordered.length < 2 || ordered.length > 8 || ordered.at(-1) !== vintage.lastPeriod ||
      ordered.some((d, i) => i > 0 && (d <= ordered[i - 1] ||
        Date.parse(d) - Date.parse(ordered[i - 1]) > 93 * 86400000)))
    throw new Error("Unreviewed or incomplete Fed quarter window");
  const series = SERIES.map(([code, label]) => {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter(m =>
      [...m[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].some(cell => plain(cell[1]) === code));
    if (rows.length !== 1) throw new Error("Missing or duplicate Fed series");
    const values = new Map<string, number>();
    for (const cell of rows[0][1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
      const keys = (attr(cell[1], "headers") ?? "").split(/\s+/).filter(k => periods.has(k));
      if (!keys.length) continue;
      if (keys.length !== 1 || values.has(keys[0])) throw new Error("Ambiguous or duplicate Fed cell");
      const raw = plain(cell[2]);
      if (!/^-?\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(+raw)) throw new Error("Missing or invalid Fed quarterly value");
      values.set(keys[0], +raw);
    }
    if (values.size !== periods.size) throw new Error("Incomplete Fed series");
    return { code, label, points: [...periods].map(([key, date]): Point => ({date, value: values.get(key)!})) };
  });
  return { releaseDate, inputThrough: vintage.inputThrough, series };
}

export async function collectPrivateCredit(
  fetchText: (url: string) => Promise<PublicDocument>,
  now: () => string = () => new Date().toISOString(),
): Promise<Signal> {
  const base: Signal = {
    id: PRIVATE_CREDIT_ID, family: "capital", title: "Private-credit loan flows", shortLabel: "Private credit",
    instruments: [...INSTRUMENTS], directionalInstruments: [], status: "unavailable",
    summary: "Quarterly private-credit context is unavailable.",
    source: { name: "Federal Reserve · Financial Accounts S124.8.t", url: PRIVATE_CREDIT_CURRENT,
      retrievedAt: now(), observedAt: null, releasedAt: null, frequency: "quarterly",
      attribution: "Board of Governors of the Federal Reserve System, Financial Accounts of the United States",
      usage: "Federal Reserve Board-produced public-domain data, with source attribution. No third-party microdata is redistributed.", sha256: null },
    methodology: "Net acquisition of private-credit loans by private debt funds (FA443067205). Quarterly figures are billions of dollars at a seasonally adjusted annual rate (SAAR), not the cash amount moved during the quarter. Financial-asset acquisition includes these loans; net fund share issues is a distinct funding measure. No directional vote.",
    limitation: "Lagged private-credit context, not daily private-equity investment flows, capital calls, distributions or known investor intent. Figures may be revised. Each release's units and input availability require review.",
    series: [], metrics: [], scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 210, unit: PRIVATE_CREDIT_UNIT,
  };
  try {
    const current = await fetchText(PRIVATE_CREDIT_CURRENT);
    const currentTable = privateCreditTable(current.text, now());
    const url = datedURL(currentTable.releaseDate), doc = await fetchText(url);
    const parsed = privateCreditTable(doc.text, now());
    if (JSON.stringify(parsed) !== JSON.stringify(currentTable)) throw new Error("Current and dated Fed evidence disagree");
    if (!/^[a-f0-9]{64}$/.test(doc.sha256) || !Number.isFinite(Date.parse(doc.retrievedAt)) || doc.retrievedAt > now())
      throw new Error("Invalid Fed source provenance");
    const latest = parsed.series[0].points.at(-1)!;
    const estimated = latest.date > parsed.inputThrough;
    return { ...base, status: "available", summary: `${latest.value.toFixed(1)} ${PRIVATE_CREDIT_UNIT} of loan net acquisition; quarter ended ${latest.date}${estimated ? " (estimated)" : ""}.`,
      source: { ...base.source, url, sha256: doc.sha256, retrievedAt: doc.retrievedAt, observedAt: latest.date, releasedAt: parsed.releaseDate },
      series: parsed.series[0].points,
      metrics: parsed.series.map(s => ({label: s.label, value: s.points.at(-1)!.value, date: latest.date, unit: PRIVATE_CREDIT_UNIT})),
      privateCredit: { reviewVersion: "fed-private-credit-v1", inputThrough: parsed.inputThrough,
        documentation: {url: pdfURL(parsed.releaseDate), sha256: VINTAGES[parsed.releaseDate].pdfHash} },
      limitation: `${base.limitation} The ${parsed.releaseDate} release has underlying private-debt inputs only through ${parsed.inputThrough}; later quarters are estimates, not newly reported fund activity.`,
    };
  } catch (error) {
    return {...base, source: {...base.source, retrievedAt: now()}, failureKind: sourceFailureKind(error),
      summary: `Private-credit source withheld: ${error instanceof Error ? error.message : "source failure"}.`};
  }
}

/** Enforce semantic metadata during publication and archive verification. */
export function validatePrivateCredit(signal: Signal): void {
  if (signal.id !== PRIVATE_CREDIT_ID) {
    if (signal.privateCredit) throw new Error("Private-credit metadata attached to another signal");
    return;
  }
  if (signal.family !== "capital" || signal.unit !== PRIVATE_CREDIT_UNIT || signal.staleAfterDays !== 210 ||
      !signal.directionalInstruments || signal.directionalInstruments.length || Object.values(signal.scores).some(v => v !== null))
    throw new Error("Private-credit context must remain nonvoting with SAAR units");
  if (signal.status === "unavailable") {
    if (signal.privateCredit || signal.series.length || signal.metrics.length || signal.source.observedAt || signal.source.sha256)
      throw new Error("Unavailable private-credit source contains observations");
    return;
  }
  const release = signal.source.releasedAt ?? "", vintage = VINTAGES[release], meta = signal.privateCredit;
  if (!vintage || !meta || meta.reviewVersion !== "fed-private-credit-v1" || meta.inputThrough !== vintage.inputThrough ||
      meta.documentation.url !== pdfURL(release) || meta.documentation.sha256 !== vintage.pdfHash || signal.source.url !== datedURL(release) ||
      signal.source.observedAt !== vintage.lastPeriod || signal.series.at(-1)?.date !== vintage.lastPeriod ||
      signal.series.length < 2 || signal.series.some(p => !/^20\d{2}-(?:03-31|06-30|09-30|12-31)$/.test(p.date)) ||
      signal.metrics.length !== SERIES.length || signal.metrics.some((m, i) => m.label !== SERIES[i][1] || m.unit !== PRIVATE_CREDIT_UNIT || m.date !== vintage.lastPeriod) ||
      signal.metrics[0].value !== signal.series.at(-1)?.value)
    throw new Error("Private-credit vintage, units or evidence mismatch");
}

/** Scoped refresh preserves every unrelated observation and its original provenance. */
export async function refreshPrivateCredit(previous: Snapshot, fetchText: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString()): Promise<Snapshot> {
  const signal = await collectPrivateCredit(fetchText, now), issuedAt = now();
  const exists = previous.signals.some(s => s.id === PRIVATE_CREDIT_ID);
  return { ...previous, id: issuedAt.replace(/[:.]/g, "-"), issuedAt, cutoff: issuedAt,
    consensus: undefined, forecasts: undefined,
    signals: exists ? previous.signals.map(s => s.id === PRIVATE_CREDIT_ID ? signal : s) : [...previous.signals, signal],
    sourcesAttempted: 2,
    collectionErrors: [...previous.collectionErrors.filter(s => !s.startsWith(`${PRIVATE_CREDIT_ID}:`)),
      ...(signal.status === "unavailable" ? [`${PRIVATE_CREDIT_ID}: ${signal.summary}`] : [])],
  };
}
