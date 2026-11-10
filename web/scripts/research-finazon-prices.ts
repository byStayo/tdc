import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkFinazonSeries, type FinazonReference } from "../lib/consensus/finazon.ts";
import { sourceChunk } from "../lib/consensus/source-failure.ts";
import { INSTRUMENTS } from "../lib/consensus/types.ts";

const key = process.env.FINAZON_API_KEY?.trim();
if (!key) throw new Error("No Finazon key configured in the local environment");
const [referencePath] = process.argv.slice(2);
if (!referencePath || !isAbsolute(referencePath) || process.argv.length !== 3)
  throw new Error("Provide one absolute path to a private independent reference file");
const file = await lstat(referencePath);
if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 500_000)
  throw new Error("Expected an owner-only regular reference file");

const references: Record<string, FinazonReference> = JSON.parse(await readFile(referencePath, "utf8"));
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
  const raw = await request(symbol, "none"), adjusted = await request(symbol, "all");
  checks.push({ symbol, ...checkFinazonSeries(raw, adjusted, references[symbol]) });
}
console.log(JSON.stringify({ status: "price_sample_reconciled", checks, published: false }));
