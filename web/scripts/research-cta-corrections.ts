import { createHash } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON, syncDirectory } from "../lib/publication-storage.ts";
import { collectCtaCorrectionReport, CTA_REFERENCE_SYMBOLS, type CtaCorrectionKind } from "../lib/consensus/cta-reference.ts";
import { exchangeSession, EXCHANGE_CALENDAR } from "../lib/consensus/exchange-calendar.ts";
import { historicalResearchSession } from "../lib/consensus/research-session-calendar.ts";
import { newYorkDate } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-cta-corrections");
const [day, ...args] = process.argv.slice(2);
const sameDayOnly = args[0] === "--same-day";
const flags = sameDayOnly ? args.slice(1) : args;
const nportPath = flags[0] === "--nport-review" && flags.length === 2 && isAbsolute(flags[1]) ? flags[1] : null;
if (!day || (flags.length && !nportPath))
  throw new Error("Usage: consensus:research-cta-corrections -- SESSION [--same-day] [--nport-review ABSOLUTE_FILE]");
const schedule = (date: string) => date < EXCHANGE_CALENDAR.from ? historicalResearchSession(date) : exchangeSession(date);
const bounds = schedule(day);
if (!bounds || Date.parse(bounds.closeAt) >= Date.now()) throw new Error("CTA correction review needs a completed session");
const next = sameDayOnly ? null : Array.from({ length: 9 }, (_, index) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + (index + 1) * 86_400_000).toISOString().slice(0, 10)).find(date => schedule(date));
if (!sameDayOnly && (!next || Date.parse(schedule(next)!.closeAt) >= Date.now()))
  throw new Error("The next-session correction file needs a completed reviewed session");

async function privateBytes(file: string, limit: number) {
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.mode & 0o077 || !stat.size || stat.size > limit) throw new Error("Correction inputs require bounded owner-only files");
  return readFile(file);
}

async function correction(date: string, kind: CtaCorrectionKind) {
  const file = resolve(directory, `${date.replaceAll("-", "")}-${kind}.csv`);
  const cached = await privateBytes(file, 5_000_000);
  const { report, bytes } = await collectCtaCorrectionReport(date, kind, cached ?? undefined);
  if (!cached) {
    const temporary = `${file}.${process.pid}.tmp`;
    const output = await open(temporary, "wx", 0o600);
    try {
      try { await output.writeFile(bytes); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, file);
      await syncDirectory(directory);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  return report;
}

const unlock = await acquirePublicationLock(root, "private-cta-correction-review");
let failure: { error: unknown } | undefined;
try {
  await durableDirectory(directory, 0o700);
  const current = await correction(day, "CXE");
  const followup = next ? await correction(next, "PRIORDAY") : null;
  const nportBytes = nportPath ? await privateBytes(nportPath, 300_000) : null;
  if (nportPath && !nportBytes) throw new Error("Missing private N-PORT reference");
  const nport = nportBytes ? JSON.parse(nportBytes.toString("utf8")) : null;
  if (nport && (nport.purpose !== "private-month-end-close-reference" || nport.binding?.session !== day ||
      nport.binding.scheduledCloseAt !== bounds.closeAt || !Array.isArray(nport.closingReferences)))
    throw new Error("N-PORT reference differs from the reviewed correction session");
  const later = current.rows.filter(row => row.eventAt > bounds.closeAt);
  const following = followup?.rows.filter(row => row.priorTradeAt && newYorkDate(row.priorTradeAt) === day) ?? [];
  const counts = CTA_REFERENCE_SYMBOLS.map(symbol => {
    const records = later.filter(row => row.symbol === symbol);
    const original = nport?.closingReferences.find((row: { instrument: string }) => row.instrument === symbol);
    if (nport && (!original || original.session !== day || !Number.isFinite(original.consensusClose)))
      throw new Error(`Missing regulatory closing reference for ${symbol}`);
    const matches = records.filter(row => row.lastVenue === "ARCA" && row.consolidatedLast === original?.consensusClose);
    return { symbol, postCloseUpdates: records.length,
      postCloseRegulatoryCloseMatches: nport ? matches.length : null,
      nextSessionReports: followup ? following.filter(row => row.symbol === symbol).length : null,
      nextSessionCoreTrades: followup ? following.filter(row => row.symbol === symbol && row.priorTradeAt! >= bounds.openAt && row.priorTradeAt! <= bounds.closeAt).length : null };
  });
  const summary = {
    session: day, nextReportDate: next ?? null, sameDayRecords: current.rows.length, postCloseRecords: later.length,
    priorDayRecords: followup ? following.length : null, counts,
  };
  const id = `${day}-${next ?? "same-day"}-${current.sha256.slice(0, 12)}${nportBytes ? "-nport" : ""}`;
  const output = resolve(directory, `${id}.json`);
  const receipt = { schemaVersion: 1, summary, schedule: bounds, current, followup,
    nportSha256: nportBytes ? createHash("sha256").update(nportBytes).digest("hex") : null };
  const existing = await privateBytes(output, 2_000_000);
  if (existing && JSON.stringify(JSON.parse(existing.toString("utf8"))) !== JSON.stringify(receipt))
    throw new Error("Stored CTA correction receipt differs from its inputs");
  if (!existing) await durableJSON(output, receipt, true);
  console.log(JSON.stringify(summary));
  if (counts.some(row => (row.postCloseRegulatoryCloseMatches !== null &&
      (row.postCloseUpdates === 0 || row.postCloseRegulatoryCloseMatches !== row.postCloseUpdates)) ||
      (row.nextSessionCoreTrades ?? 0) > 0)) process.exitCode = 2;
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(unlock, failure);
}
