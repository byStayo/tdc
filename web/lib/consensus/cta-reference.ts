import { createHash } from "node:crypto";
import type { SessionPrice } from "./evaluation.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";
import { newYorkTimestamp } from "./time.ts";

export const CTA_REFERENCE_SYMBOLS = ["SPY", "IWM", "DIA"] as const;
type ReferenceSymbol = (typeof CTA_REFERENCE_SYMBOLS)[number];
type Session = Pick<SessionPrice, "session" | "openAt" | "closeAt">;
type Fetcher = Parameters<typeof sourceResponse>[0];

const ARCHIVE = "https://ftp.nyse.com/cts_summary_files/";
const MAX_BYTES = 80_000_000;
const MINUTE = 60_000;
const HEADER = "Msg Cat/Type,TransTime,SeqNum,Symbol,instrumentType,partiId,prevClosePriceDate,lastClosePrice,highPrice,lowPrice,openPrice,totalVolume,shortSaleRestrictionInd,primaryListingMarketPartiId,financialStausInd,numberOfParticipants";
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const CONSOLIDATED = new Set(["ConsolidatedEODSummary", "FractionalConsolidatedEODSummary"]);
const PARTICIPANT = new Set(["ParticipantEODSummary", "FractionalParticipantEODSummary"]);

export interface CtaReference {
  scope: "private-price-reconciliation";
  basis: "as-traded-primary-listing-participant-eod-summary";
  source: string;
  sha256: string;
  rows: (SessionPrice & { symbol: ReferenceSymbol; summaryAt: string })[];
}

function archiveUrl(session: string): string {
  return ARCHIVE + "CTA.Summary.EODSUM." + session.replaceAll("-", "") + ".csv";
}

function checkSession(bounds: Session) {
  const reviewed = hasReviewedCalendar(bounds.session);
  const day = bounds.session.replaceAll("-", "");
  const givenClose = bounds.closeAt;
  if (
    bounds.openAt !== newYorkTimestamp(day + "T093000") ||
    (givenClose !== newYorkTimestamp(day + "T160000") &&
      givenClose !== newYorkTimestamp(day + "T130000"))
  ) throw new Error("CTA reference requires exact New York core session bounds");
  if (reviewed) {
    const expected = exchangeSession(bounds.session);
    if (!expected || givenClose !== expected.closeAt)
      throw new Error("CTA session differs from the reviewed exchange calendar");
  }
}

function archiveDay(line: string): string | null {
  const match = /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) \d{2}:\d{2}:\d{2} (?:ET|EST|EDT) (\d{4}) prod$/.exec(line);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]) + 1;
  if (!month) return null;
  return [match[3], String(month).padStart(2, "0"), match[2].padStart(2, "0")].join("-");
}

function summaryTime(day: string, value: string): string {
  const match = /^_(\d{2}):(\d{2}):(\d{2})(?:\.(\d{0,3}))?$/.exec(value);
  if (!match) throw new Error("Invalid CTA summary timestamp");
  const seconds = newYorkTimestamp(day.replaceAll("-", "") + "T" + match.slice(1, 4).join(""));
  if (!seconds) throw new Error("Invalid CTA summary clock time");
  return seconds.replace(".000Z", "." + (match[4] ?? "").padEnd(3, "0") + "Z");
}

function positivePrice(value: string): number {
  const price = Number(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(price) || price <= 0)
    throw new Error("Invalid CTA summary price");
  return price;
}

type ClosingSummary = { at: string; close: number; venue: string; open?: number };
type Selection = {
  firstConsolidated?: string;
  lastConsolidated?: ClosingSummary;
  lastParticipant?: ClosingSummary;
};

function newest(
  previous: ClosingSummary | undefined,
  current: ClosingSummary,
): ClosingSummary {
  if (!previous || previous.at < current.at) return current;
  if (
    previous.at === current.at &&
    (previous.close !== current.close || previous.open !== current.open || previous.venue !== current.venue)
  ) throw new Error("Conflicting final CTA summary rows");
  return previous;
}

/**
 * Independent Tape B price checks from CTA's anonymous end-of-day archive.
 * The primary listing participant reports its first qualifying and last price.
 * The summary is not a timestamped record of opening or closing auction prints.
 * Confirm any unreviewed historical session against the exchange before passing it here.
 */
