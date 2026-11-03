import { publicDate } from "../public-normalization.ts";
import { INSTRUMENTS } from "./types.ts";
import type { Catalyst, Signal } from "./types.ts";
import { eventUpcoming, newYorkDate, newYorkTimestamp } from "./time.ts";
import {
  INTERNATIONAL_CALENDARS,
  boeEvents,
  ecbEvents,
  bojEvents,
} from "./international-calendars.ts";

export interface PublicDocument {
  text: string;
  sha256: string;
  retrievedAt: string;
}
type FetchText = (url: string) => Promise<PublicDocument>;
const FOMC = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const TREASURY =
  "https://www.treasurydirect.gov/TA_WS/securities/announced?format=json";
const OPEX = "https://www.optionseducation.org/api/expirationcalendar";
const OPEX_CITATION =
  "https://www.optionseducation.org/referencelibrary/expiration-calendar";
const plain = (text: string) =>
  text
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

export function fomcEvents(html: string, cutoff: string): Catalyst[] {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const headings = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  const events = new Map<string, Catalyst>();
  for (let i = 0; i < headings.length; i++) {
    const year = Number(headings[i][1]);
    const section = html.slice(
      headings[i].index!,
      headings[i + 1]?.index ?? html.length,
    );
    for (const row of section.matchAll(
      /class="[^"]*fomc-meeting__month[^\"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*fomc-meeting__date[^\"]*"[^>]*>([\s\S]*?)<\/div>/g,
    )) {
      const monthText = plain(row[1]).toLowerCase().split("/").at(-1)!;
      const month = months.findIndex(
        (name) => name === monthText || name.startsWith(monthText),
      );
      const days = plain(row[2]).match(/^(\d{1,2})(?:-(\d{1,2}))?(\*)?$/);
      if (month < 0 || !days) continue;
      const at = `${year}-${String(month + 1).padStart(2, "0")}-${(days[2] ?? days[1]).padStart(2, "0")}`;
      if (!eventUpcoming(at, cutoff)) continue;
      events.set(at, {
        id: `fomc-${at}`,
        at,
        title: `FOMC meeting concludes${days[3] ? " · economic projections" : ""}`,
        source: "Federal Reserve",
        url: FOMC,
        kind: "scheduled",
        importance: "major",
      });
    }
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export function treasuryEvents(data: unknown, cutoff: string): Catalyst[] {
  if (!Array.isArray(data))
    throw new Error("Unexpected Treasury announcement schema");
  const events = new Map<string, Catalyst>();
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const day = String(row.competitiveAuctionCloseDate ?? "").slice(0, 10),
      announced = String(row.announcementDate ?? "").slice(0, 10),
      close = String(row.competitiveAuctionCloseTime ?? "").match(
        /^(\d{1,2}):(\d{2}) (AM|PM)$/,
      ),
      cusip = String(row.cusip ?? ""),
      term = String(row.securityTerm ?? ""),
      type = String(row.securityType ?? "");
    if (
      !publicDate(day) ||
      !publicDate(announced) ||
      announced > newYorkDate(cutoff) ||
      !close ||
      !/^\d[A-Z0-9]{8}$/.test(cusip) ||
      !/^\d{1,3}-(?:Week|Year|Month)$/.test(term) ||
      !["Bill", "Note", "Bond", "FRN", "TIPS"].includes(type) ||
      +close[1] < 1 ||
      +close[1] > 12 ||
      +close[2] > 59
    )
      continue;
    const hour = (+close[1] % 12) + (close[3] === "PM" ? 12 : 0),
      at = newYorkTimestamp(
        `${day.replaceAll("-", "")}T${String(hour).padStart(2, "0")}${close[2]}00`,
      );
    if (!at || !eventUpcoming(at, cutoff)) continue;
    const raw = String(row.offeringAmount ?? ""),
      amount = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const title = `Treasury ${term} ${type.toLowerCase()} auction${Number.isFinite(amount) && amount > 0 ? ` · $${(amount / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })}bn offered` : ""}`;
    events.set(cusip, {
      id: `treasury-${cusip}-${day}`,
      title,
      at,
      url: "https://www.treasurydirect.gov/auctions/upcoming/",
      source: "US Treasury",
      kind: "scheduled",
      importance: type === "Bill" ? "context" : "major",
    });
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export function expirationEvents(data: unknown, cutoff: string): Catalyst[] {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { data?: unknown }).data)
  )
    throw new Error("Unexpected expiration calendar");
  const root = data as {
    legend: { type: string; title: string }[];
    data: { date: string; events?: { type: string }[] }[];
  };
  if (!Array.isArray(root.legend)) throw new Error("Missing expiration legend");
  const labels = new Map<string, string>();
  for (const item of root.legend) {
    if (typeof item.title !== "string" || typeof item.type !== "string")
      continue;
    if (/Monthly equity, index/i.test(item.title))
      labels.set(item.type, "Monthly equity and PM index options expiration");
    else if (/A\.M\. settled index/i.test(item.title))
      labels.set(item.type, "Standard AM index options · final trading day");
    else if (/Volatility Products/i.test(item.title))
      labels.set(item.type, "Monthly volatility-product expiration");
    else if (/Quarterly Expiration/i.test(item.title))
      labels.set(item.type, "Quarter-end options expiration");
  }
  const events = new Map<string, Catalyst>();
  for (const row of root.data) {
    const at = typeof row.date === "string" ? row.date.slice(0, 10) : "";
    if (!eventUpcoming(at, cutoff) || !Array.isArray(row.events)) continue;
    for (const item of row.events) {
      const title = labels.get(item.type);
      if (!title) continue;
      const id = `expiry-${item.type}-${at}`;
      events.set(id, {
        id,
        title,
        at,
        url: OPEX_CITATION,
        source: "OCC / Options Industry Council",
        kind: "expiry",
        importance: "major",
      });
    }
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export async function collectMarketCalendars(
  fetchText: FetchText,
): Promise<{ signals: Signal[]; catalysts: Catalyst[] }> {
  const sources = [
    ...(
      [
        ["boe", "Bank of England", boeEvents],
        ["ecb", "European Central Bank", ecbEvents],
        ["boj", "Bank of Japan", bojEvents],
      ] as const
    ).map(([key, provider, parse]) => ({
      id: `${key}-calendar`,
      name: `${provider} policy calendar`,
      provider,
      url: INTERNATIONAL_CALENDARS[key],
      citation: INTERNATIONAL_CALENDARS[key],
      parse,
      limitation:
        "Official local calendar dates, not predicted decisions. Date-only events keep their London, Frankfurt or Tokyo date. Japan's minutes and opinions are labelled separately from policy decisions; exact release times are not inferred from a general convention.",
    })),
    {
      id: "fomc-calendar",
      name: "FOMC meeting calendar",
      provider: "Federal Reserve",
      url: FOMC,
      citation: FOMC,
      parse: (text: string, at: string) => fomcEvents(text, at),
      limitation:
        "Meeting dates, not a predicted rate decision. A date-only event does not imply a confirmed announcement time.",
    },
    {
      id: "treasury-calendar",
      name: "Treasury auction calendar",
      provider: "US Treasury",
      url: TREASURY,
      citation: TREASURY,
      parse: (text: string, at: string) => treasuryEvents(JSON.parse(text), at),
      limitation:
        "Announced auctions only; tentative future issuance is not included. Offering size is not a forecast of net liquidity withdrawal.",
    },
    {
      id: "opex-calendar",
      name: "Options expiration calendar",
      provider: "OCC / Options Industry Council",
      url: OPEX,
      citation: OPEX_CITATION,
      parse: (text: string, at: string) =>
        expirationEvents(JSON.parse(text), at),
      limitation:
        "Selected standard monthly/quarterly dates. Daily and weekly expiries and product-specific settlement rules require the exchange contract. Expiration dates do not measure options positioning, IV or gamma.",
    },
  ];
  const collected = await Promise.all(
    sources.map(async (spec) => {
      const now = new Date().toISOString();
      const signal: Signal = {
        id: spec.id,
        family: "events",
        title: spec.name,
        shortLabel: spec.name,
        instruments: [...INSTRUMENTS],
        status: "unavailable",
        summary: "The calendar did not return a usable schedule.",
        source: {
          name: spec.provider,
          url: spec.citation,
          retrievedAt: now,
          observedAt: null,
          releasedAt: null,
          frequency: "scheduled events",
          attribution: spec.provider,
          usage:
            "Selected public schedule facts with attribution and direct source link.",
          sha256: null,
        },
        methodology:
          "Dated official schedule, filtered to the next 70 days. Exact auction times use America/New_York. Date-only schedules retain date precision. No directional vote.",
        limitation: spec.limitation,
        series: [],
        metrics: [],
        scores: { daily: null, weekly: null, monthly: null },
        staleAfterDays: 3,
        unit: "events",
      };
      try {
        const response = await fetchText(spec.url),
          catalysts = spec.parse(response.text, response.retrievedAt);
        if (!catalysts.length) throw new Error("No upcoming schedule");
        return {
          signal: {
            ...signal,
            status: "available" as const,
            summary: `${catalysts.length} upcoming events; next: ${catalysts[0].title}.`,
            source: {
              ...signal.source,
              retrievedAt: response.retrievedAt,
              observedAt: response.retrievedAt,
              sha256: response.sha256,
            },
            metrics: [
              {
                label: "Upcoming events · 70 days",
                value: catalysts.length,
                unit: "events",
                date: response.retrievedAt,
              },
            ],
          },
          catalysts,
        };
      } catch {
        return { signal, catalysts: [] };
      }
    }),
  );
  return {
    signals: collected.map((x) => x.signal),
    catalysts: collected.flatMap((x) => x.catalysts),
  };
}
