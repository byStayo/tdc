import { createHash } from "node:crypto";
import { exchangeSession, exchangeSessions, hasReviewedCalendar } from "./exchange-calendar.ts";
import type { PriceEvidence, SessionPrice } from "./evaluation.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { sourceResponse, sourceChunk } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";
import { INSTRUMENTS } from "./types.ts";
import type { Instrument } from "./types.ts";

export const KIBOT_PRICE_CITATION = "https://www.kibot.com/api/history-request.html";
const MAX_BYTES = 64 * 1024;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type SessionClock = typeof exchangeSession;

export function isFullKibotSession(openAt: string, closeAt: string): boolean {
  return Date.parse(closeAt) - Date.parse(openAt) === 6.5 * 3_600_000;
}

export function parseKibotDaily(csv: string, expectedSessions: string[], sessionClock: SessionClock = exchangeSession): SessionPrice[] {
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
      sessions.some((bar, index) => bar.session !== expectedSessions[index]))
    throw new Error("Kibot response differs from the expected completed sessions");
  return sessions;
}

export async function collectKibotSeries(
  instrument: Exclude<Instrument, "MARKET">,
  expectedSessions: string[],
  options: { unadjusted?: boolean; fetcher?: Fetcher; sessionClock?: SessionClock } = {},
): Promise<{ sessions: SessionPrice[]; sha256: string }> {
  const from = expectedSessions[0];
  const through = expectedSessions.at(-1);
  const sessionClock = options.sessionClock ?? exchangeSession;
  if (!from || !through || Date.parse(through) - Date.parse(from) > 370 * 86400000 ||
      expectedSessions.some((day, index) => !sessionClock(day) || (index > 0 && day <= expectedSessions[index - 1])))
    throw new Error("Kibot collection requires an ordered, bounded reviewed session range");

  const american = (date: string) => date.slice(5, 7) + "/" + date.slice(8) + "/" + date.slice(0, 4);
  const url = new URL("https://api.kibot.com/");
  // Both literal guest values are the provider's documented anonymous access.
  url.search = new URLSearchParams({
    action: "history", interval: "daily", symbol: instrument, user: "guest", password: "guest",
    unadjusted: options.unadjusted ? "1" : "0", startdate: american(from), enddate: american(through),
  }).toString();
  const response = await sourceResponse(options.fetcher ?? fetch, url.href, {
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw new Error("Kibot daily response exceeds the byte limit");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  return {
    sessions: parseKibotDaily(bytes.toString("utf8"), expectedSessions, sessionClock),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function collectKibotPrices(from: string, cutoff: string, fetcher: Fetcher = fetch, unadjusted = false) {
  const today = newYorkDate(cutoff);
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  if (!hasReviewedCalendar(yesterday) || Date.parse(yesterday) - Date.parse(from) > 370 * 86400000)
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
