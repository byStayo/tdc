import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import {
  adjustETFPrices,
  ETF_CASH_SOURCES,
  officialCashLocation,
  type CashDistribution,
} from "../lib/consensus/corporate-adjustment.ts";
import { extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { readNasdaqHistoricalControl } from "../lib/consensus/kibot-session-witnesses.ts";
import {
  collectKibotSeries,
  KIBOT_PRICE_CITATION,
  parseKibotDaily,
} from "../lib/consensus/kibot.ts";
import {
  boundaryClock,
  compareMarketHistoryBoundary,
  contiguousTltWindows,
  marketHistoryBoundaries,
  type Boundary,
  type MarketHistoryETF,
} from "../lib/consensus/market-history-boundaries.ts";
import type {
  DeliveredMarketHistoryHours,
  MarketHistoryGrid,
} from "../lib/consensus/market-history-closes.ts";
import {
  etfHourSource,
  fetchFreeEtfHours,
  type FreeHourlyAccount,
} from "../lib/consensus/market-history-hourly-access.ts";
import {
  tltNativeBar,
  type NativeOriginal,
} from "../lib/consensus/market-history-settlement.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = resolve(root, ".consensus/private-market-history");
const directory = resolve(archive, "five-etf-qualification");
const tlt = resolve(archive, "tlt-settlement");
const tltOriginals = {
  recent: {
    opening: "711bd2441bcb7f6d50f9fd0ee0a23f5001cdefa447fbf161ec295b09dd9871a0",
    closing: "1e1eb35301bcb651d3a38f17c364e0a848b51c75959ef23db9d0dc59091eeabb",
  },
  shortened: {
    opening: "ea86aea68f9ac1757a113dbff46919a21c7ef934ffa6383a2580a1e16158710f",
    closing: "348ffba359b8a8f615fc502a745c4259c0e627fcb833a46cf106e96d6d8fd4c4",
  },
};
const fundOrder: MarketHistoryETF[] = ["SPY", "QQQ", "IWM", "DIA", "TLT"];
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const currentTime = () => new Date().toISOString();
const windows = [
  { from: "2026-10-30", through: "2026-11-20" },
  { from: "2025-11-28", through: "2025-11-28" },
];
type Range = (typeof windows)[number];
type Price = { session: string; open: number; close: number };
type Native = {
  symbol: MarketHistoryETF;
  from: string;
  through: string;
  basis: string;
  source: string;
  capturedAt: string;
  sha256: string;
  csv: string;
};

async function required<T>(path: string): Promise<T> {
  const value = await readResearchReceipt<T>(path);
  if (!value)
    throw new Error(`Missing private source receipt ${path.split("/").at(-1)}`);
  return value;
}

async function loadHourly(
  symbol: MarketHistoryETF,
  range: Range,
  grid: MarketHistoryGrid,
  account?: FreeHourlyAccount,
) {
  const leg = grid === "exchange" ? "closing" : "opening";
  if (symbol === "TLT") {
    // The publisher owns TLT. Reuse its weekend-spanning request, constrained to the requested 16 full sessions.
    const through =
      range.from === windows[0].from ? "2026-11-23" : range.through;
    const id =
      tltOriginals[range.from === windows[0].from ? "recent" : "shortened"][
        leg
      ];
    const delivery = await required<DeliveredMarketHistoryHours>(
      resolve(tlt, id + ".json"),
    );
    if (
      digest(delivery) !== id ||
      delivery.source !== etfHourSource("TLT", range.from, through, grid)
    )
      throw Error("Existing TLT source differs from its pointer");
    return delivery;
  }
  const target = resolve(
    directory,
    `${symbol}-${range.from}-${range.through}-${leg}.json`,
  );
  let delivery = await readResearchReceipt<DeliveredMarketHistoryHours>(target);
  if (!delivery && account) {
    // A refusal is unbilled. Bound the number and duration of retries; any other failure ends collection.
    for (let attempt = 0; attempt < 3; attempt++) {
      let retrySeconds: number | null = null;
      const observed: typeof fetch = async (request, init) => {
        const response = await fetch(request, init);
        if (response.status === 429) {
          const header = response.headers.get("retry-after");
          if (header && /^\d+$/.test(header)) retrySeconds = Number(header);
        }
        return response;
      };
      try {
        delivery = await fetchFreeEtfHours(
          symbol,
          range.from,
          range.through,
          grid,
          account,
          observed,
        );
        break;
      } catch (error) {
        if (attempt === 2 || retrySeconds === null || retrySeconds > 60)
          throw error;
        await wait((Math.max(1, retrySeconds) + 1) * 1000);
      }
    }
    if (delivery) await durableJSON(target, delivery, true);
  }
  if (
    !delivery ||
    delivery.source !== etfHourSource(symbol, range.from, range.through, grid)
  )
    throw Error(
      "Missing or different authenticated " + symbol + " hourly source",
    );
  return delivery;
}

async function equityNative(
  symbol: MarketHistoryETF,
  dates: string[],
  split: boolean,
  collect: boolean,
) {
  const from = dates[0],
    through = dates.at(-1)!,
    basis = split ? "split-only" : "as-traded";
  const file = resolve(directory, `${symbol}-${from}-${through}-${basis}.json`);
  let saved = await readResearchReceipt<Native>(file);
  if (!saved && collect) {
    let csv = "";
    const source = await collectKibotSeries(symbol, dates, {
      unadjusted: !split,
      splitAdjusted: split,
      sessionClock: boundaryClock,
      onVerifiedResponse: (value) => {
        csv = value;
      },
    });
    saved = {
      symbol,
      from,
      through,
      basis,
      source: KIBOT_PRICE_CITATION,
      capturedAt: currentTime(),
      sha256: source.sha256,
      csv,
    };
    await durableJSON(file, saved, true);
  }
  if (
    !saved ||
    saved.from !== from ||
    saved.through !== through ||
    saved.symbol !== symbol ||
    saved.basis !== basis ||
    saved.source !== KIBOT_PRICE_CITATION ||
    sha(saved.csv) !== saved.sha256 ||
    saved.capturedAt <= boundaryClock(through)!.closeAt
  )
    throw Error("Private Kibot basis receipt differs for " + symbol);
  return parseKibotDaily(saved.csv, dates, boundaryClock);
}

async function tltNative(dates: string[], split: boolean) {
  const data: Price[] = [];
  for (const day of dates) {
    const dated = resolve(
      root,
      ".consensus/private-kibot/sources",
      day,
      "TLT-kibot.json",
    );
    const saved = !split
      ? await readResearchReceipt<NativeOriginal>(dated)
      : null;
    const original =
      saved ??
      (await required<NativeOriginal>(
        resolve(
          tlt,
          "controls",
          day,
          split ? "TLT-splits.json" : "TLT-kibot.json",
        ),
      ));
    data.push(tltNativeBar(original, day, split, currentTime()));
  }
  return data;
}

async function cashHistory(symbol: MarketHistoryETF) {
  const target = resolve(
    root,
    ".consensus/private-kibot/sources/2026-11-23/issuer-post-close",
    symbol,
    "issuer-" + symbol,
  );
  const meta = await required<{
    url: string;
    responseUrl?: string;
    capturedAt: string;
    sha256: string;
  }>(target + ".json");
  if (
    meta.url !== ETF_CASH_SOURCES[symbol] ||
    !officialCashLocation(symbol, meta.url, meta.responseUrl ?? meta.url) ||
    meta.capturedAt <= boundaryClock("2026-11-23")!.closeAt ||
    meta.capturedAt > currentTime()
  )
    throw Error("Issuer capture is outside the authorized scope");
  const code =
    "import json,sys\nfrom pathlib import Path\nfrom issuer_corporate_actions import issuer_cash\nprint(json.dumps(issuer_cash(sys.argv[1], Path(sys.argv[2]).read_bytes()),allow_nan=False))";
  const result = await promisify(execFile)(
    "python3",
    ["-B", "-c", code, symbol, target + ".bin"],
    { cwd: resolve(root, "scripts"), timeout: 10000 },
  );
  const parsed = JSON.parse(result.stdout) as {
    symbol: string;
    source: string;
    sha256: string;
    cash: CashDistribution[];
  };
  if (
    parsed.symbol !== symbol ||
    parsed.source !== meta.url ||
    parsed.sha256 !== meta.sha256 ||
    !parsed.cash.length
  )
    throw Error("Issuer original differs from its source receipt");
  return parsed;
}

async function listing(
  symbol: MarketHistoryETF,
  dates: string[],
  collect: boolean,
) {
  const isTltFull = symbol === "TLT" && dates.length > 1;
  const from = dates[0],
    through = isTltFull ? "2026-11-23" : dates.at(-1)!;
  let folder = directory;
  let witnessHash: string | undefined;
  if (isTltFull) {
    folder = resolve(tlt, "controls", "2026-11-24T04-03-09.467Z");
    witnessHash =
      "0b9d848d8084a557cbb453be725cc4bceb3c5e2c77d46a4c7d05023482f50d6b";
  }
  const prices: Price[] = [];
  for (const date of dates) {
    const result = await readNasdaqHistoricalControl(
      folder,
      symbol,
      date,
      collect && symbol !== "TLT",
      fetch,
      boundaryClock,
      { from, through },
    );
    if (witnessHash && result.stamp.sha256 !== witnessHash)
      throw Error("TLT exchange receipt no longer matches the publisher");
    prices.push({ session: date, ...result.prices });
  }
  return prices;
}

async function shortenedWitness(symbol: MarketHistoryETF) {
  const day = "2025-11-28";
  if (symbol === "TLT" || symbol === "QQQ") {
    const file = resolve(
      root,
      ".consensus/private-nasdaq-crosses/2025-11-28-e965ea6f9779.json",
    );
    const bytes = await readFile(file);
    if (
      sha(bytes) !==
      "2cc16cfd6ff2b5f8051384488352a7c6df2350e6f47acb23dca79ae8d0f0d485"
    )
      throw Error("Short-session opening and closing auction evidence changed");
    const x = JSON.parse(bytes.toString()).comparison.find(
      (r: { symbol: string }) => r.symbol === symbol,
    );
    return {
      type: "executed Nasdaq auctions",
      prices: { session: day, open: x.open.price, close: x.close.price },
      auction: true,
    };
  }
  const file = resolve(
    root,
    ".consensus/private-early-close-review/cta-" + day + ".json",
  );
  if (
    sha(await readFile(file)) !==
    "9a0c3c2dd8cb8507577e66445802b2480bb6a9111dabe058a1c2cd6bd1a8cdd1"
  )
    throw Error("Short-session listing-participant receipt changed");
  const src = await required<{
    source: string;
    basis: string;
    sha256: string;
    rows: (Price & { symbol: string })[];
  }>(file);
  if (
    src.basis !== "as-traded-primary-listing-participant-eod-summary" ||
    src.source !==
      "https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.20251128.csv" ||
    src.sha256 !==
      "ac07349bbba51c210c779bbf4594befab3d5965c0c6add3addbc56000bdf1639"
  )
    throw Error("Short-session CTA source changed");
  const prices = src.rows.find((r) => r.symbol === symbol && r.session === day);
  if (!prices) throw Error("Short-session CTA participant record missing");
  return { type: "CTA listing-participant summary", prices, auction: false };
}

async function firstRateControls() {
  const { approval, sha256 } = await required<{
    approval: { symbols: { symbol: MarketHistoryETF; rows: Price[] }[] };
    sha256: string;
  }>(
    resolve(
      root,
      ".consensus/private-firstrate/approvals/2026-11-20-e606712aeb2b581fe8167a7435583a65b9bfdb802d4a02d9a535c422496d495d.json",
    ),
  );
  if (
    sha256 !==
      "ec0643aa45b8a0ed4b1add2ee8b688a6e3f8f4bf9c92d9cdbc44d5f02a7d90ca" ||
    digest(approval) !== sha256
  )
    throw Error("FirstRate approved source hash changed");
  return new Map(
    approval.symbols.map((s) => [
      s.symbol,
      new Map(s.rows.map((r) => [r.session, r])),
    ]),
  );
}

export function endpointDifferences(boundary: Boundary, control: Price) {
  if (
    boundary.open === null ||
    boundary.close === null ||
    boundary.session !== control.session
  )
    return null;
  if (
    ![boundary.open, boundary.close, control.open, control.close].every(
      (p) => Number.isFinite(p) && p > 0,
    )
  )
    throw Error("Expected positive finite comparison endpoints");
  return {
    openBps: Math.abs(boundary.open / control.open - 1) * 10000,
    closeBps: Math.abs(boundary.close / control.close - 1) * 10000,
    directionMatches:
      Math.sign(boundary.close - boundary.open) ===
      Math.sign(control.close - control.open),
  };
}

async function qualify(
  symbol: MarketHistoryETF,
  range: Range,
  approved: Awaited<ReturnType<typeof firstRateControls>>,
  issuer: Awaited<ReturnType<typeof cashHistory>>,
  account?: FreeHourlyAccount,
) {
  const dates = extendedResearchSessions(range.from, range.through),
    clocks = dates.map((day) => boundaryClock(day)!);
  const shortened = dates.length === 1 ? await shortenedWitness(symbol) : null;
  const open = await loadHourly(symbol, range, "Asia/Kolkata", account),
    close = await loadHourly(symbol, range, "exchange", account);
  const boundaries = marketHistoryBoundaries(
    open,
    close,
    clocks,
    currentTime(),
    symbol,
  );
  const [raw, split] =
    symbol === "TLT"
      ? await Promise.all([tltNative(dates, false), tltNative(dates, true)])
      : await Promise.all([
          equityNative(symbol, dates, false, !!account),
          equityNative(symbol, dates, true, !!account),
        ]);
  const listed = shortened
    ? [shortened.prices]
    : await listing(symbol, dates, !!account);
  const days = boundaries.map((boundary, i) => {
    const day = dates[i],
      first = approved.get(symbol)?.get(day);
    const firstRate = first ? endpointDifferences(boundary, first) : null;
    let status: string = compareMarketHistoryBoundary(
      boundary,
      raw[i],
      split[i],
      listed[i],
      true,
      shortened?.auction ? shortened.prices : undefined,
    );
    if (
      status === "matched" &&
      firstRate &&
      (!firstRate.directionMatches ||
        firstRate.openBps > 3 ||
        firstRate.closeBps > 15)
    )
      status = "FirstRate_difference";
    return {
      day,
      status,
      boundary,
      raw: raw[i],
      split: split[i],
      listed: listed[i],
      firstRate,
      native: endpointDifferences(boundary, raw[i]),
      listing: endpointDifferences(boundary, listed[i]),
    };
  });
  const cash = issuer.cash.filter(
    (r) => r.session >= range.from && r.session <= range.through,
  );
  const verifiedWindows = contiguousTltWindows(days, cash);
  const adjusted = verifiedWindows.flatMap((block) =>
    adjustETFPrices(
      block.map((r) => ({
        ...boundaryClock(r.day)!,
        open: r.boundary.open!,
        close: r.boundary.close!,
      })),
      cash.filter(
        (d) => d.session >= block[0].day && d.session <= block.at(-1)!.day,
      ),
      [],
    ),
  );
  const cashChecks = cash.map((action) => {
    const index = dates.indexOf(action.session),
      prior = days[index - 1];
    const price = prior?.boundary.close;
    const block = verifiedWindows.find(
      (win) =>
        win.some((r) => r.day === action.session) &&
        win.some((r) => r.day === prior?.day),
    );
    if (!block || !price)
      return {
        session: action.session,
        amount: action.amount,
        status: "unverified preceding session",
        factorDifferenceBps: null,
      };
    const a = (price - action.amount) / price,
      b = (prior.raw.close - action.amount) / prior.raw.close;
    return {
      session: action.session,
      amount: action.amount,
      status: "matched issuer cash and prior close",
      factorDifferenceBps: Math.abs(a - b) * 10000,
    };
  });
  const evidence = {
    symbol,
    range,
    openingBody: open.sha256,
    closingBody: close.sha256,
    issuerSha256: issuer.sha256,
    cash,
    cashChecks,
    shortenedSource: shortened?.type ?? null,
    days,
    adjusted,
  };
  const id = digest(evidence),
    receipt = resolve(directory, id + ".json");
  const existing = await readResearchReceipt(receipt);
  if (existing && digest(existing) !== id)
    throw Error("Five-fund review changed");
  if (!existing) {
    if (!account)
      throw Error(
        "Five-fund comparison has no original review for this replay",
      );
    await durableJSON(receipt, evidence, true);
  }
  return {
    symbol,
    from: range.from,
    through: range.through,
    receipt: id,
    sessions: days.length,
    matched: days.filter((r) => r.status === "matched").length,
    adjusted: adjusted.length,
    sourceHashes: {
      opening: open.sha256,
      closing: close.sha256,
      issuer: issuer.sha256,
    },
    cash,
    cashChecks,
    firstRateChecks: days.filter((r) => r.firstRate).length,
    shortenedSource: shortened?.type ?? null,
    problems: days
      .filter((r) => r.status !== "matched")
      .map((r) => ({ day: r.day, status: r.status })),
    independentMaxBps: {
      open: Math.max(
        ...days.flatMap((r) => [
          r.native?.openBps ?? 0,
          r.listing?.openBps ?? 0,
        ]),
      ),
      close: Math.max(
        ...days.flatMap((r) => [
          r.native?.closeBps ?? 0,
          r.listing?.closeBps ?? 0,
        ]),
      ),
    },
  };
}

export async function qualifyMarketHistoryEtfs(collect = false) {
  const credentials = collect
    ? await required<{ apiKey: string }>(resolve(archive, "credentials.json"))
    : null;
  const account = credentials ? { key: credentials.apiKey } : undefined;
  await durableDirectory(directory, 0o700);
  const approved = await firstRateControls();
  const reports = [];
  for (const range of windows)
    for (const symbol of fundOrder) {
      const issuer = await cashHistory(symbol);
      reports.push(await qualify(symbol, range, approved, issuer, account));
    }
  return {
    scope:
      "private authenticated free-hourly qualification; aggregated comparisons only",
    reports,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--cached", "--collect"].includes(args[0]))
    throw Error("Use --cached or --collect");
  console.log(
    JSON.stringify(
      await qualifyMarketHistoryEtfs(args[0] === "--collect"),
      null,
      2,
    ),
  );
}
