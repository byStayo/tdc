import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { acquirePublicationLock } from "../publication-lock.ts";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { boundaryClock, type Boundary } from "./market-history-boundaries.ts";
import type { MarketHistoryHour } from "./market-history-closes.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";

const minute = 60_000;
const minimumLag = 48 * 60 * minute;
const maxBody = 512_000;
const hash = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
export const paidMinuteLimits = { maxBars: 8_000, maxRequests: 40, attemptsPerDay: 2 } as const;
export type PaidMinuteEntitlement = { paidMinutes: "owner-activated"; apiKey: string; maxBars: number; maxRequests: number };
type Delivery = { source: string; status: number; headers: Record<string, string>; text: string; sha256: string };
type Stored = { delivery: Delivery; sha256: string };
type Attempt = { kind: "balance" | "bars"; session: string; maximumBars: number };
type Budget = { schema: 1; attempts: Attempt[] };
const ndjson = "application/x-ndjson";

export function paidMinutePlan(day: string) {
  const clock = boundaryClock(day);
  if (!clock) throw new Error("A reviewed TLT exchange session is required");
  const first = Date.parse(clock.openAt), close = Date.parse(clock.closeAt);
  const count = (close - first) / minute;
  if (count !== 390 && count !== 210) throw new Error("Unexpected TLT session length");
  const url = new URL("https://getmarkethistory.com/query/v1/bars/stocks/us/TLT/1m");
  const last = new Date(close - minute).toISOString();
  // The provider's end is inclusive. One spare row avoids a needless cursor on a complete page.
  url.search = new URLSearchParams({
    start: clock.openAt, end: last, feed: "consolidated", adjust: "raw",
    tz: "exchange", format: "jsonl", limit: String(count + 1)
  }).toString();
  return { day, clock, first, close, last, count, maximumBars: Math.ceil((count + 1) / 100) * 100, source: url.href };
}
export type MinutePlan = ReturnType<typeof paidMinutePlan>;
const unsigned = (s: string | null) => s !== null && /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : -1;
const iso = (s: string) => typeof s === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === (s.includes(".") ? s : s.replace("Z", ".000Z"));

export function readPaidMinuteBoundary(day: string, delivery: Delivery, asOf: string): Boundary {
  const p = paidMinutePlan(day);
  const h = new Headers(delivery.headers), served = Date.parse(h.get("date") ?? ""), through = h.get("x-data-through") ?? "";
  if (!iso(asOf) || !Number.isFinite(served) || new Date(served).toUTCString() !== h.get("date") ||
    served < p.close + minimumLag || served > Date.parse(asOf) || !iso(through) || Date.parse(through) < p.close - minute ||
    Date.parse(through) > served || delivery.status !== 200 || delivery.source !== p.source ||
    h.get("x-feed") !== "consolidated" || h.get("x-session") !== "exchange America/New_York 00:00" ||
    h.get("content-type")?.split(";")[0].trim() !== ndjson || h.has("x-next-cursor") || h.has("x-limit-clamped") ||
    /rel\s*=\s*"?next/i.test(h.get("link") ?? "") || h.get("x-row-count") !== String(p.count) ||
    h.get("x-bars-charged") !== String(Math.ceil(p.count / 100) * 100) ||
    unsigned(h.get("x-bars-paid-remaining")) < 0 || unsigned(h.get("x-bars-remaining")) < unsigned(h.get("x-bars-paid-remaining")) ||
    typeof delivery.text !== "string" || Buffer.byteLength(delivery.text) > maxBody || hash(delivery.text) !== delivery.sha256)
    throw new Error("Unverified or incomplete paid TLT minute delivery");

  const lines = delivery.text.trimEnd().split(/\r?\n/);
  if (lines.length !== p.count) throw new Error("Incomplete regular-session TLT minute grid");
  let open = 0, close = 0;
  for (const [i, line] of lines.entries()) {
    const r: MarketHistoryHour = JSON.parse(line);
    if (!r || r.symbol !== "TLT" || r.symbol_id !== 11418 || !iso(r.timestamp) || Date.parse(r.timestamp) !== p.first + i * minute ||
      r.is_gap !== false || r.gap_fill_method !== 0 || !Number.isSafeInteger(r.trade_count) || r.trade_count < 1 ||
      ![r.open, r.close, r.low, r.high, r.volume, r.vwap].every(v => Number.isFinite(v) && v > 0) ||
      Math.max(r.open, r.close) > r.high || Math.min(r.open, r.close) < r.low)
      throw new Error("Invalid TLT native regular-session minute or trade grid");
    if (!i) open = r.open;
    if (i === p.count - 1) close = r.close;
  }
  return { ...p.clock, open, close, openingBucket: p.clock.openAt, closingBucket: p.last, earlyClose: p.count === 210 };
}

