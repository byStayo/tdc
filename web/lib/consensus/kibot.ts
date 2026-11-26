import { createHash } from "node:crypto";
import { exchangeSession, exchangeSessions, hasReviewedCalendar } from "./exchange-calendar.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { sourceResponse, sourceChunk, SourceMissingError } from "./source-failure.ts";
import { verifyKibotSubscriberProof, type KibotSubscriber } from "./kibot-subscriber.ts";
import { newYorkDate } from "./time.ts";
import { INSTRUMENTS } from "./types.ts";
import type { Instrument } from "./types.ts";

export const KIBOT_PRICE_CITATION = "https://www.kibot.com/api/history-request.html";
export const MAX_KIBOT_RESPONSE_BYTES = 64 * 1024;
export const MAX_KIBOT_RANGE_MS = 370 * 86400000;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type SessionClock = typeof exchangeSession;

export function isFullKibotSession(openAt: string, closeAt: string): boolean {
  return Date.parse(closeAt) - Date.parse(openAt) === 6.5 * 3_600_000;
}

export function parseKibotDaily(csv: string, expectedSessions: string[], sessionClock: SessionClock = exchangeSession): SessionPrice[] {
  if (/^(?:405 Data Not Found\.\r?\n)?No data found for the specified period\b/i.test(csv.trimStart()))
    throw new SourceMissingError("The provider returned no completed sessions");
  const rows = csv.trim().split(/\r?\n/);
  const sessions = rows.map(line => {
    const fields = line.split(",");
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fields[0]);
    if (!match || fields.length !== 6) throw new Error("Invalid Kibot daily response");
    const [, month, day, year] = match;
    const date = year + "-" + month + "-" + day;
    const bar = sessionClock(date);
    if (!bar) throw new Error("Kibot bar outside an exchange session");
    const [open, high, low, close, volume] = fields.slice(1).map(Number);
    if (!fields.slice(1).every(field => /^\d+(?:\.\d+)?$/.test(field)) ||
        ![open, high, low, close].every(value => Number.isFinite(value) && value > 0) ||
        !Number.isSafeInteger(volume) || volume <= 0 ||
        high < Math.max(open, close) || low > Math.min(open, close))
      throw new Error("Invalid Kibot daily bar");
    return { ...bar, open, close };
  });
  if (sessions.length !== expectedSessions.length ||
      sessions.some((bar, index) => bar.session !== expectedSessions[index])) {
    const received = new Set(sessions.map(bar => bar.session));
    const missing = expectedSessions.find(day => !received.has(day));
    throw new Error(missing ? `Received ${sessions.length} of ${expectedSessions.length} expected rows, first missing session ${missing}`
      : "Kibot returned an extra, duplicate or out-of-order session");
  }
  return sessions;
}

/** Canonical price request that can be pinned without the subscriber's credentials. */
export function kibotHistorySource(instrument: Exclude<Instrument, "MARKET">, from: string, through: string, basis: "raw" | "splits" | "adjusted") {
  const american = (date: string) => date.slice(5, 7) + "/" + date.slice(8) + "/" + date.slice(0, 4);
  const url = new URL("https://api.kibot.com/");
  url.search = new URLSearchParams({ action: "history", interval: "daily", symbol: instrument,
    ...(basis === "splits" ? { splitadjusted: "1" } : { unadjusted: basis === "raw" ? "1" : "0" }),
    startdate: american(from), enddate: american(through) }).toString();
  return url.href;
}

export async function collectKibotSeries(
  instrument: Exclude<Instrument, "MARKET">,
  expectedSessions: string[],
  options: { unadjusted?: boolean; splitAdjusted?: boolean; fetcher?: Fetcher; sessionClock?: SessionClock; subscriber?: KibotSubscriber;
    onVerifiedResponse?: (csv: string) => void } = {},
): Promise<{ sessions: SessionPrice[]; sha256: string }> {
  const from = expectedSessions[0];
  const through = expectedSessions.at(-1);
  const sessionClock = options.sessionClock ?? exchangeSession;
  if (options.unadjusted && options.splitAdjusted) throw new Error("Choose one Kibot price basis");
  if (!from || !through || Date.parse(through) - Date.parse(from) > MAX_KIBOT_RANGE_MS ||
      expectedSessions.some((day, index) => !sessionClock(day) || (index > 0 && day <= expectedSessions[index - 1])))
    throw new Error("Kibot collection requires an ordered, bounded reviewed session range");

  const url = new URL(kibotHistorySource(instrument, from, through, options.splitAdjusted ? "splits" : options.unadjusted ? "raw" : "adjusted"));
  const account = options.subscriber;
  if (account && (!verifyKibotSubscriberProof(account.proof, new Date().toISOString(), instrument) ||
      !account.user || !account.password || /^(guest|demo|trial)$/i.test(account.user.trim())))
    throw new Error("Invalid Kibot subscriber proof");
  // Guest is the private evaluation lane. Production callers provide a verified subscriber on every individual request.
  url.searchParams.set("user", account?.user ?? "guest");
  url.searchParams.set("password", account?.password ?? "guest");
  const response = await sourceResponse(options.fetcher ?? fetch, url.href, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
  }).catch(error => {
    if (account) throw new Error("Kibot subscriber history request failed");
    throw error;
  });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_KIBOT_RESPONSE_BYTES) throw new Error("Kibot daily response exceeds the byte limit");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (account) throw new Error("Kibot subscriber history response could not be read");
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  try {
    const csv = bytes.toString("utf8"), sessions = parseKibotDaily(csv, expectedSessions, sessionClock);
    options.onVerifiedResponse?.(csv);
    return { sessions, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    const basis = options.unadjusted ? "as-traded" : options.splitAdjusted ? "split-only" : "provider-adjusted";
    const message = `Kibot ${instrument} ${basis} for ${from} through ${through}. ${(error as Error).message}`;
    if (error instanceof SourceMissingError) throw new SourceMissingError(message, { cause: error });
    throw new Error(message, { cause: error });
  }
}

export async function collectKibotPrices(from: string, cutoff: string, fetcher: Fetcher = fetch, unadjusted = false) {
  const today = newYorkDate(cutoff);
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  if (!hasReviewedCalendar(yesterday) || Date.parse(yesterday) - Date.parse(from) > MAX_KIBOT_RANGE_MS)
    throw new Error("Kibot collection requires a bounded, independently reviewed calendar range");
  const expectedSessions = exchangeSessions(from, yesterday);
  const through = expectedSessions.at(-1);
  if (!through) throw new Error("No completed exchange sessions in the collection range");
  const evidence: PriceEvidence[] = [];
  const hashes: Record<string, string> = {};
  for (const instrument of INSTRUMENTS.filter(symbol => symbol !== "MARKET")) {
    const { sessions, sha256 } = await collectKibotSeries(instrument, expectedSessions, { unadjusted, fetcher });
    // As-traded bars are a reconciliation reference. The evaluator rejects this basis.
    evidence.push({ instrument, source: KIBOT_PRICE_CITATION, adjustment: unadjusted ? "unadjusted" : OUTCOME_PRICE_BASIS,
      expectedSessions, sessions });
    hashes[instrument] = sha256;
  }
  return { evidence, hashes, through };
}