export function parseCtaReference(bytes: Uint8Array, bounds: Session): CtaReference {
  checkSession(bounds);
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
    throw new Error("CTA archive is empty or exceeds 80 MB");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split(/\r?\n/);
  if (archiveDay(lines[0]) !== bounds.session || lines[1] !== HEADER)
    throw new Error("CTA archive schema or session date differs");
  const close = Date.parse(bounds.closeAt);
  const selections = new Map<string, Selection>(CTA_REFERENCE_SYMBOLS.map(symbol => [symbol, {}]));

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!/,(?:SPY|IWM|DIA),/.test(line)) continue;
    const [kind, clock, , symbol, asset, participant, previousDate, last, , , opening, , , listing] = line.split(",");
    const selected = selections.get(symbol);
    const consolidated = CONSOLIDATED.has(kind);
    if (!selected || (!consolidated && !(PARTICIPANT.has(kind) && participant === "ARCA"))) continue;
    if (asset !== "Equity" || previousDate !== "_")
      throw new Error("CTA summary is not a current equity price");
    const at = summaryTime(bounds.session, clock);
    if (Date.parse(at) < close) throw new Error("CTA summary precedes the core session close");
    const rawClose = positivePrice(last);

    if (consolidated) {
      if (opening !== "" || listing !== "ARCA") throw new Error("CTA listing or consolidated price schema changed");
      if (!selected.firstConsolidated || at < selected.firstConsolidated)
        selected.firstConsolidated = at;
      selected.lastConsolidated = newest(selected.lastConsolidated, { at, close: rawClose, venue: listing });
    } else {
      selected.lastParticipant = newest(selected.lastParticipant, { at, close: rawClose, venue: participant, open: positivePrice(opening) });
    }
  }

  const rows = CTA_REFERENCE_SYMBOLS.map(symbol => {
    const { firstConsolidated, lastConsolidated, lastParticipant } = selections.get(symbol)!;
    if (
      !firstConsolidated || Date.parse(firstConsolidated) > close + 30 * MINUTE ||
      !lastConsolidated || !lastParticipant || lastParticipant.open === undefined ||
      // Appendix D's final sweep is about four hours after the core close.
      // The verified short-day archive shifts both the core close and the sweep.
      Math.min(Date.parse(lastConsolidated.at), Date.parse(lastParticipant.at)) < close + 240 * MINUTE ||
      Math.abs(Date.parse(lastConsolidated.at) - Date.parse(lastParticipant.at)) >= MINUTE
    ) throw new Error(`CTA archive lacks a complete final ARCA summary for ${symbol}`);
    return { ...bounds, symbol, open: lastParticipant.open, close: lastParticipant.close, summaryAt: lastParticipant.at };
  });

  return {
    scope: "private-price-reconciliation",
    basis: "as-traded-primary-listing-participant-eod-summary",
    source: archiveUrl(bounds.session),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rows,
  };
}

/** Supply previously downloaded private archive bytes to validate without another request. */
export async function collectCtaReference(
  day: string,
  options: { cachedBytes?: Uint8Array; fetcher?: Fetcher; sessionClock?: typeof exchangeSession } = {},
): Promise<{ reference: CtaReference; bytes: Uint8Array }> {
  const bounds = (options.sessionClock ?? exchangeSession)(day);
  if (!bounds) throw new Error("CTA date has no reviewed exchange session");
  if (options.cachedBytes) {
    return { reference: parseCtaReference(options.cachedBytes, bounds), bytes: options.cachedBytes };
  }
  if (Date.now() < Date.parse(bounds.closeAt) + 240 * MINUTE)
    throw new Error("CTA final summary is not due yet");
  const response = await sourceResponse(options.fetcher ?? fetch, archiveUrl(day), {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "User-Agent": "The Daily Consensus public research https://thedailyconsensus.com",
      Accept: "text/csv,application/octet-stream",
    },
  });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BYTES)
      throw new Error("CTA archive exceeds 80 MB");
    for (;;) {
      const piece = await sourceChunk(reader);
      if (piece.done) break;
      size += piece.value.byteLength;
      if (size > MAX_BYTES) throw new Error("CTA archive exceeds 80 MB");
      chunks.push(piece.value);
    }
    const encoding = response.headers.get("content-encoding");
    if (declared !== null && (!encoding || encoding === "identity") && Number(declared) !== size)
      throw new Error("CTA archive is incomplete");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  return { reference: parseCtaReference(bytes, bounds), bytes };
}
