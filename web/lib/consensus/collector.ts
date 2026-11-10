import { collectNews } from "./news.ts";
import { newYorkTimestamp } from "./time.ts";
export { newYorkTimestamp } from "./time.ts";
import { collectMarketCalendars } from "./calendars.ts";
import { collectCapital } from "./capital.ts";
import { collectPrivateFunds } from "./private-funds.ts";
import { collectPrivateCredit } from "./private-credit.ts";
import { collectPolicyRates } from "./policy.ts";
import { collectHoldings } from "./holdings.ts";
import { collectAnalystRatings } from "./analyst-ratings.ts";
import { collectEtfFlows } from "./etf-flows.ts";
import { collectFuturesOptions } from "./futures-options.ts";
import { collectTaiwan } from "./taiwan.ts";
import { sourceResponse, sourceChunk, sourceFailureKind } from "./source-failure.ts";
import { createHash } from "node:crypto";
import { MACRO_SERIES, ENGINE_VERSION, missingSignals } from "./registry.ts";
import { clamp } from "./engine.ts";
import { applyScoringPolicy } from "./scoring-policy.ts";
import {
  latestPublicPositioning,
  PUBLIC_CONTRACT_CODES,
  publicDate,
} from "../public-normalization.ts";
import type {
  Signal,
  Point,
  Snapshot,
  Catalyst,
  Instrument,
  Provenance,
} from "./types.ts";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const ALL: Instrument[] = ["MARKET", "SPY", "QQQ", "IWM", "DIA", "TLT"];
const HOSTS = new Set([
  "fred.stlouisfed.org",
  "publicreporting.cftc.gov",
  "www.ecb.europa.eu",
  "data-api.ecb.europa.eu",
  "www.federalreserve.gov",
  "www.boj.or.jp",
  "www.bankofengland.co.uk",
  "www.bls.gov",
  "data.sec.gov",
  "www.sec.gov",
  "ticdata.treasury.gov",
  "www.treasurydirect.gov",
  "www.optionseducation.org",
  "openapi.twse.com.tw",
  "www.quantisnow.com",
  "etfiq.com",
]);
const noScores = () => ({ daily: null, weekly: null, monthly: null });
export function safeURL(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    !HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    /(?:token|api_key|secret|password)/i.test(url.search)
  )
    throw new Error("Source URL outside public allowlist");
  return url.href;
}
export async function publicText(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<{ text: string; sha256: string; retrievedAt: string }> {
  safeURL(url);
  const response = await sourceResponse(fetcher, url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent":
        "The Daily Consensus public research https://thedailyconsensus.com",
      Accept: "application/json,text/csv,application/xml,text/xml,text/html",
    },
  });
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2_000_000) throw new Error("Source exceeds 2 MB limit");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const buffer = Buffer.concat(chunks);
  return {
    text: buffer.toString("utf8"),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    retrievedAt: new Date().toISOString(),
  };
}
export function fredPoints(text: string, id: string, cutoff: string): Point[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (header !== `observation_date,${id}` && header !== `DATE,${id}`)
    throw new Error("Unexpected FRED schema");
  const values = new Map<string, number>();
  for (const line of lines) {
    const [date, value, extra] = line.split(",");
    if (
      !publicDate(date) ||
      date > cutoff.slice(0, 10) ||
      extra !== undefined ||
      !value ||
      !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)
    )
      continue;
    if (Number.isFinite(Number(value))) values.set(date, Number(value));
  }
  return [...values]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-260);
}
function source(
  input: Partial<Provenance> & Pick<Provenance, "name" | "url" | "retrievedAt">,
): Provenance {
  return {
    observedAt: null,
    releasedAt: null,
    frequency: "daily",
    attribution: input.name,
    usage:
      "Official public observations; modifications attributed to The Daily Consensus",
    sha256: null,
    ...input,
  };
}
function blank(
  id: string,
  title: string,
  family: Signal["family"],
  url: string,
  at: string,
): Signal {
  return {
    id,
    title,
    shortLabel: title,
    family,
    instruments: ALL,
    status: "unavailable",
    summary: "The source did not return a usable observation.",
    source: source({ name: title, url, retrievedAt: at }),
    methodology:
      "Official public source with dated observations; no substitute values on failure.",
    limitation: "Missing is not neutral.",
    series: [],
    metrics: [],
    scores: noScores(),
    staleAfterDays: 7,
    unit: "",
  };
}
function changeScore(
  series: Point[],
  count: number,
  scale: number,
  polarity: number,
): number | null {
  return series.length > count
    ? clamp(
        ((series.at(-1)!.value - series.at(-1 - count)!.value) / scale) *
          polarity,
      )
    : null;
}
export async function macro(fetcher: Fetcher): Promise<Signal[]> {
  return Promise.all(
    MACRO_SERIES.map(async (descriptor) => {
      const url = `https://fred.stlouisfed.org/series/${descriptor.id}`,
        signal = blank(
          `fred-${descriptor.id}`,
          descriptor.title,
          descriptor.family,
          url,
          new Date().toISOString(),
        );
      signal.unit = descriptor.unit;
      signal.staleAfterDays = descriptor.lag;
      signal.methodology = `Change in the published series scaled by ${descriptor.scale} ${descriptor.unit}, capped to [-1,1], with ${descriptor.polarity > 0 ? "rises" : "falls"} treated as a supportive prior. Daily/weekly/monthly views use ${descriptor.frequency === "daily" ? "1/5/21 observations" : descriptor.frequency === "weekly" ? "1/4/13 observations" : "1/3/6 observations"}. These are context windows, not validated return predictions.`;
      signal.limitation =
        "Macro relationships change by regime. Latest-vintage observations may be revised; historical values are not an as-known backtest.";
      try {
        const from = new Date(Date.now() - 800 * 86400000)
          .toISOString()
          .slice(0, 10);
        const response = await publicText(
          `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${descriptor.id}&cosd=${from}`,
          fetcher,
        );
        const series = fredPoints(
          response.text,
          descriptor.id,
          response.retrievedAt,
        );
        if (!series.length) throw new Error("No numeric observations");
        const current = series.at(-1)!,
          previous = series.at(-2),
          windows =
            descriptor.frequency === "daily"
              ? [1, 5, 21]
              : descriptor.frequency === "weekly"
                ? [1, 4, 13]
                : [1, 3, 6];
        return {
          ...signal,
          status: "available" as const,
          source: source({
            name: "Federal Reserve / FRED",
            url,
            retrievedAt: response.retrievedAt,
            sha256: response.sha256,
            observedAt: current.date,
            frequency: descriptor.frequency,
            attribution:
              "Board of Governors of the Federal Reserve System / Federal Reserve Bank of New York, via FRED, Federal Reserve Bank of St. Louis",
          }),
          series,
          metrics: [
            {
              label: descriptor.title,
              value: current.value,
              unit: descriptor.unit,
              date: current.date,
            },
            ...(previous
              ? [
                  {
                    label: "Change from previous observation",
                    value: current.value - previous.value,
                    unit: descriptor.unit,
                    date: current.date,
                  },
                ]
              : []),
          ],
          summary: previous
            ? `${current.value.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${descriptor.unit}; ${current.value > previous.value ? "up" : current.value < previous.value ? "down" : "unchanged"} from the previous ${descriptor.frequency} observation.`
            : "Latest published observation.",
          scores: {
            daily: changeScore(
              series,
              windows[0],
              descriptor.scale,
              descriptor.polarity,
            ),
            weekly: changeScore(
              series,
              windows[1],
              descriptor.scale,
              descriptor.polarity,
            ),
            monthly: changeScore(
              series,
              windows[2],
              descriptor.scale,
              descriptor.polarity,
            ),
          },
        };
      } catch (error) {
        signal.failureKind = sourceFailureKind(error);
        signal.summary = `Source unavailable: ${error instanceof Error ? error.message : "fetch failed"}.`;
        return signal;
      }
    }),
  );
}
export function ecbPoints(xml: string): Map<string, Point[]> {
  const result = new Map<string, Point[]>();
  for (const match of xml.matchAll(
    /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g,
  )) {
    for (const value of match[2].matchAll(
      /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g,
    )) {
      if (
        !publicDate(match[1]) ||
        !Number.isFinite(Number(value[2])) ||
        Number(value[2]) <= 0
      )
        continue;
      result.set(value[1], [
        ...(result.get(value[1]) ?? []),
        { date: match[1], value: Number(value[2]) },
      ]);
    }
  }
  for (const points of result.values())
    points.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}
