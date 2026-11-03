import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { INSTRUMENTS, type Signal, type Point } from "./types.ts";
import { monthEnd } from "./capital.ts";
import type { PublicDocument } from "./calendars.ts";

export const PRIVATE_FUNDS_PAGE =
  "https://www.sec.gov/data-research/investment-management-data/division-investment-management-private-fund-statistics";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const decode = (s: string) =>
  s
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const n =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : Number(code);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
function attributes(s: string): Record<string, string> {
  return Object.fromEntries(
    [...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]),
  );
}
function xmlParts(
  bytes: Uint8Array,
  names: Set<string>,
): Record<string, string> {
  let size = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (!names.has(file.name)) return false;
      size += file.originalSize;
      if (file.originalSize > 2_000_000 || size > 6_000_000)
        throw new Error("SEC workbook XML exceeds limit");
      return true;
    },
  });
  return Object.fromEntries(
    [...names].map((name) => {
      if (!files[name]) throw new Error("Missing SEC workbook part");
      const text = strFromU8(files[name]);
      if (/<!DOCTYPE|<!ENTITY/i.test(text))
        throw new Error("Unsupported XML declarations");
      return [name, text];
    }),
  );
}
export function latestPrivateFundWorkbook(
  html: string,
  cutoff: string,
): string {
  const links = [
    ...html.matchAll(
      /href=["']([^"']*private-funds-statistics-(\d{4})-q([1-4])-supporting-data\.xlsx)["']/g,
    ),
  ]
    .map((m) => ({
      url: new URL(decode(m[1]), PRIVATE_FUNDS_PAGE),
      period: `${m[2]}-${String(+m[3] * 3).padStart(2, "0")}`,
    }))
    .filter(
      ({ url, period }) =>
        url.protocol === "https:" &&
        url.hostname === "www.sec.gov" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password &&
        !url.port &&
        /^\/files\/(?:investment\/)?private-funds-statistics-\d{4}-q[1-4]-supporting-data\.xlsx$/.test(
          url.pathname,
        ) &&
        monthEnd(period)! <= cutoff.slice(0, 10),
    )
    .sort((a, b) => b.period.localeCompare(a.period));
  if (!links.length)
    throw new Error("No supported SEC private-fund workbook linked");
  return links[0].url.href;
}

/** Reads cached numeric values only from the named SEC aggregate tables. Never executes formulas. */
export function privateFundSeries(
  bytes: Uint8Array,
  cutoff: string,
): { gross: Point[]; net: Point[]; count: Point[] } {
  if (bytes.byteLength > 2_000_000)
    throw new Error("SEC workbook exceeds 2 MB");
  const basics = xmlParts(
    bytes,
    new Set([
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
    ]),
  );
  const strings = [
    ...basics["xl/sharedStrings.xml"].matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((t) => decode(t[1]))
      .join(""),
  );
  const sheets = new Map(
    [...basics["xl/workbook.xml"].matchAll(/<sheet\b([^>]+)\/>/g)].map((m) => {
      const a = attributes(m[1]);
      return [a.name, a["r:id"]];
    }),
  );
  const rels = new Map(
    [
      ...basics["xl/_rels/workbook.xml.rels"].matchAll(
        /<Relationship\b([^>]+)\/>/g,
      ),
    ].map((m) => {
      const a = attributes(m[1]);
      return [a.Id, a.TargetMode === "External" ? "" : a.Target];
    }),
  );
  const names = ["Notes", "Tab.1.1", "Tab.2.1", "Tab.2.3"].map((name) => {
    const target = rels.get(sheets.get(name) ?? "");
    if (!target || !/^worksheets\/sheet\d+\.xml$/.test(target))
      throw new Error("Unknown SEC worksheet location");
    return `xl/${target}`;
  });
  const docs = xmlParts(bytes, new Set(names));
  function rows(xml: string): Map<string, string>[] {
    return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells = new Map<string, string>();
      for (const match of row[1].matchAll(
        /<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g,
      )) {
        const a = attributes(match[1]),
          value = match[2].match(/<v>([^<]*)<\/v>/)?.[1];
        const col = a.r?.match(/^([A-Z]+)\d+$/)?.[1];
        if (!col || value === undefined) continue;
        if (a.t === "s") {
          if (!/^\d+$/.test(value) || strings[+value] === undefined)
            throw new Error("Invalid shared string");
          cells.set(col, strings[+value]);
        } else if (!a.t || a.t === "n") cells.set(col, value);
      }
      return cells;
    });
  }
  const notes = rows(docs[names[0]]);
  for (const table of ["Tab.2.1", "Tab.2.3"]) {
    const note = notes.find((row) => row.get("A") === table)?.get("B") ?? "";
    if (!/\(\$ Billions\)/.test(note))
      throw new Error("Unknown SEC asset units");
  }
  function series(path: string): Point[] {
    const data = rows(docs[path]),
      header = data[0],
      matched = data.filter((row) => row.get("A") === "Private Equity Fund");
    if (!header || matched.length !== 1)
      throw new Error("Missing or ambiguous private equity row");
    const result: Point[] = [];
    for (const [col, period] of header) {
      const match = period.match(/^(\d{4})Q([1-4])$/),
        value = matched[0].get(col);
      if (!match || value === undefined || !/^\d+(?:\.\d+)?$/.test(value))
        continue;
      const date = monthEnd(
        `${match[1]}-${String(+match[2] * 3).padStart(2, "0")}`,
      )!;
      if (date <= cutoff.slice(0, 10) && Number.isFinite(+value))
        result.push({ date, value: +value });
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }
  return {
    gross: series(names[2]),
    net: series(names[3]),
    count: series(names[1]),
  };
}

