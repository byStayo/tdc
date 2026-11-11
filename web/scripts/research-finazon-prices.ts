import { randomUUID } from "node:crypto";
import { readFile, lstat, realpath, writeFile, link, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prepareFinazonSeries, type FinazonReference } from "../lib/consensus/finazon.ts";
import { prepareTiingoSeries } from "../lib/consensus/tiingo.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { sourceChunk } from "../lib/consensus/source-failure.ts";
import { INSTRUMENTS } from "../lib/consensus/types.ts";

const args = process.argv.slice(2);
const stage = args[0] === "--stage" ? args.splice(0, 2)[1] ?? "" : undefined;
const tiingo = args[0] === "--tiingo-samples";
const usingSamples = args[0] === "--samples" || tiingo;
if (args.length !== (usingSamples ? 3 : 1))
  throw new Error("Provide [--stage /absolute/private/prices.json] [--samples or --tiingo-samples, then /absolute/private/samples.json] /absolute/private/reference.json");

async function stageDestination(path: string) {
  if (!isAbsolute(path) || !/^[\w.-]+\.json$/.test(basename(path))) throw new Error("Provide an absolute private JSON output path");
  const directory = await realpath(dirname(path));
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
    throw new Error("Expected an owner-only output directory");
  const checkout = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  const location = relative(checkout, directory);
  if (location !== ".." && !location.startsWith("../") && !location.startsWith("web/.consensus/"))
    throw new Error("Keep staged price evidence outside the checkout or in a private web/.consensus directory");
  return join(directory, basename(path));
}

async function readPrivateJson<T>(path: string): Promise<T> {
  if (!isAbsolute(path)) throw new Error("Provide absolute paths to private input files");
  const file = await lstat(path);
  if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 500_000)
    throw new Error("Expected an owner-only regular input file");
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Invalid private input JSON"); }
}

const key = process.env.FINAZON_API_KEY?.trim();
if (!usingSamples && !key) throw new Error("No Finazon key configured in the local environment");
const references = await readPrivateJson<Record<string, FinazonReference>>(args.at(-1)!);
const samples = usingSamples
  ? await readPrivateJson<Record<string, unknown>>(args[1])
  : null;
if (!references || (usingSamples && !samples)) throw new Error("Missing private input data");
const symbols = INSTRUMENTS.filter(instrument => instrument !== "MARKET");
for (const symbol of symbols) {
  const rows = references[symbol]?.sessions;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 260 || !Array.isArray(references[symbol].distributions) ||
      !references[symbol].distributions.some(action => action?.session > rows[0]?.session) ||
      rows.some(row => !row || !/^\d{4}-\d\d-\d\d$/.test(row.session) ||
        !Number.isFinite(Date.parse(row.closeAt)) || Date.parse(row.closeAt) >= Date.now()))
    throw new Error("Expected bounded completed reference sessions including an issuer distribution for " + symbol);
}
const destination = stage === undefined ? null : await stageDestination(stage);
if (destination) {
  const dates = JSON.stringify(references[symbols[0]].sessions.map(row => row.session));
  if (symbols.some(symbol => JSON.stringify(references[symbol].sessions.map(row => row.session)) !== dates))
    throw new Error("Staging requires the same reviewed session window for all five ETFs");
}
let nextRequestAt = 0;
async function request(symbol: string, adjustment: "none" | "all") {
  await delay(Math.max(0, nextRequestAt - Date.now()));
  nextRequestAt = Date.now() + 12_100;
  const rows = references[symbol].sessions;
  const start = Date.parse(rows[0].session) / 1_000;
  const end = Date.parse(rows.at(-1)!.session) / 1_000 + 86_399;
  const url = new URL("https://api.finazon.io/v2.0/finazon/us_stocks_essential/time_series");
  url.search = new URLSearchParams({ ticker: symbol, interval: "1d", prepost: "false", adjust: adjustment,
    order: "asc", page: "0", page_size: "261", start_at: String(start), end_at: String(end) }).toString();
  const response = await fetch(url, { headers: { Authorization: "apikey " + key }, redirect: "error", signal: AbortSignal.timeout(12_000) });
  if (!response.ok || !response.body) throw new Error("Finazon " + symbol + " returned HTTP " + response.status);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 250_000) throw new Error("Finazon response exceeded the bounded sample size");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid Finazon response JSON"); }
}

const checks = [];
const evidence: PriceEvidence[] = [];
for (const symbol of symbols) {
  const reference = references[symbol];
  let verified;
  if (tiingo) {
    if (!samples?.[symbol]) throw new Error("Missing supplied samples for " + symbol);
    verified = prepareTiingoSeries(samples[symbol], reference);
  } else {
    let raw: unknown, adjusted: unknown;
    if (samples) {
      const sample = samples[symbol];
      if (!sample || typeof sample !== "object" || !("raw" in sample) || !("adjusted" in sample) || !sample.raw || !sample.adjusted)
        throw new Error("Missing supplied samples for " + symbol);
      ({ raw, adjusted } = sample);
    } else {
      raw = await request(symbol, "none");
      adjusted = await request(symbol, "all");
    }
    verified = prepareFinazonSeries(raw, adjusted, reference);
  }
  checks.push({ symbol, ...verified.check });
  if (destination) evidence.push({ instrument: symbol,
    source: tiingo ? "https://www.tiingo.com/documentation/end-of-day" : "https://finazon.io/dataset/us_stocks_essential",
    adjustment: OUTCOME_PRICE_BASIS, sessions: verified.sessions,
    expectedSessions: verified.sessions.map(row => row.session) });
}
if (destination) {
  const temporary = join(dirname(destination), `.prices-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(evidence) + "\n", { mode: 0o600, flag: "wx" });
    await link(temporary, destination);
  } finally { await unlink(temporary).catch(() => undefined); }
}
console.log(JSON.stringify({ status: destination ? "price_evidence_staged" : "price_sample_reconciled",
  ...(destination ? { evidence: destination } : {}), provider: tiingo ? "tiingo" : "finazon",
  input: usingSamples ? "supplied-samples" : "authenticated-api", checks, published: false }));
