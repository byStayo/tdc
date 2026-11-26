import { createHash } from "node:crypto";
import { join } from "node:path";
import { immutableSourceReceipt } from "../publication-storage.ts";
import type { PublicDocument } from "./calendars.ts";
import { latestFirstRateSession } from "./firstrate.ts";
import { digest } from "./history.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceFailureKind } from "./source-failure.ts";
import {
  calendarAllowsTaiwan,
  datedSectorCsv,
  datedSectorReport,
  parseSectorCsv,
  parseSectorReport,
  sectorSignal,
  TWSE_SECTOR_DIRECTORY,
  twseSectorUrls,
  validateSectorSignal,
} from "./twse-sector.ts";
import type { Signal } from "./types.ts";

type Original = { url: string; document: PublicDocument };
const wall = () => new Date().toISOString();

function verified(source: Original, url: string, cutoff: string, earliest?: string) {
  const doc = source.document;
  if (
    source.url !== url ||
    !doc ||
    typeof doc.text !== "string" ||
    Buffer.byteLength(doc.text) > 2_000_000 ||
    !Number.isFinite(Date.parse(doc.retrievedAt)) ||
    new Date(doc.retrievedAt).toISOString() !== doc.retrievedAt ||
    doc.retrievedAt > cutoff ||
    (earliest && doc.retrievedAt < earliest) ||
    createHash("sha256").update(doc.text).digest("hex") !== doc.sha256
  )
    throw Error("TWSE original identity, checksum or collection time differs");
  return doc;
}

function checkSession(
  date: string,
  calendar: Original,
  csvOriginal: Original,
  reportOriginal: Original,
  cutoff: string,
) {
  const urls = twseSectorUrls(date);
  const schedule = verified(calendar, urls.calendar, cutoff);
  if (!calendarAllowsTaiwan(schedule.text, date)) throw Error("Taiwan session closed or mismatched");
  const localClose = date + "T05:30:00.000Z";
  const csv = verified(csvOriginal, urls.csv, cutoff, localClose);
  const report = verified(reportOriginal, urls.report, cutoff, localClose);
  const pair = parseSectorCsv(csv.text, date);
  if (digest(pair) !== digest(parseSectorReport(report.text, date)))
    throw Error("TWSE price indices differ across native formats");
  const commitments = [schedule, csv, report].map(({ sha256, retrievedAt }) => ({ sha256, retrievedAt }));
  return {
    date,
    pair,
    seal: digest({ date, commitments }),
    firstAt: commitments
      .map((d) => d.retrievedAt)
      .sort()
      .at(-1)!,
  };
}

async function retained<T>(directory: string, file: string, acquire: () => Promise<T>, verify: (row: T) => void) {
  const old = await readResearchReceipt<T>(join(directory, file));
  if (old) {
    verify(old);
    return old;
  }
  return immutableSourceReceipt(directory, file, acquire, verify);
}

/** Repeated collections reuse the first verified bytes and their original availability clock. */
export async function collectTwseSector(
  root: string,
  read: (url: string) => Promise<PublicDocument>,
  now = wall,
): Promise<Signal> {
  try {
    const date = latestFirstRateSession(now()),
      urls = twseSectorUrls(date),
      dir = join(root, TWSE_SECTOR_DIRECTORY);
    const acquire = async (url: string): Promise<Original> => ({ url, document: await read(url) });
    const calendar = await retained(
      join(dir, "calendars"),
      date.slice(0, 4) + ".json",
      () => acquire(urls.calendar),
      (d) => {
        calendarAllowsTaiwan(verified(d, urls.calendar, now()).text, date);
      },
    );
    if (!calendarAllowsTaiwan(calendar.document.text, date)) return sectorSignal(now());
    // Freeze each dated first delivery even when its peer is unavailable, suppressed or later revised.
    const capture = (kind: "csv" | "report") =>
      retained(
        join(dir, "sessions"),
        date + "-" + kind + ".json",
        () => acquire(urls[kind]),
        (row) => {
          const doc = verified(row, urls[kind], now(), date + "T05:30:00.000Z");
          (kind === "csv" ? datedSectorCsv : datedSectorReport)(doc.text, date);
        },
      );
    const [csv, report] = await Promise.allSettled([capture("csv"), capture("report")]);
    // Both private operations must finish. Invalid native data must not revive an older source as a network outage.
    if (csv.status === "rejected" && sourceFailureKind(csv.reason) === "validation") throw csv.reason;
    if (report.status === "rejected") throw report.reason;
    if (csv.status === "rejected") throw csv.reason;
    const at = now();
    return sectorSignal(at, checkSession(date, calendar, csv.value, report.value, at));
  } catch (error) {
    return { ...sectorSignal(now()), failureKind: sourceFailureKind(error) };
  }
}

/** No network or recovery on replay. Verify both original deliveries, exact fiscal year and signed results. */
export async function replayTwseSector(root: string, signal: Signal, cutoff: string) {
  validateSectorSignal(signal, cutoff);
  const date = signal.source.observedAt;
  if (!date || signal.status !== "available") return null;
  const dir = join(root, TWSE_SECTOR_DIRECTORY);
  const [calendar, csv, report] = await Promise.all([
    readResearchReceipt<Original>(join(dir, "calendars", date.slice(0, 4) + ".json")),
    readResearchReceipt<Original>(join(dir, "sessions", date + "-csv.json")),
    readResearchReceipt<Original>(join(dir, "sessions", date + "-report.json")),
  ]);
  if (!calendar || !csv || !report) return null;
  const proof = checkSession(date, calendar, csv, report, cutoff);
  const expected = sectorSignal(signal.source.retrievedAt, proof);
  if (
    proof.seal !== signal.source.sha256 ||
    proof.firstAt !== signal.source.vintageAt ||
    digest(expected.metrics) !== digest(signal.metrics)
  )
    throw Error("TWSE as-issued values or first source receipts differ");
  return {
    candidate: expected.metrics[2].value,
    control: expected.metrics[1].value,
    observedThrough: proof.firstAt,
    sourceSeal: proof.seal,
  };
}
