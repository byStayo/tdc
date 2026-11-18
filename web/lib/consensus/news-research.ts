import { createHash } from "node:crypto";
import { exchangeSession } from "./exchange-calendar.ts";
import { unpackGkg } from "./news.ts";
import { sourceChunk, sourceResponse, SourceMissingError, SourceTransportError } from "./source-failure.ts";
import { newYorkTimestamp } from "./time.ts";

const GDELT_ARCHIVE_ROOT = "https://data.gdeltproject.org/gdeltv2/";
const MAX_ARCHIVE_BYTES = 12_000_000;
const MAX_BATCH_ROWS = 100_000;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface NewsBatch {
  session: string;
  batchAt: string;
  cutoff: string;
  sourceUrl: string;
}

interface RecordedBatch {
  lastModifiedAt: string;
  availableAt: string;
  sourceSha256: string;
  archiveBytes: number;
  records: number;
  publishers: number;
}

export type PremarketNewsBatch = NewsBatch & (
  | (RecordedBatch & { status: "available"; tone: number })
  | (RecordedBatch & { status: "insufficient_sample" })
  | { status: "unverified_release"; lastModifiedAt: string | null }
  | { status: "source_missing" | "source_transport" | "source_rejected"; httpStatus?: number }
  | { status: "invalid_archive"; sourceSha256?: string }
);

function archiveTiming(header: string | null) {
  if (!header) return null;
  const stamp = new Date(header);
  return stamp.toUTCString() === header ? stamp.toISOString() : null;
}

async function readArchive(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error("GDELT archive exceeds the byte cap");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function stockMarketTone(text: string, batch: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_BATCH_ROWS) throw new Error("GDELT archive exceeds the row cap");
  // An English web record has a numeric suffix. Translated records have a T prefix.
  const recordId = new RegExp(`^${batch}-\\d+$`);
  const seen = new Set<string>();
  const publishers = new Map<string, { total: number; records: number }>();
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 27 || fields[1] !== batch || fields[2] !== "1" ||
        !recordId.test(fields[0]) || seen.has(fields[0]) ||
        !fields[7].split(";").includes("ECON_STOCKMARKET")) continue;

    const publisher = fields[3].trim().toLowerCase().replace(/^www\./, "");
    const toneFields = fields[15].split(",");
    const tone = Number(toneFields[0]);
    const words = Number(toneFields[6]);
    if (!DOMAIN.test(publisher) || toneFields.length !== 7 || !toneFields[0].trim() ||
        !Number.isFinite(tone) || Math.abs(tone) > 100 || !Number.isSafeInteger(words) || words < 50) continue;

    seen.add(fields[0]);
    const group = publishers.get(publisher) ?? { total: 0, records: 0 };
    group.total += tone;
    group.records += 1;
    publishers.set(publisher, group);
  }
  const counts = { records: seen.size, publishers: publishers.size };
  if (counts.records < 20 || counts.publishers < 10) return { ...counts, status: "insufficient_sample" as const };
  const publisherTotal = [...publishers.values()].reduce((sum, row) => sum + row.total / row.records, 0);
  return { ...counts, status: "available" as const, tone: publisherTotal / counts.publishers };
}

/** Frozen historical screen. Source text and identifiers never leave memory. */
export async function collectPremarketNewsBatch(session: string, fetcher: Fetcher = fetch): Promise<PremarketNewsBatch> {
  const reviewed = exchangeSession(session);
  if (!reviewed) throw new Error("GDELT research requires a reviewed trading session");
  const day = session.replaceAll("-", "");
  const batchAt = newYorkTimestamp(`${day}T070000`)!;
  const cutoff = newYorkTimestamp(`${day}T080000`)!;
  const batch = batchAt.replace(/[-:T]/g, "").slice(0, 14);
  const filename = `${batch}.gkg.csv`;
  const sourceUrl = `${GDELT_ARCHIVE_ROOT}${filename}.zip`;
  const target = { session, batchAt, cutoff, sourceUrl };

  let response: Response;
  try {
    response = await sourceResponse(fetcher, sourceUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const code = error instanceof Error && error.message.match(/^Source HTTP (\d{3})$/);
    const status = error instanceof SourceMissingError ? "source_missing" :
      error instanceof SourceTransportError ? "source_transport" : "source_rejected";
    return { ...target, status, ...(code ? { httpStatus: Number(code[1]) } : {}) };
  }
  if (response.status !== 200) {
    await response.body!.cancel().catch(() => undefined);
    return { ...target, status: "source_rejected", httpStatus: response.status };
  }

  // The provider can write a file before its nominal batch timestamp. Its
  // original Last-Modified must plausibly belong to this batch and precede cutoff.
  const lastModifiedAt = archiveTiming(response.headers.get("Last-Modified"));
  const earliestModifiedAt = new Date(Date.parse(batchAt) - 15 * 60_000).toISOString();
  if (!lastModifiedAt || lastModifiedAt < earliestModifiedAt || lastModifiedAt >= cutoff) {
    await response.body!.cancel().catch(() => undefined);
    return { ...target, status: "unverified_release", lastModifiedAt };
  }
  const availableAt = lastModifiedAt < batchAt ? batchAt : lastModifiedAt;
  let sourceSha256: string | undefined;
  try {
    const data = await readArchive(response.body!);
    sourceSha256 = createHash("sha256").update(data).digest("hex");
    return { ...target, lastModifiedAt, availableAt, sourceSha256, archiveBytes: data.byteLength,
      ...stockMarketTone(unpackGkg(data, filename), batch) };
  } catch (error) {
    if (error instanceof SourceTransportError) return { ...target, status: "source_transport" };
    return { ...target, status: "invalid_archive", ...(sourceSha256 ? { sourceSha256 } : {}) };
  }
}