export function confirmedPaidMinutes(e: PaidMinuteEntitlement | null): PaidMinuteEntitlement {
  if (e?.paidMinutes !== "owner-activated" || typeof e.apiKey !== "string" || !/^[A-Za-z0-9._-]{8,256}$/.test(e.apiKey) ||
    !Number.isSafeInteger(e.maxBars) || e.maxBars < 100 || e.maxBars > paidMinuteLimits.maxBars ||
    !Number.isSafeInteger(e.maxRequests) || e.maxRequests < 2 || e.maxRequests > paidMinuteLimits.maxRequests)
    throw new Error("Explicit owner-activated minute entitlement, dedicated key and bounded budgets are required");
  return e;
}

export async function cachedPaidMinute(directory: string, day: string, asOf: string) {
  const path = resolve(directory, "TLT-" + paidMinutePlan(day).day + ".json");
  const row = await readResearchReceipt<Stored>(path);
  if (!row) return null;
  if (row.sha256 !== hash(JSON.stringify(row.delivery))) throw new Error("Private TLT original differs from its receipt");
  return readPaidMinuteBoundary(day, row.delivery, asOf);
}

async function readBudget(directory: string): Promise<Budget> {
  const b = await readResearchReceipt<Budget>(resolve(directory, "spend.json"));
  if (!b) {
    if ((await readdir(directory)).some(name => /^TLT-\d{4}-\d\d-\d\d\.json$/.test(name)))
      throw new Error("Missing spend journal for retained paid-minute originals");
    return { schema: 1, attempts: [] };
  }
  if (b.schema !== 1 || !Array.isArray(b.attempts) || b.attempts.length > paidMinuteLimits.maxRequests)
    throw new Error("Invalid private paid-minute request journal");
  const attemptsByDay = new Map<string, number>();
  let total = 0;
  for (const attempt of b.attempts) {
    if (!attempt || !["balance", "bars"].includes(attempt.kind)) throw new Error("Invalid private paid-minute reservation");
    const plan = paidMinutePlan(attempt.session);
    const maximum = attempt.kind === "bars" ? plan.maximumBars : 0;
    if (attempt.maximumBars !== maximum) throw new Error("Paid-minute reservation differs from its session limit");
    total += maximum;
    if (attempt.kind === "bars") {
      const count = (attemptsByDay.get(attempt.session) ?? 0) + 1;
      if (count > paidMinuteLimits.attemptsPerDay) throw new Error("Paid-minute journal exceeds its retry ceiling");
      attemptsByDay.set(attempt.session, count);
    }
  }
  if (total > paidMinuteLimits.maxBars) throw new Error("Paid-minute journal exceeds its cumulative limit");
  return b;
}

async function fetchDelivery(plan: MinutePlan, auth: RequestInit, fetcher: typeof fetch): Promise<Delivery> {
  const response = await sourceResponse(fetcher, plan.source, { ...auth, signal: AbortSignal.timeout(30_000) });
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (; ;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      size += part.value.length;
      if (size > maxBody) throw new Error("TLT minute response exceeds its private byte bound");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks), headers: Record<string, string> = {};
  for (const k of ["content-type", "date", "x-feed", "x-session", "x-row-count", "x-bars-charged", "x-bars-remaining",
    "x-bars-paid-remaining", "x-data-through", "x-next-cursor", "x-limit-clamped", "link"]) {
    if (response.headers.has(k)) headers[k] = response.headers.get(k)!;
  }
  return { source: plan.source, status: response.status, headers, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sha256: hash(bytes) };
}