export async function collectPrivateFunds(
  fetchText: (url: string) => Promise<PublicDocument>,
  fetcher: Fetcher = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<Signal> {
  const signal: Signal = {
    id: "sec-private-equity-assets",
    title: "Private equity · reported assets",
    shortLabel: "Private-equity assets",
    family: "capital",
    instruments: [...INSTRUMENTS],
    status: "unavailable",
    series: [],
    metrics: [],
    unit: "$bn",
    staleAfterDays: 270,
    summary: "No usable aggregate private-equity report was returned.",
    source: {
      name: "SEC · Private Fund Statistics",
      url: PRIVATE_FUNDS_PAGE,
      observedAt: null,
      releasedAt: null,
      retrievedAt: now(),
      frequency: "quarterly aggregate · substantial publication lag",
      attribution:
        "US Securities and Exchange Commission, aggregate Form PF statistics",
      usage:
        "US government public aggregate statistics; no private fund filings",
      sha256: null,
    },
    scores: { daily: null, weekly: null, monthly: null },
    methodology:
      "Latest supporting workbook linked on the SEC Private Fund Statistics page. Private Equity Fund rows in tables 1.1, 2.1 and 2.3 provide count, gross and net assets. Units and worksheet labels are validated; blank or masked cells are never zero-filled. No directional vote.",
    limitation:
      "Reported assets and fund counts, not capital calls, distributions, deal flow or daily investment activity. Most advisers report annually. Aggregated and rounded filings may be revised, and the reporting period can be substantially older than retrieval. Older than 270 days is marked stale.",
  };
  try {
    const page = await fetchText(PRIVATE_FUNDS_PAGE),
      url = latestPrivateFundWorkbook(page.text, page.retrievedAt);
    const response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent":
          "The Daily Consensus public research https://thedailyconsensus.com",
      },
    });
    if (!response.ok || !response.body)
      throw new Error("SEC workbook unavailable");
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) throw new Error("Workbook too large");
        parts.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = Buffer.concat(parts),
      at = now(),
      data = privateFundSeries(bytes, at),
      current = data.gross.at(-1);
    if (!current) return signal;
    const net = data.net.find((p) => p.date === current.date),
      count = data.count.find((p) => p.date === current.date);
    if (
      !net ||
      !count ||
      net.value > current.value ||
      !Number.isInteger(count.value)
    )
      throw new Error("Inconsistent SEC aggregates");
    return {
      ...signal,
      status: "available",
      series: data.gross,
      source: {
        ...signal.source,
        url,
        retrievedAt: at,
        observedAt: current.date,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      summary: `$${(current.value / 1000).toFixed(2)}T gross assets across ${count.value.toLocaleString("en-US")} private-equity funds, period ended ${current.date}. Historical scale, not today's flows.`,
      metrics: [
        {
          label: "Gross asset value",
          value: current.value,
          unit: "$bn",
          date: current.date,
        },
        {
          label: "Net asset value",
          value: net.value,
          unit: "$bn",
          date: current.date,
        },
        {
          label: "Reported funds",
          value: count.value,
          unit: "funds",
          date: current.date,
        },
      ],
    };
  } catch {
    return signal;
  }
}
