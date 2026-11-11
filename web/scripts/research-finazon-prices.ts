import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkFinazonSeries, type FinazonReference } from "../lib/consensus/finazon.ts";
import { checkTiingoSeries } from "../lib/consensus/tiingo.ts";
import { sourceChunk } from "../lib/consensus/source-failure.ts";
import { INSTRUMENTS } from "../lib/consensus/types.ts";

const args = process.argv.slice(2);
const tiingo = args[0] === "--tiingo-samples";
const usingSamples = args[0] === "--samples" || tiingo;
if (args.length !== (usingSamples ? 3 : 1))
  throw new Error("Provide [--samples or --tiingo-samples, then /absolute/private/samples.json] /absolute/private/reference.json");

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
for (const symbol of symbols) {
  if (tiingo) {
    if (!samples?.[symbol]) throw new Error("Missing supplied samples for " + symbol);
    checks.push({ symbol, ...checkTiingoSeries(samples[symbol], references[symbol]) });
    continue;
  }
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
  checks.push({ symbol, ...checkFinazonSeries(raw, adjusted, references[symbol]) });
}
console.log(JSON.stringify({ status: "price_sample_reconciled", provider: tiingo ? "tiingo" : "finazon",
  input: usingSamples ? "supplied-samples" : "authenticated-api", checks, published: false }));
