import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import { INSTRUMENTS, type Instrument } from "./types.ts";

const TOKEN_URL =
  "https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials";
const DATA_URL =
  "https://api.finra.org/data/group/otcMarket/name/weeklySummary";
const SYMBOLS = INSTRUMENTS.filter((s) => s !== "MARKET");
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface FinraWeek {
  instrument: Exclude<Instrument, "MARKET">;
  weekStart: string;
  atsShares: number;
  nonAtsShares: number;
  atsTrades: number;
  nonAtsTrades: number;
  initialPublished: string;
  lastUpdated: string;
}
export function finraQuery(at: string) {
  if (!Number.isFinite(Date.parse(at))) throw new Error("Invalid FINRA cutoff");
  return {
    fields: [
      "issueSymbolIdentifier",
      "summaryTypeCode",
      "weekStartDate",
      "totalWeeklyShareQuantity",
      "totalWeeklyTradeCount",
      "initialPublishedDate",
      "lastUpdateDate",
      "tierIdentifier",
    ],
    dateRangeFilters: [
      {
        fieldName: "weekStartDate",
        startDate: new Date(Date.parse(at) - 90 * 86400000)
          .toISOString()
          .slice(0, 10),
        endDate: at.slice(0, 10),
      },
    ],
    domainFilters: [
      { fieldName: "issueSymbolIdentifier", values: SYMBOLS },
      { fieldName: "summaryTypeCode", values: ["ATS_W_SMBL", "OTC_W_SMBL"] },
    ],
    limit: 500,
  };
}
export function finraWeeks(input: unknown, cutoff: string): FinraWeek[] {
  if (!Array.isArray(input) || input.length >= 500)
    throw new Error("Invalid or truncated FINRA response");
  const grouped = new Map<
    string,
    Partial<
      Record<
        "ATS_W_SMBL" | "OTC_W_SMBL",
        { shares: number; trades: number; initial: string; updated: string }
      >
    >
  >();
  for (const row of input) {
    if (
      !row ||
      typeof row !== "object" ||
      !SYMBOLS.includes(row.issueSymbolIdentifier) ||
      !["ATS_W_SMBL", "OTC_W_SMBL"].includes(row.summaryTypeCode)
    )
      continue;
    const week = publicDate(row.weekStartDate),
      initial = publicDate(row.initialPublishedDate),
      updated = publicDate(row.lastUpdateDate);
    const count = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (
      !week ||
      !initial ||
      !updated ||
      week.length !== 10 ||
      initial.length !== 10 ||
      updated.length !== 10 ||
      new Date(`${week}T12:00:00Z`).getUTCDay() !== 1 ||
      initial < week ||
      updated < initial ||
      updated > cutoff.slice(0, 10) ||
      Date.parse(week) < Date.parse(cutoff.slice(0, 10)) - 90 * 86400000 ||
      !["T1", "T2"].includes(row.tierIdentifier) ||
      !(typeof row.totalWeeklyShareQuantity === "number" &&
        Number.isFinite(row.totalWeeklyShareQuantity) &&
        row.totalWeeklyShareQuantity >= 0 &&
        row.totalWeeklyShareQuantity <= Number.MAX_SAFE_INTEGER) ||
      !count(row.totalWeeklyTradeCount)
    )
      continue;
    const key = `${row.issueSymbolIdentifier}:${week}`,
      pair = grouped.get(key) ?? {};
    const type = row.summaryTypeCode as "ATS_W_SMBL" | "OTC_W_SMBL";
    const value = {
      shares: row.totalWeeklyShareQuantity,
      trades: row.totalWeeklyTradeCount,
      initial,
      updated,
    };
    if (pair[type] && JSON.stringify(pair[type]) !== JSON.stringify(value))
      throw new Error("Conflicting FINRA aggregate rows");
    pair[type] = value;
    grouped.set(key, pair);
  }
  return [...grouped]
    .flatMap(([key, pair]) => {
      // Absence of a venue total cannot be converted into a zero-volume observation.
      if (!pair.ATS_W_SMBL || !pair.OTC_W_SMBL) return [];
      const [instrument, weekStart] = key.split(":"),
        ats = pair.ATS_W_SMBL,
        otc = pair.OTC_W_SMBL;
      return [
        {
          instrument: instrument as FinraWeek["instrument"],
          weekStart,
          atsShares: ats.shares,
          nonAtsShares: otc.shares,
          atsTrades: ats.trades,
          nonAtsTrades: otc.trades,
          initialPublished: [ats.initial, otc.initial].sort().at(-1)!,
          lastUpdated: [ats.updated, otc.updated].sort().at(-1)!,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.weekStart.localeCompare(b.weekStart) ||
        a.instrument.localeCompare(b.instrument),
    );
}
async function boundedJSON(
  response: Response,
  max: number,
): Promise<{ data: unknown; sha256: string }> {
  if (!response.ok || !response.body)
    throw new Error(`FINRA HTTP ${response.status}`);
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw new Error("FINRA response exceeds limit");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = Buffer.concat(parts);
  try {
    return {
      data: JSON.parse(bytes.toString("utf8")),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw new Error("FINRA returned invalid JSON");
  }
}

/** Authenticated, private collection only. A public distribution agreement is a separate gate. */
export async function collectFinraPrivate(
  credentials: { clientId: string; clientSecret: string },
  fetcher: Fetcher = fetch,
  now: () => string = () => new Date().toISOString(),
) {
  if (
    !credentials.clientId ||
    !credentials.clientSecret ||
    /[:\r\n]/.test(credentials.clientId) ||
    /[\r\n]/.test(credentials.clientSecret)
  )
    throw new Error("FINRA credentials are missing or invalid");
  const auth = await boundedJSON(
    await fetcher(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
        Accept: "application/json",
      },
    }),
    32000,
  );
  const token = auth.data as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    token.access_token.length > 16000 ||
    /[\r\n]/.test(token.access_token) ||
    String(token.token_type).toLowerCase() !== "bearer" ||
    !(Number(token.expires_in) > 0)
  )
    throw new Error("Invalid FINRA authorization response");
  const cutoff = now();
  const response = await fetcher(DATA_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(finraQuery(cutoff)),
  });
  const total = response.headers.get("Record-Total"),
    expected = total === null ? null : Number(total);
  if (
    expected !== null &&
    (!Number.isSafeInteger(expected) || expected < 0 || expected >= 500)
  )
    throw new Error("FINRA result requires narrower filters");
  const result = await boundedJSON(response, 2_000_000);
  if (
    expected !== null &&
    (!Array.isArray(result.data) || result.data.length !== expected)
  )
    throw new Error("Incomplete FINRA result");
  const weeks = finraWeeks(result.data, cutoff);
  if (!weeks.length) throw new Error("No paired, valid FINRA observations");
  return {
    source: DATA_URL,
    cutoff,
    retrievedAt: now(),
    sha256: result.sha256,
    attribution: "FINRA is the owner and source of this equity data",
    usage:
      "Private verification only. Public distribution must satisfy FINRA Equity Data terms, including no end-user fee and no further redistribution.",
    weeks,
  };
}
