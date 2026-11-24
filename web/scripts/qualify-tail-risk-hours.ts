/// <reference lib="dom.asynciterable" />
/** Independent regular-session boundary checks for the fixed TAIL experiment. No core current target is opened. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { freeMarketHistoryBalance } from "../lib/consensus/market-history-boundaries.ts";
import {
  importMarketHistoryHours,
  parseMarketHistoryHours,
  type DeliveredMarketHistoryHours,
  type MarketHistoryGrid,
} from "../lib/consensus/market-history-closes.ts";
import { authenticatedFreeMarketHistoryResponse } from "../lib/consensus/market-history-hourly-access.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const [mode, study, origin, extra] = process.argv.slice(2);
if (extra || !["--capture", "--replay"].includes(mode) || !study || !origin)
  throw Error(
    "Expected --capture|--replay PRIVATE_STUDY_DIRECTORY PUBLISHER_PRIVATE_SOURCES",
  );
const sources = resolve(study, "market-history");
await durableDirectory(sources, 0o700);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const live = mode === "--capture";
const catalogNames = {
  SPY: "State Street SPDR S&P 500 ETF Trust",
  IEF: "iShares 7-10 Year Treasury Bond ETF",
  TAIL: "Cambria Tail Risk ETF",
} as const;
type Fund = keyof typeof catalogNames;
const registered = await readResearchReceipt<{
  data: { rows: { day: string; prior: string }[] };
}>(resolve(study, "reservation.json"));
if (!registered) throw Error("Missing registered economic dates");
const rows = registered.data.rows;
const historical = rows[Math.floor(rows.length * 0.8)].prior;
assert.equal(historical, "2019-07-24");
const latest = "2026-11-20";
let remaining: number | undefined;
let key = "";
const timeLimit = AbortSignal.timeout(150000);
const official = "https://getmarkethistory.com";
async function fetchFree(url: string) {
  if (!live) throw Error("Private signed source cache is incomplete");
  if (!key) {
    const cred = await readResearchReceipt<{ apiKey: string }>(
      resolve(origin, "private-market-history/credentials.json"),
    );
    if (!cred?.apiKey)
      throw Error("Owner-authorized free Market History credential is absent");
    key = cred.apiKey;
    const balance = await authenticatedFreeMarketHistoryResponse(
      official +
        "/query/v1/fee-rules?dataset=stocks%2Fus&scheme=regulatory_levy&at=" +
        latest,
      key,
      fetch,
      timeLimit,
    );
    try {
      remaining = freeMarketHistoryBalance(balance.headers);
    } finally {
      await balance.body?.cancel();
    }
  }
  if (remaining === undefined || remaining < 100)
    throw Error("Market History free-only balance is insufficient");
  const response = await authenticatedFreeMarketHistoryResponse(
    url,
    key,
    fetch,
    timeLimit,
  );
  const next = freeMarketHistoryBalance(response.headers);
  const charge = Number(response.headers.get("x-bars-charged"));
  assert(charge >= 0 && charge <= 100 && response.status === 200);
  remaining = next;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body!) {
    length += chunk.length;
    if (length > 96000) throw Error("Unexpected response length");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const keys = [
    "content-type",
    "date",
    "x-feed",
    "x-session",
    "x-row-count",
    "x-data-through",
    "x-bars-charged",
    "x-bars-remaining",
    "x-bars-paid-remaining",
    "x-cap-remaining",
    "x-next-cursor",
    "x-limit-clamped",
    "link",
  ];
  return {
    source: url,
    status: response.status,
    headers: Object.fromEntries(
      keys
        .filter((k) => response.headers.has(k))
        .map((k) => [k, response.headers.get(k)!]),
    ),
    sha256: hash(bytes),
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  } satisfies DeliveredMarketHistoryHours;
}
async function catalogue(fund: Fund) {
  const url = `${official}/api/v1/stocks/us/${fund}`;
  const destination = resolve(sources, fund + "-catalogue.json");
  let item = await readResearchReceipt<{
    url: string;
    capturedAt: string;
    sha256: string;
    text: string;
  }>(destination);
  if (!item) {
    if (!live) throw Error("Missing instrument catalogue receipt");
    const response = await fetch(url, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200)
      throw Error("Market History catalogue unavailable");
    const raw = await response.text();
    if (raw.length > 196000) throw Error("Oversized catalogue");
    item = {
      url,
      capturedAt: new Date().toISOString(),
      sha256: hash(raw),
      text: raw,
    };
    await durableJSON(destination, item, true);
  }
  assert.equal(item.url, url);
  assert.equal(hash(item.text), item.sha256);
  const meta = JSON.parse(item.text);
  assert(
    meta.ticker === fund &&
      meta.dataset === "stocks/us" &&
      meta.contract?.asset_class === "us_equity" &&
      meta.contract.name === catalogNames[fund] &&
      meta.contract.status === "active",
  );
  return item.sha256;
}
async function boundary(fund: Fund, day: string, grid: MarketHistoryGrid) {
  const url = new URL(`${official}/query/v1/bars/stocks/us/${fund}/1h`);
  url.search = new URLSearchParams({
    start: day,
    end: day,
    feed: "consolidated",
    adjust: "raw",
    tz: grid,
    limit: "100",
    format: "jsonl",
  }).toString();
  const dest = resolve(
    sources,
    `${fund}-${day}-${grid === "exchange" ? "close" : "open"}.json`,
  );
  let item = await readResearchReceipt<DeliveredMarketHistoryHours>(dest);
  if (!item) {
    item = await fetchFree(url.href);
    // Retain the actual provider reply even when it documents a missing boundary.
    await durableJSON(dest, item, true);
  }
  assert.equal(item.source, url.href);
  const now = new Date().toISOString();
  const capture = importMarketHistoryHours(item, fund, now, grid, "raw");
  const bars = parseMarketHistoryHours(capture, fund, grid, "raw");
  const session = extendedResearchSession(day)!;
  const reference =
    grid === "exchange"
      ? Date.parse(session.closeAt) - 3600000
      : Date.parse(session.openAt);
  const row = bars.find((r) => Date.parse(r.timestamp) === reference);
  if (Date.parse(capture.through) < reference + 3600000)
    throw Error("Hourly source ends before the complete boundary");
  const value = !row ? undefined : grid === "exchange" ? row.close : row.open;
  return {
    value,
    sha256: item.sha256,
    servedAt: capture.capturedAt,
    identity: row?.symbol_id,
  };
}
function historicalControls(raw: string, day: string) {
  const prefix =
    day.slice(5, 7) + "/" + day.slice(8, 10) + "/" + day.slice(0, 4) + ",";
  const selected = raw
    .trim()
    .split(/\r?\n/)
    .filter((r) => r.startsWith(prefix));
  assert.equal(selected.length, 1);
  const fields = selected[0].split(",");
  return { open: Number(fields[1]), close: Number(fields[4]) };
}
const evidence = [];
for (const fund of ["TAIL", "IEF", "SPY"] as const) {
  const metaSha256 = await catalogue(fund);
  const days: string[] = fund === "SPY" ? [historical] : [latest, historical];
  for (const day of days) {
    const open = await boundary(fund, day, "Asia/Kolkata"),
      close = await boundary(fund, day, "exchange");
    assert(
      open.identity === close.identity || !open.identity || !close.identity,
    );
    const ready = open.value !== undefined && close.value !== undefined;
    const row = {
      fund,
      day,
      pointInTime: false,
      metaSha256,
      openSha256: open.sha256,
      closeSha256: close.sha256,
      receivedNoLaterThan: [open.servedAt, close.servedAt].sort().at(-1),
      bothBoundaries: ready,
    };
    if (!ready || day !== historical) {
      evidence.push(row);
      continue;
    }
    const control = await readResearchReceipt<{ text: string; sha256: string }>(
      resolve(study, `${fund}-${day.slice(0, 4)}-raw.json`),
    );
    assert(control && control.sha256 === hash(control.text));
    const original = historicalControls(control.text, day);
    const openDifferenceBp = 10000 * (open.value! / original.open - 1),
      closeDifferenceBp = 10000 * (close.value! / original.close - 1);
    evidence.push({
      ...row,
      openDifferenceBp,
      closeDifferenceBp,
      sameSign:
        Math.sign(close.value! - open.value!) ===
        Math.sign(original.close - original.open),
    });
  }
}
const file = resolve(sources, "boundary-review.json");
const prior = await readResearchReceipt<unknown>(file);
if (prior) assert.deepEqual(prior, evidence);
else if (live) await durableJSON(file, evidence, true);
else throw Error("Missing sealed boundary review");
console.log(JSON.stringify(evidence));