/** The CLI always supplies the same owner-level directory across publisher checkouts. Uncertain charges stay reserved. */
export async function collectPaidMinutes(directory: string, days: string[], entitlement: PaidMinuteEntitlement, retry: boolean,
  { fetcher = fetch, now = () => new Date().toISOString() }: { fetcher?: typeof fetch; now?: () => string } = {}) {
  const e = confirmedPaidMinutes(entitlement);
  if (!days.length || days.length > 26 || new Set(days).size !== days.length) throw new Error("Invalid paid-minute session batch");
  const plans = days.map(paidMinutePlan);
  const asOf = now();
  if (!iso(asOf) || plans.some((p, i) => p.close + minimumLag > Date.parse(asOf) || (i && p.day <= plans[i - 1].day)))
    throw new Error("Paid minutes require ordered, completed sessions beyond the provider delay");
  await durableDirectory(directory, 0o700);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) throw new Error("Expected an owner-only paid-minute directory");
  // Using this separate directory creates a separate kernel lock, independent of the daily publisher.
  const release = await acquirePublicationLock(directory, "market-history-paid-minute-budget");
  try {
    const budget = await readBudget(directory), missing: MinutePlan[] = [];
    for (const p of plans) {
      if (await cachedPaidMinute(directory, p.day, now())) continue;
      const tries = budget.attempts.filter(a => a.kind === "bars" && a.session === p.day).length;
      if (tries >= paidMinuteLimits.attemptsPerDay || (tries && !retry))
        throw new Error("An earlier TLT request was reserved; an explicit bounded retry is required or exhausted");
      missing.push(p);
    }
    if (!missing.length) return;
    const need = missing.reduce((n, p) => n + p.maximumBars, 0), spent = budget.attempts.reduce((n, a) => n + a.maximumBars, 0);
    if (budget.attempts.length + 1 + missing.length > e.maxRequests || spent + need > e.maxBars)
      throw new Error("Entire request exceeds the remaining owner-approved bar or request budget");
    async function reserve(kind: Attempt["kind"], p: MinutePlan) {
      budget.attempts.push({ kind, session: p.day, maximumBars: kind === "balance" ? 0 : p.maximumBars });
      await durableJSON(resolve(directory, "spend.json"), budget);
    }
    const auth: RequestInit = { headers: { Authorization: "Bearer " + e.apiKey, Accept: ndjson }, redirect: "error", credentials: "omit" };
    await reserve("balance", missing[0]);
    const balance = await sourceResponse(fetcher, "https://getmarkethistory.com/query/v1/fee-rules?dataset=stocks%2Fus&scheme=regulatory_levy&at=" + missing[0].day,
      { ...auth, signal: AbortSignal.timeout(15_000) });
    try {
      const cap = balance.headers.get("x-cap-remaining"), paid = unsigned(balance.headers.get("x-bars-paid-remaining"));
      if ((balance.headers.has("x-bars-charged") && unsigned(balance.headers.get("x-bars-charged")) !== 0) ||
        paid < need || unsigned(balance.headers.get("x-bars-remaining")) < paid || (cap !== null && unsigned(cap) < need))
        throw new Error("Provider did not confirm sufficient prepaid minute bars and key allowance");
    } finally { await balance.body?.cancel(); }
    for (const p of missing) {
      await reserve("bars", p);
      const delivery = await fetchDelivery(p, auth, fetcher);
      readPaidMinuteBoundary(p.day, delivery, now());
      await durableJSON(resolve(directory, "TLT-" + p.day + ".json"), { delivery, sha256: hash(JSON.stringify(delivery)) }, true);
    }
  } finally { await release(); }
}
