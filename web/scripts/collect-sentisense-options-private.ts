import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicDate } from "../lib/public-normalization.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { EXCHANGE_CALENDAR, trailingExchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { sentisenseCredential, sentisenseResponse } from "../lib/consensus/sentisense.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { INSTRUMENTS } from "../lib/consensus/types.ts";

const SYMBOLS = INSTRUMENTS.filter(symbol => symbol !== "MARKET");
const IV_FIELDS = ["atmIv", "atmIv60", "atmIv90", "iv25p", "iv25c"] as const;
const COUNT_FIELDS = ["putOi", "callOi", "putVol", "callVol"] as const;

function parseSession(row: Record<string, unknown>, expected: string) {
  if (row.date !== expected ||
      !IV_FIELDS.every(field => typeof row[field] === "number" && Number.isFinite(row[field]) && row[field] > 0) ||
      !COUNT_FIELDS.every(field => Number.isSafeInteger(row[field]) && (row[field] as number) >= 0) ||
      typeof row.skew25d !== "number" || !Number.isFinite(row.skew25d) ||
      Math.abs(row.skew25d - ((row.iv25p as number) - (row.iv25c as number))) > 0.00011)
    throw new Error("Options session has invalid IV, skew or count fields");
  return Object.fromEntries(["date", ...IV_FIELDS, "skew25d", ...COUNT_FIELDS].map(field => [field, row[field]]));
}

async function capture(symbol: typeof SYMBOLS[number], reportDate: string, apiKey: unknown) {
  const { body, retrievedAt, sha256 } = await sentisenseResponse(`stocks/${symbol}/options/history?window=1y`, apiKey);
  const data = JSON.parse(body.toString("utf8")).data;
  const series: Record<string, unknown>[] = data?.series;
  if (data?.ticker !== symbol || data?.window !== "1y" || !Array.isArray(series) || !series.length ||
      series.length > 252 || series.some((row, i) =>
        !row || typeof row.date !== "string" || publicDate(row.date) !== row.date ||
        (i > 0 && row.date <= (series[i - 1].date as string))))
    throw new Error(`${symbol} options response has the wrong identity or series dates`);
  if (series.at(-1)?.date !== reportDate)
    throw new Error(`${symbol} latest options date does not match the required prior session ${reportDate}`);
  return {
    symbol, retrievedAt, sha256,
    rows: series.length, session: parseSession(series.at(-1)!, reportDate),
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error("The private options capture takes no arguments");
  const startedAt = new Date().toISOString();
  const today = newYorkDate(startedAt);
  const previousSession = trailingExchangeSessions(EXCHANGE_CALENDAR.from, today).filter(day => day < today).at(-1);
  if (!previousSession) throw new Error("There is no preceding options session in the reviewed exchange calendar");
  const prior = previousSession;

  const directory = fileURLToPath(new URL("../.consensus/private-sentisense/", import.meta.url));
  const path = resolve(directory, "daily", prior + ".json");
  async function retained() {
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing === null) return false;
    const result = JSON.parse(existing);
    if (result.schemaVersion !== 1 || result.reportDate !== prior ||
        typeof result.capturedAt !== "string" || !Number.isFinite(Date.parse(result.capturedAt)) ||
        new Date(result.capturedAt).toISOString() !== result.capturedAt || result.capturedAt > new Date().toISOString() ||
        !Array.isArray(result.reports) || result.reports.length !== SYMBOLS.length ||
        result.reports.some((row: Awaited<ReturnType<typeof capture>>, i: number) =>
          row.symbol !== SYMBOLS[i] || !/^[a-f0-9]{64}$/.test(row.sha256) ||
          !(row.retrievedAt > prior && row.retrievedAt <= result.capturedAt) || !parseSession(row.session, prior)))
      throw new Error("Saved options receipt does not match the reviewed capture");
    console.log(JSON.stringify({ status: "retained", reportDate: prior, capturedAt: result.capturedAt, symbols: SYMBOLS }));
    return true;
  }
  if (await retained()) return;
  const { access, apiKey } = await sentisenseCredential(directory);
  if (apiKey === undefined) {
    console.log(JSON.stringify({ status: access, reportDate: prior }));
    return;
  }

  // Three dates are distinct: the reported session, the actual retrieval
  // time, and any forecast cutoff that might later use this capture.
  const reports = [];
  for (const symbol of SYMBOLS) reports.push(await capture(symbol, prior, apiKey));
  const capturedAt = new Date().toISOString();
  try {
    await durableJSON(path, { schemaVersion: 1, reportDate: prior, startedAt, capturedAt, reports }, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && await retained()) return;
    throw error;
  }
  console.log(JSON.stringify({ status: "captured", reportDate: prior, capturedAt, access, symbols: SYMBOLS }));
}

await main();