export const FX_CURRENCIES = ["EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "CNY"] as const;
export async function currencies(fetcher: Fetcher): Promise<Signal[]> {
  const url =
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
  try {
    const response = await publicText(url, fetcher);
    const rows = ecbPoints(response.text),
      usd = rows.get("USD");
    if (!usd?.length) throw new Error("No ECB dollar series");
    return FX_CURRENCIES.map((currency) => {
      const input =
        currency === "EUR"
          ? usd.map((point) => ({ ...point, value: 1 }))
          : (rows.get(currency) ?? []);
      const pairs = input.flatMap((point) => {
        const dollar = usd.find((item) => item.date === point.date);
        return dollar && point.date <= response.retrievedAt.slice(0, 10)
          ? [{ date: point.date, value: dollar.value / point.value }]
          : [];
      });
      const latest = pairs.at(-1),
        previous = pairs.at(-2),
        signal = blank(
          `fx-${currency}`,
          `${currency} / USD`,
          "fx",
          url,
          response.retrievedAt,
        );
      return {
        ...signal,
        status: latest ? ("available" as const) : ("unavailable" as const),
        ...(latest ? {} : { failureKind: "validation" as const }),
        series: pairs,
        unit: "USD",
        metrics: latest
          ? [
              {
                label: `1 ${currency} in USD`,
                value: latest.value,
                unit: "USD",
                date: latest.date,
              },
              ...(previous
                ? [
                    {
                      label: "Daily change",
                      value: (latest.value / previous.value - 1) * 100,
                      unit: "%",
                      date: latest.date,
                    },
                  ]
                : []),
            ]
          : [],
        summary:
          latest && previous
            ? `${currency} ${latest.value > previous.value ? "strengthened" : latest.value < previous.value ? "weakened" : "was unchanged"} against the US dollar at the reference fix.`
            : "Reference exchange rate.",
        source: source({
          name: "European Central Bank",
          url,
          retrievedAt: response.retrievedAt,
          sha256: response.sha256,
          observedAt: latest?.date ?? null,
          attribution:
            "Source: ECB. USD cross rates and percentage changes calculated by The Daily Consensus.",
        }),
        methodology:
          "ECB units per euro are converted into USD per unit of the selected currency using same-date USD/EUR. Published reference fixes are not executable quotes. Currency moves remain context, not extra equity-direction votes.",
        limitation: "Daily reference fix; no live or intraday currency prices.",
        scores: noScores(),
      };
    });
  } catch (error) {
    return FX_CURRENCIES.map((currency) => ({
      ...blank(`fx-${currency}`, `${currency} / USD`, "fx", url, new Date().toISOString()),
      failureKind: sourceFailureKind(error),
    }));
  }
}
const CONTRACTS: Record<string, { symbol: Instrument; title: string }> = {
  "13874A": { symbol: "SPY", title: "S&P 500 futures" },
  "209742": { symbol: "QQQ", title: "Nasdaq-100 futures" },
  "239742": { symbol: "IWM", title: "Russell 2000 futures" },
  "124603": { symbol: "DIA", title: "Dow futures" },
  "020601": { symbol: "TLT", title: "Treasury bond futures" },
  "043602": { symbol: "TLT", title: "10-year Treasury futures" },
};
export function positioningRows(raw: unknown[], code: string, cutoff: string) {
  const rows = new Map<string, ReturnType<typeof latestPublicPositioning>[number]>();
  for (const row of raw.flatMap(item => latestPublicPositioning([item], [code]))) {
    if (row.reportDate > cutoff.slice(0,10)) continue;
    const prior = rows.get(row.reportDate);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row))
      throw new Error("Conflicting CFTC rows for one contract and report date");
    rows.set(row.reportDate, row);
  }
  return [...rows.values()].sort((a,b)=>a.reportDate.localeCompare(b.reportDate));
}
export async function positioning(fetcher: Fetcher): Promise<Signal[]> {
  const url = new URL(
    "https://publicreporting.cftc.gov/resource/gpe5-46if.json",
  );
  url.searchParams.set("$limit", "300");
  url.searchParams.set("$order", "report_date_as_yyyy_mm_dd DESC");
  url.searchParams.set(
    "$where",
    `cftc_contract_market_code in (${PUBLIC_CONTRACT_CODES.map((code) => `'${code}'`).join(",")})`,
  );
  url.searchParams.set(
    "$select",
    "id,report_date_as_yyyy_mm_dd,contract_market_name,market_and_exchange_names,cftc_contract_market_code,contract_units,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,lev_money_positions_short,dealer_positions_long_all,dealer_positions_short_all,futonly_or_combined",
  );
  let response: Awaited<ReturnType<typeof publicText>> | null = null,
    raw: unknown[] = [];
  let failureKind: Signal["failureKind"] = "validation";
  try {
    response = await publicText(url.href, fetcher);
    const data: unknown = JSON.parse(response.text);
    if (Array.isArray(data)) raw = data;
  } catch (error) {
    failureKind = sourceFailureKind(error);
    /* Each contract remains explicitly unavailable. */
  }
  return Object.entries(CONTRACTS).flatMap(([code, contract]) => {
    let rows: ReturnType<typeof positioningRows> = [];
    let contractFailure = failureKind;
    try { rows = positioningRows(raw, code, response?.retrievedAt ?? ""); }
    catch { contractFailure = "validation"; }
    return (["asset", "leveraged"] as const).map((category) => {
      const title = `${contract.title} · ${category === "asset" ? "asset managers" : "leveraged funds"}`,
        citation = `https://publicreporting.cftc.gov/resource/gpe5-46if.json?cftc_contract_market_code=${code}`;
      const signal = blank(
        `cftc-${code}-${category}`,
        title,
        "institutions",
        citation,
        response?.retrievedAt ?? new Date().toISOString(),
      );
      const series = rows.flatMap((row) => {
        const long =
            category === "asset" ? row.assetManagerLong : row.leveragedLong,
          short =
            category === "asset" ? row.assetManagerShort : row.leveragedShort;
        return long !== null && short !== null && row.openInterest
          ? [
              {
                date: row.reportDate,
                value: ((long - short) / row.openInterest) * 100,
              },
            ]
          : [];
      });
      const latest = series.at(-1);
      return {
        ...signal,
        instruments: ["MARKET", contract.symbol] as Instrument[],
        status: latest ? ("available" as const) : ("unavailable" as const),
        ...(latest ? {} : { failureKind: contractFailure }),
        staleAfterDays: 14,
        series,
        unit: "% OI",
        metrics: latest
          ? [
              {
                label: "Net position / open interest",
                value: latest.value,
                unit: "%",
                date: latest.date,
              },
            ]
          : [],
        summary: latest
          ? `${category === "asset" ? "Asset managers" : "Leveraged funds"} are net ${latest.value >= 0 ? "long" : "short"} ${Math.abs(latest.value).toFixed(1)}% of open interest.`
          : signal.summary,
        source: source({
          name: "CFTC · TFF futures only",
          url: citation,
          retrievedAt: signal.source.retrievedAt,
          sha256: response?.sha256 ?? null,
          observedAt: latest?.date ?? null,
          frequency: "weekly",
          attribution: "US Commodity Futures Trading Commission",
        }),
        scores: {
          daily: latest ? clamp(latest.value / 40) : null,
          weekly: changeScore(series, 1, 10, 1),
          monthly: changeScore(series, 4, 15, 1),
        },
        methodology:
          "Futures-only net contracts divided by open interest. Daily uses net position / 40 percentage points; weekly/monthly use 1/4-report changes scaled by 10/15 points. Capped [-1,1]. Category biases are declared priors, not estimated predictive accuracy.",
        limitation:
          "Tuesday observations generally released Friday. Futures positioning is not ETF flows, known dealer intent or dark-pool activity. Exact release timestamp unavailable; first collection establishes known availability.",
      };
    });
  });
}
export function cleanXML(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) =>
      Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "",
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim()
    .slice(0, 500);
}
export function rssItems(
  xml: string,
  name: string,
  host: string,
  cutoff: string,
): Catalyst[] {
  const get = (item: string, tag: string) =>
    cleanXML(
      item.match(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
      )?.[1] ?? "",
    );
  const result = new Map<string, Catalyst>();
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const title = get(match[1], "title"),
      rawURL = get(match[1], "link"),
      rawDate = get(match[1], "pubDate");
    // BOJ's official feed still emits HTTP links. Upgrade its own host, never follow an arbitrary redirect.
    const url =
      host === "www.boj.or.jp"
        ? rawURL.replace(
            /^http:\/\/www\.boj\.or\.jp\//,
            "https://www.boj.or.jp/",
          )
        : rawURL;
    if (
      !title ||
      !Number.isFinite(Date.parse(rawDate)) ||
      Date.parse(rawDate) > Date.parse(cutoff)
    )
      continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.hostname !== host) continue;
    } catch {
      continue;
    }
    const at = new Date(rawDate).toISOString(),
      id = createHash("sha256").update(url).digest("hex").slice(0, 20);
    result.set(id, {
      id,
      title,
      url,
      at,
      source: name,
      kind: "release",
      importance: /monetary|rate|inflation|policy|outlook/i.test(title)
        ? "major"
        : "context",
    });
  }
  return [...result.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);
}
async function centralBanks(
  fetcher: Fetcher,
): Promise<{ signals: Signal[]; catalysts: Catalyst[] }> {
  const feeds = [
    {
      id: "fed",
      name: "Federal Reserve",
      url: "https://www.federalreserve.gov/feeds/press_all.xml",
      host: "www.federalreserve.gov",
    },
    {
      id: "ecb",
      name: "European Central Bank",
      url: "https://www.ecb.europa.eu/rss/press.html",
      host: "www.ecb.europa.eu",
    },
    {
      id: "boj",
      name: "Bank of Japan",
      url: "https://www.boj.or.jp/en/rss/whatsnew.xml",
      host: "www.boj.or.jp",
    },
    {
      id: "boe",
      name: "Bank of England",
      url: "https://www.bankofengland.co.uk/rss/news",
      host: "www.bankofengland.co.uk",
    },
  ];
  const results = await Promise.all(
    feeds.map(async (feed) => {
      const signal = blank(
        `news-${feed.id}`,
        feed.name,
        feed.id === "fed" ? "news" : "international",
        feed.url,
        new Date().toISOString(),
      );
      try {
        const response = await publicText(feed.url, fetcher),
          catalysts = rssItems(
            response.text,
            feed.name,
            feed.host,
            response.retrievedAt,
          );
        if (!catalysts.length) throw new Error("No dated releases");
        return {
          signal: {
            ...signal,
            status: "available" as const,
            staleAfterDays: 14,
            source: source({
              name: feed.name,
              url: feed.url,
              retrievedAt: response.retrievedAt,
              sha256: response.sha256,
              observedAt: catalysts[0].at,
              releasedAt: catalysts[0].at,
              frequency: "event-driven",
              usage:
                "Official RSS headlines with attribution and direct source links",
            }),
            summary: catalysts[0].title,
            metrics: [
              {
                label: "Recent official releases sampled",
                value: catalysts.length,
                unit: "releases",
                date: catalysts[0].at,
              },
            ],
            methodology:
              "Deduplicated official RSS release headlines. Date is the publisher timestamp. No headline-only sentiment is silently converted into a market forecast.",
            limitation:
              "Selected official releases, not the full news cycle. Publication sentiment and policy impact require separate reviewed analysis.",
          },
          catalysts,
        };
      } catch {
        return { signal, catalysts: [] };
      }
    }),
  );
  return {
    signals: results.map((result) => result.signal),
    catalysts: results
      .flatMap((result) => result.catalysts)
      .sort((a, b) => b.at.localeCompare(a.at)),
  };
}
export function blsEvents(ics: string, cutoff: string): Catalyst[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const events = new Map<string, Catalyst>(),
    max = Date.parse(cutoff) + 35 * 86400000;
  for (const match of unfolded.matchAll(
    /BEGIN:VEVENT\s*([\s\S]*?)END:VEVENT/g,
  )) {
    const title = match[1]
        .match(/(?:^|\n)SUMMARY:([^\r\n]+)/)?.[1]
        ?.replace(/\\,/g, ",")
        .trim(),
      local = match[1].match(
        /DTSTART;TZID=(?:US-Eastern|America\/New_York):(\d{8}T\d{6})/,
      )?.[1];
    const at = local ? newYorkTimestamp(local) : null;
    if (
      !title ||
      !at ||
      Date.parse(at) < Date.parse(cutoff) ||
      Date.parse(at) > max
    )
      continue;
    const id = `bls-${createHash("sha256").update(`${at}:${title}`).digest("hex").slice(0, 16)}`;
    events.set(id, {
      id,
      title,
      at,
      url: `https://www.bls.gov/schedule/${at.slice(0, 4)}/${at.slice(5, 7)}_sched.htm`,
      source: "Bureau of Labor Statistics",
      kind: "scheduled",
      importance:
        /consumer price|producer price|employment situation|job openings|employment cost/i.test(
          title,
        )
          ? "major"
          : "context",
    });
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}
async function calendar(fetcher: Fetcher) {
  const url = "https://www.bls.gov/schedule/news_release/bls.ics",
    signal = blank(
      "bls-calendar",
      "Economic release calendar",
      "events",
      url,
      new Date().toISOString(),
    );
  try {
    const response = await publicText(url, fetcher),
      catalysts = blsEvents(response.text, response.retrievedAt);
    if (!catalysts.length) throw new Error("No upcoming events");
    return {
      signal: {
        ...signal,
        status: "available" as const,
        source: source({
          name: "US Bureau of Labor Statistics",
          url,
          retrievedAt: response.retrievedAt,
          sha256: response.sha256,
          observedAt: response.retrievedAt,
          frequency: "scheduled events",
        }),
        metrics: [
          {
            label: "Upcoming releases · 35 days",
            value: catalysts.length,
            unit: "events",
            date: response.retrievedAt,
          },
        ],
        summary: `${catalysts[0].title} is the next scheduled release.`,
        methodology:
          "Official BLS iCalendar, filtered to the next 35 days. US Eastern timestamps are converted with America/New_York daylight-saving rules. Event presence does not cast a directional vote.",
        limitation:
          "Schedules can change. This calendar does not include every central-bank meeting, earnings release or geopolitical event.",
      },
      catalysts,
    };
  } catch {
    return { signal, catalysts: [] };
  }
}
interface Quarter {
  start: string;
  end: string;
  value: number;
  filed: string;
  accession: string;
}
export function secQuarters(
  data: unknown,
  expectedCik: string,
  unit: string,
  cutoff: string,
): Quarter[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  if (Number(root.cik) !== Number(expectedCik)) return [];
  const units = root.units as Record<string, unknown> | undefined,
    input = units?.[unit];
  if (!Array.isArray(input)) return [];
  const quarters = new Map<string, Quarter>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const start = publicDate(row.start),
      end = publicDate(row.end),
      filed = publicDate(row.filed),
      value = row.val;
    if (
      !start ||
      !end ||
      !filed ||
      filed > cutoff.slice(0, 10) ||
      end > cutoff.slice(0, 10) ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !["10-Q", "10-K", "10-Q/A", "10-K/A"].includes(String(row.form)) ||
      !/^\d{10}-\d{2}-\d{6}$/.test(String(row.accn))
    )
      continue;
    const duration = (Date.parse(end) - Date.parse(start)) / 86400000;
    if (duration < 75 || duration > 105) continue;
    const prior = quarters.get(end);
    if (!prior || prior.filed < filed)
      quarters.set(end, {
        start,
        end,
        value,
        filed,
        accession: String(row.accn),
      });
  }
  return [...quarters.values()].sort((a, b) => a.end.localeCompare(b.end));
}
export async function earnings(fetcher: Fetcher): Promise<Signal[]> {
  const issuers = [
    {
      ticker: "AAPL",
      cik: "0000320193",
      name: "Apple",
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
    },
    {
      ticker: "MSFT",
      cik: "0000789019",
      name: "Microsoft",
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
    },
    { ticker: "NVDA", cik: "0001045810", name: "NVIDIA", concept: "Revenues" },
  ];
  return Promise.all(
    issuers.map(async (issuer) => {
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${issuer.cik}/us-gaap/${issuer.concept}.json`,
        signal = blank(
          `earnings-${issuer.ticker}`,
          `${issuer.name} · reported revenue`,
          "earnings",
          url,
          new Date().toISOString(),
        );
      signal.instruments = ["MARKET", "SPY", "QQQ", "DIA"];
      signal.staleAfterDays = 150;
      try {
        const response = await publicText(url, fetcher),
          quarters = secQuarters(
            JSON.parse(response.text),
            issuer.cik,
            "USD",
            response.retrievedAt,
          ),
          latest = quarters.at(-1);
        if (!latest) throw new Error("No reported quarter");
        const previousYear = [...quarters].reverse().find((quarter) => {
          const days =
            (Date.parse(latest.end) - Date.parse(quarter.end)) / 86400000;
          return days >= 350 && days <= 380;
        });
        const growth =
          previousYear && previousYear.value > 0
            ? (latest.value / previousYear.value - 1) * 100
            : null;
        const reading = growth === null ? null : clamp(growth / 20);
        return {
          ...signal,
          status: "available" as const,
          unit: "$bn",
          series: quarters.slice(-16).map((quarter) => ({
            date: quarter.end,
            value: quarter.value / 1e9,
          })),
          source: source({
            name: `SEC XBRL · ${issuer.ticker}`,
            url,
            retrievedAt: response.retrievedAt,
            sha256: response.sha256,
            observedAt: latest.end,
            releasedAt: null,
            frequency: "quarterly",
            attribution:
              "US Securities and Exchange Commission; company-filed US GAAP facts",
          }),
          metrics: [
            {
              label: "Quarter revenue",
              value: latest.value / 1e9,
              unit: "$bn",
              date: latest.end,
            },
            ...(growth !== null
              ? [
                  {
                    label: "Year-over-year revenue change",
                    value: growth,
                    unit: "%",
                    date: latest.end,
                  },
                ]
              : []),
          ],
          summary: `${issuer.name} reported $${(latest.value / 1e9).toFixed(2)}bn revenue for the quarter ended ${latest.end}${growth === null ? "" : `, ${growth >= 0 ? "up" : "down"} ${Math.abs(growth).toFixed(1)}% year over year`}. Filed ${latest.filed}.`,
          scores: { daily: reading, weekly: reading, monthly: reading },
          methodology:
            "Only 75–105-day US GAAP revenue periods from 10-Q/10-K filings are used. Latest known filing per period; prior year matched within 350–380 days. YoY growth / 20 percentage points is a capped contextual prior, identical across horizons until the next quarter.",
          limitation:
            "Three selected mega-cap companies, not all index constituents. Revenue growth is not an earnings surprise, EPS result, analyst revision or guidance assessment. Prior periods can be restated.",
        };
      } catch (error) {
        return {...signal, failureKind: sourceFailureKind(error)};
      }
    }),
  );
}
export async function collectSnapshot(
  fetcher: Fetcher = fetch,
): Promise<Snapshot> {
  // Small independent source batches; each failed source is retained as unavailable.
  const [
    economic,
    fx,
    institutions,
    banks,
    releases,
    results,
    marketCalendars,
    news,
    capital,
    privateFunds,
    privateCredit,
    policyRates,
    holdings,
    taiwan,
    analystRatings,
    etfFlows,
    futuresOptions,
  ] = await Promise.all([
    macro(fetcher),
    currencies(fetcher),
    positioning(fetcher),
    centralBanks(fetcher),
    calendar(fetcher),
    earnings(fetcher),
    collectMarketCalendars((url) => publicText(url, fetcher)),
    collectNews(fetcher),
    collectCapital((url) => publicText(url, fetcher)),
    collectPrivateFunds((url) => publicText(url, fetcher), fetcher),
    collectPrivateCredit((url) => publicText(url, fetcher)),
    collectPolicyRates((url) => publicText(url, fetcher)),
    collectHoldings((url) => publicText(url, fetcher)),
    collectTaiwan((url) => publicText(url, fetcher)),
    collectAnalystRatings((url) => publicText(url, fetcher)),
    collectEtfFlows((url) => publicText(url, fetcher)),
    collectFuturesOptions((url) => publicText(url, fetcher)),
  ]);
  const issuedAt = new Date().toISOString(),
    signals = [
      ...economic,
      ...fx,
      ...institutions,
      ...banks.signals,
      releases.signal,
      ...results,
      ...marketCalendars.signals,
      news.signal,
      ...capital,
      privateFunds,
      ...policyRates,
      ...holdings.signals,
      ...missingSignals(issuedAt),
      // Match the scoped addition's position so a full refresh cannot create
      // an edition solely by moving otherwise identical source evidence.
      ...futuresOptions,
      ...etfFlows,
      analystRatings,
      ...taiwan,
      privateCredit,
    ];
  const id = issuedAt.replace(/[:.]/g, "-");
  return applyScoringPolicy({
    schemaVersion: 1,
    id,
    issuedAt,
    cutoff: issuedAt,
    origin: "prospective",
    engineVersion: ENGINE_VERSION,
    signals,
    catalysts: [
      ...banks.catalysts,
      ...releases.catalysts,
      ...marketCalendars.catalysts,
    ],
    ...(news.pulse ? { news: news.pulse } : {}),
    ...(holdings.holdings.length ? { holdings: holdings.holdings } : {}),
    sourcesAttempted: MACRO_SERIES.length + 35,
    collectionErrors: signals
      .filter(
        (signal) =>
          signal.status === "unavailable" && !signal.id.startsWith("social-"),
      )
      .map((signal) => `${signal.id}: ${signal.summary}`),
  });
}
