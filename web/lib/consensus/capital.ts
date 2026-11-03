import type { PublicDocument } from "./calendars.ts";
import { INSTRUMENTS, type Signal, type Point } from "./types.ts";

export const TIC_URLS = [1, 2].map(
  (table) =>
    `https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table${table}.txt`,
);
const ASSETS = [
  {
    table: 1,
    key: "for_lt_total",
    label: "Foreign purchases · all US securities",
  },
  { table: 1, key: "for_lt_treas", label: "Foreign purchases · US Treasuries" },
  {
    table: 1,
    key: "for_lt_agcy",
    label: "Foreign purchases · US agency bonds",
  },
  {
    table: 1,
    key: "for_lt_corp",
    label: "Foreign purchases · US corporate bonds",
  },
  { table: 1, key: "for_lt_eqty", label: "Foreign purchases · US equities" },
  { table: 2, key: "us_lt_total", label: "US purchases · foreign securities" },
] as const;

export function monthEnd(month: string): string | null {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return null;
  return new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
  )
    .toISOString()
    .slice(0, 10);
}
interface CapitalPoint extends Point {
  holdings: number | null;
  valuation: number | null;
}
const numeric = (text: string | undefined) =>
  text !== undefined &&
  /^[+-]?\d+(?:\.\d+)?$/.test(text) &&
  Number.isFinite(Number(text))
    ? Number(text) / 1000
    : null;

/** Select only the published grand total; summing countries and aggregates double-counts. */
export function ticSeries(
  text: string,
  key: string,
  cutoff: string,
): CapitalPoint[] {
  const lines = text.split(/\r?\n/);
  if (!lines.slice(0, 6).some((line) => line.startsWith("Millions of dollars")))
    throw new Error("Unknown TIC units");
  const headerAt = lines.findIndex((line) =>
    line.startsWith("country\tcountry_code\tdate\t"),
  );
  if (headerAt < 0) throw new Error("Unknown TIC header");
  const header = lines[headerAt].split("\t"),
    net = header.indexOf(`${key}_net`),
    pos = header.indexOf(`${key}_pos`),
    val = header.indexOf(`${key}_valchg`);
  if (net < 0 || pos < 0 || val < 0) throw new Error("Missing TIC fields");
  const series = new Map<string, CapitalPoint>();
  for (const line of lines.slice(headerAt + 1)) {
    const fields = line.split("\t");
    if (fields[0] !== "Grand Total" || fields[1] !== "99996") continue;
    const date = monthEnd(fields[2]),
      value = numeric(fields[net]);
    if (!date || date > cutoff.slice(0, 10) || value === null) continue;
    const point = {
      date,
      value,
      holdings: numeric(fields[pos]),
      valuation: numeric(fields[val]),
    };
    if (point.holdings !== null && point.holdings < 0)
      throw new Error("Invalid TIC holdings");
    const previous = series.get(date);
    if (previous && JSON.stringify(previous) !== JSON.stringify(point))
      throw new Error("Conflicting TIC totals");
    series.set(date, point);
  }
  return [...series.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-60);
}

export async function collectCapital(
  fetchText: (url: string) => Promise<PublicDocument>,
): Promise<Signal[]> {
  const documents = await Promise.allSettled(TIC_URLS.map(fetchText));
  return ASSETS.map((asset): Signal => {
    const result = documents[asset.table - 1],
      at = new Date().toISOString();
    const signal: Signal = {
      id: `tic-${asset.key}`,
      family: "capital",
      title: asset.label,
      shortLabel: asset.label,
      instruments: [...INSTRUMENTS],
      status: "unavailable",
      series: [],
      metrics: [],
      unit: "$bn",
      staleAfterDays: 120,
      summary: "The Treasury source did not return a usable observation.",
      source: {
        name: "US Treasury · TIC",
        url: TIC_URLS[asset.table - 1],
        retrievedAt: at,
        observedAt: null,
        releasedAt: null,
        frequency: "monthly · published with a lag",
        attribution:
          "US Department of the Treasury, Treasury International Capital System",
        usage:
          "US government public data; amounts converted from millions to billions by The Daily Consensus",
        sha256: null,
      },
      scores: { daily: null, weekly: null, monthly: null },
      methodology: `TIC SLT table ${asset.table}, Grand Total country code 99996. Net transactions are separate from holdings and valuation changes. Positive means net ${asset.table === 1 ? "foreign purchases of US" : "US purchases of foreign"} securities. Monthly observation dates use the period end. No directional vote.`,
      limitation:
        "Lagged, latest-vintage cross-border transactions; revisions and custody geography can affect interpretation. These are not today's flows, private-equity flows or a forecast of prices. Holdings changes include valuation and other adjustments; they are not net purchases.",
    };
    if (result.status !== "fulfilled") return signal;
    try {
      const rows = ticSeries(
          result.value.text,
          asset.key,
          result.value.retrievedAt,
        ),
        latest = rows.at(-1);
      if (!latest) return signal;
      return {
        ...signal,
        status: "available",
        series: rows.map(({ date, value }) => ({ date, value })),
        source: {
          ...signal.source,
          retrievedAt: result.value.retrievedAt,
          observedAt: latest.date,
          sha256: result.value.sha256,
        },
        summary: `$${Math.abs(latest.value).toFixed(1)}bn net ${latest.value >= 0 ? "purchases" : "sales"} during ${latest.date.slice(0, 7)}. Monthly data, not today's flows.`,
        metrics: [
          {
            label: "Net transactions during month",
            value: latest.value,
            unit: "$bn",
            date: latest.date,
          },
          ...(latest.holdings === null
            ? []
            : [
                {
                  label: "Holdings at month end",
                  value: latest.holdings,
                  unit: "$bn",
                  date: latest.date,
                },
              ]),
          ...(latest.valuation === null
            ? []
            : [
                {
                  label: "Valuation change during month",
                  value: latest.valuation,
                  unit: "$bn",
                  date: latest.date,
                },
              ]),
        ],
      };
    } catch {
      return signal;
    }
  });
}
