import { link, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquirePublicationLock, finishPublicationLock } from "../publication-lock.ts";
import { durableDirectory, durableJSON, syncDirectory } from "../publication-storage.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { freeMarketHistoryBalance, MARKET_HISTORY_ETF_IDS } from "./market-history-boundaries.ts";
import {
  importMarketHistoryHours,
  parseMarketHistoryHours,
  type DeliveredMarketHistoryHours,
  type MarketHistoryAdjustment,
  type MarketHistoryGrid,
} from "./market-history-closes.ts";
import {
  authenticatedFreeMarketHistoryResponse,
  etfHourSource,
  fetchFreeEtfHours,
  type FreeHourlyAccount,
} from "./market-history-hourly-access.ts";
import { marketHistoryPreview } from "./market-history-preview.ts";
import {
  RANGE_ATTRIBUTION,
  RANGE_FUNDS,
  RANGE_MAX_AGE,
  RANGE_POLICY,
  RANGE_SOURCE,
  rangeInstant,
  validateSessionRanges,
  type RangeFund,
  type SessionRange,
  type SessionRanges,
} from "./regular-session-range.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
const home = (root: string) => resolve(root, ".consensus/private-market-history");
const own = (root: string) => join(home(root), "regular-session-ranges-v1");
const grids = ["Asia/Kolkata", "exchange"] as const,
  bases = ["raw", "splits"] as const;
const now = () => new Date().toISOString();
type FileRef = { file: string; pointer?: true; originalSha256?: string };
type Native = DeliveredMarketHistoryHours;
type Loaded = {
  file: string;
  delivery: Native;
  parsed: Map<number, { high: number; low: number; close: number }>;
  through: number;
  capturedAt: string;
};
type LegTuple = [Loaded, Loaded, Loaded, Loaded];
type Review = {
  method: typeof RANGE_POLICY;
  fund: RangeFund;
  session: string;
  recordedAt: string;
  native: [string, string, string, string];
  closeFifth: number;
};
type Catalogue = {
  dataset: string;
  ticker: string;
  contract: { exchange: string; status: string };
  bars: { timeframes: { timeframe: string; feed: string; venue: string; last: string; updated: string }[] };
};
type Group = { from: string; through: string; legs: Partial<Record<MarketHistoryGrid, FileRef[]>> };
const objectHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const otherFile = (e: unknown) => (e as NodeJS.ErrnoException).code === "EEXIST";
const side = (grid: MarketHistoryGrid) => (grid === "exchange" ? "close" : "open");

async function files(path: string) {
  try {
    return await readdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
async function first<T>(filename: string, value: T) {
  try {
    await durableJSON(filename, value, true);
  } catch (e) {
    if (!otherFile(e)) throw e;
  }
  const stored = await readResearchReceipt<T>(filename);
  if (!stored) throw Error("Missing immutable range evidence");
  return stored;
}

function loadLeg(
  file: string,
  delivery: Native,
  fund: RangeFund,
  grid: MarketHistoryGrid,
  basis: MarketHistoryAdjustment,
  cutoff: string,
): Loaded {
  if (
    Object.keys(delivery.headers).some((h) =>
      /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(h),
    )
  )
    throw Error("Unexpected private header in the hourly receipt");
  freeMarketHistoryBalance(new Headers(delivery.headers));
  const capture = importMarketHistoryHours(delivery, fund, cutoff, grid, basis);
  const rows = parseMarketHistoryHours(capture, fund, grid, basis);
  if (rows[0].symbol_id !== MARKET_HISTORY_ETF_IDS[fund]) throw Error("Hourly source lists another security");
  return {
    file,
    delivery,
    through: Date.parse(capture.through),
    capturedAt: capture.capturedAt,
    parsed: new Map(rows.map((r) => [Date.parse(r.timestamp), r])),
  };
}

function completeLeg(leg: Loaded, grid: MarketHistoryGrid, day: string) {
  const clock = exchangeSession(day);
  if (!clock) return false;
  const open = Date.parse(clock.openAt),
    close = Date.parse(clock.closeAt);
  if (close - open !== 6.5 * HOUR || leg.through < close || Date.parse(leg.capturedAt) < close) return false;
  if (grid === "Asia/Kolkata") return leg.parsed.has(open);
  for (let start = close - HOUR; start >= open; start -= HOUR) if (!leg.parsed.has(start)) return false;
  return true;
}

function completeRange(early: Loaded, late: Loaded, day: string) {
  const clock = exchangeSession(day);
  if (!clock) return null;
  const start = Date.parse(clock.openAt),
    end = Date.parse(clock.closeAt);
  const a = new URL(early.delivery.source).searchParams,
    b = new URL(late.delivery.source).searchParams;
  if (
    a.get("start") !== b.get("start") ||
    a.get("end") !== b.get("end") ||
    a.get("start")! > day ||
    a.get("end")! < day ||
    end - start !== 6.5 * HOUR ||
    Math.min(early.through, late.through, Date.parse(early.capturedAt), Date.parse(late.capturedAt)) < end
  )
    return null;
  const firstBar = early.parsed.get(start);
  if (!firstBar) return null;
  let high = firstBar.high,
    low = firstBar.low,
    close = 0,
    covered = start + HOUR;
  // Every exchange-clock hour in the core session, in ascending order. The first overlaps the opening half-hour.
  const starts = [];
  for (let t = end - HOUR; t >= start; t -= HOUR) starts.unshift(t);
  for (const t of starts) {
    const bar = late.parsed.get(t);
    if (!bar || t > covered || t < start || t + HOUR > end) return null;
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    close = bar.close;
    covered = Math.max(covered, t + HOUR);
  }
  return covered === end && high > low ? { high, low, close } : null;
}

/** Compute the exact fifth using the quoted decimal values, including points mathematically on a boundary. */
export function closeFifth(high: number, low: number, close: number) {
  if (
    ![high, low, close].every((n) => Number.isFinite(n) && n > 0) ||
    high <= low ||
    close < low ||
    close > high
  )
    throw Error("Indeterminate session range");
  const decimal = (n: number) => {
    const [mantissa, exponent] = String(n).split("e"),
      dot = mantissa.indexOf(".");
    return {
      value: BigInt(mantissa.replace(".", "")),
      scale: (dot === -1 ? 0 : mantissa.length - dot - 1) - Number(exponent ?? 0),
    };
  };
  const prices = [high, low, close].map(decimal),
    scale = Math.max(...prices.map((p) => p.scale));
  const [h, l, c] = prices.map((p) => p.value * 10n ** BigInt(scale - p.scale));
  return Math.min(5, 1 + Number((5n * (c - l)) / (h - l)));
}
function verifiedFifth(values: LegTuple, day: string) {
  const raw = completeRange(values[0], values[1], day),
    split = completeRange(values[2], values[3], day);
  if (!raw || !split || raw.high !== split.high || raw.low !== split.low || raw.close !== split.close)
    return null;
  return closeFifth(raw.high, raw.low, raw.close);
}
/** Offline source qualification. Only the coarse derived observation is returned. */
export function rangeFromSignedMarketHistory(
  fund: RangeFund,
  days: string[],
  originals: [Native, Native, Native, Native],
  cutoff: string,
) {
  const legs = originals.map((d, i) =>
    loadLeg("", d, fund, grids[i % 2], bases[Math.floor(i / 2)], cutoff),
  ) as LegTuple;
  return days.map((session) => ({ session, closeFifth: verifiedFifth(legs, session) }));
}
const recent = (at: string) => {
  const left = new Date(Date.parse(at) - RANGE_MAX_AGE - DAY).toISOString().slice(0, 10);
  return exchangeSessions(left < EXCHANGE_CALENDAR.from ? EXCHANGE_CALENDAR.from : left, newYorkDate(at))
    .filter((d) => {
      const clock = exchangeSession(d)!;
      return (
        clock.closeAt <= at &&
        Date.parse(at) - Date.parse(clock.closeAt) <= RANGE_MAX_AGE &&
        Date.parse(clock.closeAt) - Date.parse(clock.openAt) === 390 * 60_000
      );
    })
    .reverse();
};

async function readRangeReview(
  root: string,
  fund: RangeFund,
  day: string,
  at: string,
): Promise<SessionRange | null> {
  const dir = own(root),
    review = await readResearchReceipt<Review>(join(dir, "reviews", fund, day + ".json"));
  if (!review || review.recordedAt > at) return null;
  if (
    review.method !== RANGE_POLICY ||
    review.fund !== fund ||
    review.session !== day ||
    !rangeInstant(review.recordedAt) ||
    !Array.isArray(review.native) ||
    review.native.length !== 4 ||
    !review.native.every(objectHash)
  )
    throw Error("Invalid saved session range");
  const legs = (await Promise.all(
    review.native.map(async (id, i) => {
      const path = join(dir, "objects", id + ".json"),
        d = await readResearchReceipt<Native>(path);
      if (!d || digest(d) !== id) throw Error("Hourly range original differs from its receipt");
      return loadLeg(path, d, fund, grids[i % 2], bases[Math.floor(i / 2)], review.recordedAt);
    }),
  )) as LegTuple;
  if (verifiedFifth(legs, day) !== review.closeFifth)
    throw Error("Saved session range does not match its four original deliveries");
  return {
    fund,
    session: day,
    closeFifth: review.closeFifth,
    observedAt: exchangeSession(day)!.closeAt,
    verifiedAt: review.recordedAt,
    receiptSha256: digest(review),
  };
}
export async function loadMarketHistoryRanges(
  root: string,
  at: string,
  warn: (message: string) => void = () => {},
): Promise<SessionRanges | undefined> {
  if (!rangeInstant(at)) throw Error("Invalid session range cutoff");
  const dates = recent(at),
    rows: SessionRange[] = [];
  for (const fund of RANGE_FUNDS)
    for (const day of dates) {
      try {
        const row = await readRangeReview(root, fund, day, at);
        if (row) {
          rows.push(row);
          break;
        }
      } catch (e) {
        warn(fund + " " + day + ": " + (e instanceof Error ? e.message : "range evidence unavailable"));
      }
    }
  if (!rows.length) return undefined;
  const result = { method: RANGE_POLICY, url: RANGE_SOURCE, attribution: RANGE_ATTRIBUTION, rows } as const;
  validateSessionRanges(result, at);
  return result;
}

/** Reuse saved authorized hourly bodies only. The historical qualification store also contains other,
 * research-only controls, so enumerate its two named hourly response formats explicitly. */
async function buildInventory(root: string, dates: string[], cutoff: string) {
  const base = home(root),
    found = new Map<string, Group[]>();
  function add(
    fund: string,
    basis: MarketHistoryAdjustment,
    from: string,
    through: string,
    grid: MarketHistoryGrid,
    ref: FileRef,
  ) {
    if (!RANGE_FUNDS.includes(fund as RangeFund)) return;
    const key = fund + "/" + basis,
      groups = found.get(key) ?? [];
    let group = groups.find((g) => g.from === from && g.through === through);
    if (!group) {
      group = { from, through, legs: {} };
      groups.push(group);
      found.set(key, groups);
    }
    (group.legs[grid] ??= []).push(ref);
  }
  for (const dir of [
    join(own(root), "legs"),
    join(base, "firstrate-controls"),
    join(base, "five-etf-qualification"),
    join(base, "tlt-settlement"),
  ]) {
    const listing = await files(dir);
    for (const name of listing) {
      const dated =
        /^(SPY|QQQ|IWM|DIA|TLT)-(\d{4}-\d\d-\d\d)-(\d{4}-\d\d-\d\d)-(raw|splits)-(open|close)\.json$/.exec(
          name,
        );
      const pair = /^(SPY|QQQ|IWM|DIA|TLT)-(\d{4}-\d\d-\d\d)-(\d{4}-\d\d-\d\d)-(opening|closing)\.json$/.exec(
        name,
      );
      const pointer = /^(\d{4}-\d\d-\d\d)-(\d{4}-\d\d-\d\d)-(opening|closing)\.json$/.exec(name);
      const file = join(dir, name);
      if (dated && (dir === join(own(root), "legs") || dir === join(base, "firstrate-controls")))
        add(
          dated[1],
          dated[4] as MarketHistoryAdjustment,
          dated[2],
          dated[3],
          dated[5] === "open" ? "Asia/Kolkata" : "exchange",
          { file },
        );
      else if (pair && dir === join(base, "five-etf-qualification"))
        add(pair[1], "raw", pair[2], pair[3], pair[4] === "opening" ? "Asia/Kolkata" : "exchange", { file });
      else if (pointer && dir === join(base, "tlt-settlement"))
        add("TLT", "raw", pointer[1], pointer[2], pointer[3] === "opening" ? "Asia/Kolkata" : "exchange", {
          file,
          pointer: true,
        });
    }
  }
  // A TLT settlement manifest can pin a complete response even when a convenience pointer is absent.
  // Only use its two signed hourly source addresses. This range never opens settlement prices or external controls.
  const settlement = join(base, "tlt-settlement"),
    manifests = join(settlement, "settlements");
  for (const name of await files(manifests)) {
    const match = /^(\d{4}-\d\d-\d\d)_(\d{4}-\d\d-\d\d)_([a-f0-9]{64})\.json$/.exec(name);
    if (!match || !dates.some((day) => day >= match[2] && day <= match[1])) continue;
    try {
      const entry = await readResearchReceipt<{
        review: {
          from: string;
          through: string;
          opening: string;
          closing: string;
          windowFrom: string;
          windowThrough: string;
        };
        reviewedAt: string;
        sha256: string;
      }>(join(manifests, name));
      if (
        !entry ||
        entry.review.windowFrom !== match[2] ||
        entry.review.windowThrough !== match[1] ||
        digest(entry.review) !== match[3] ||
        !rangeInstant(entry.reviewedAt) ||
        entry.reviewedAt > cutoff ||
        digest({ review: entry.review, reviewedAt: entry.reviewedAt }) !== entry.sha256
      )
        continue;
      const { from, through, opening, closing } = entry.review;
      for (const [i, id] of [opening, closing].entries())
        if (objectHash(id))
          add("TLT", "raw", from, through, grids[i], {
            file: join(settlement, id + ".json"),
            originalSha256: id,
          });
    } catch {
      continue;
    }
  }
  return found;
}
async function responseFile(ref: FileRef) {
  if (!ref.pointer) return ref.file;
  const ptr = await readResearchReceipt<{ id: string }>(ref.file);
  if (!ptr || !objectHash(ptr.id)) throw Error("Invalid TLT hourly pointer");
  return resolve(ref.file, "../" + ptr.id + ".json");
}
async function cachedPair(
  groups: Group[],
  fund: RangeFund,
  basis: MarketHistoryAdjustment,
  day: string,
  cutoff: string,
  cache: Map<string, Loaded | null>,
) {
  const candidates = groups
    .filter((g) => g.from <= day && g.through >= day && g.legs.exchange && g.legs["Asia/Kolkata"])
    .sort((a, b) => Date.parse(a.through) - Date.parse(a.from) - Date.parse(b.through) + Date.parse(b.from));
  for (const g of candidates) {
    const pair: Loaded[] = [];
    for (const grid of grids) {
      for (const ref of g.legs[grid] ?? []) {
        const token = [fund, basis, grid, ref.file].join("|");
        try {
          if (!cache.has(token)) {
            const file = await responseFile(ref),
              value = await readResearchReceipt<Native>(file);
            if (
              !value ||
              (ref.originalSha256 && digest(value) !== ref.originalSha256) ||
              (ref.pointer && !file.endsWith(digest(value) + ".json"))
            )
              throw Error("Incomplete range source pointer");
            const query = new URL(value.source).searchParams;
            if (query.get("start") !== g.from || query.get("end") !== g.through)
              throw Error("Dated cache and original query differ");
            cache.set(token, loadLeg(file, value, fund, grid, basis, cutoff));
          }
          const item = cache.get(token);
          if (item && completeLeg(item, grid, day)) {
            pair.push(item);
            break;
          }
        } catch {
          cache.set(token, null);
        }
      }
    }
    if (pair.length === 2 && completeRange(pair[0], pair[1], day)) return pair as [Loaded, Loaded];
  }
  return null;
}
async function pinReview(root: string, fund: RangeFund, day: string, legs: LegTuple, recordedAt: string) {
  const value = verifiedFifth(legs, day);
  if (value === null) return false;
  const dir = own(root),
    objects = join(dir, "objects");
  await durableDirectory(objects, 0o700);
  const ids: string[] = [];
  for (const leg of legs) {
    const id = digest(leg.delivery),
      dest = join(objects, id + ".json");
    // Existing production caches are immutable files on the same publisher volume.
    // Hard links retain their original receipts without making another copy of the provider data.
    try {
      await link(leg.file, dest);
      await syncDirectory(objects);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") await first(dest, leg.delivery);
      else if (!otherFile(e)) throw e;
    }
    const retained = await readResearchReceipt<Native>(dest);
    if (!retained || digest(retained) !== id)
      throw Error("Hourly capture changed before its range was sealed");
    ids.push(id);
  }
  const out = join(dir, "reviews", fund);
  await durableDirectory(out, 0o700);
  await first<Review>(join(out, day + ".json"), {
    method: RANGE_POLICY,
    fund,
    session: day,
    recordedAt,
    native: ids as Review["native"],
    closeFifth: value,
  });
  const verified = await readRangeReview(root, fund, day, recordedAt);
  if (!verified || verified.closeFifth !== value) throw Error("Competing range review disagrees");
  return true;
}
function catalogueThrough(text: string, fund: RangeFund, at: string) {
  const c = JSON.parse(text) as Catalogue,
    venue = fund === "TLT" || fund === "QQQ" ? "NASDAQ" : "ARCA";
  const frames = c.bars?.timeframes?.filter(
    (f) => f.timeframe === "1m" && f.venue === "US consolidated tape" && f.feed === "consolidated",
  );
  if (
    c.dataset !== "stocks/us" ||
    c.ticker !== fund ||
    c.contract?.status !== "active" ||
    c.contract.exchange !== venue ||
    frames?.length !== 1
  )
    throw Error("Invalid official ETF catalogue");
  const { last, updated } = frames[0],
    t = Date.parse(last),
    u = Date.parse(updated);
  if (!Number.isFinite(t) || !Number.isFinite(u) || t > u || u > Date.parse(at))
    throw Error("Invalid hourly catalogue availability");
  return t;
}
type PreparationOptions = {
  live: boolean;
  fetcher?: typeof fetch;
  environmentKey?: string;
  signal?: AbortSignal;
  clock?: () => string;
};
export async function prepareMarketHistoryRanges(root: string, opts: PreparationOptions) {
  const clock = opts.clock ?? now,
    cutoff = clock(),
    dates = recent(cutoff),
    dir = own(root),
    local = new Map<string, Loaded | null>();
  const lock = await acquirePublicationLock(dir, "daily-regular-session-range");
  let failure: { error: unknown } | undefined;
  try {
    const abort = AbortSignal.timeout(42_000),
      slot = opts.signal ? AbortSignal.any([abort, opts.signal]) : abort;
    const upstream = opts.fetcher ?? fetch;
    const fetcher: typeof fetch = (url, init) =>
      upstream(url, { ...init, signal: init?.signal ? AbortSignal.any([slot, init.signal]) : slot });
    const stockKey = opts.live
      ? (opts.environmentKey ??
        process.env.MARKET_HISTORY_KEY ??
        (await readResearchReceipt<{ apiKey: string }>(join(home(root), "credentials.json")))?.apiKey)
      : undefined;
    const account: FreeHourlyAccount | undefined = stockKey ? { key: stockKey, signal: slot } : undefined;
    const inventory = await buildInventory(root, dates, cutoff),
      diagnostics: Record<string, string> = {};
    // Public catalogues are cheap and independent. Each security has a separate delivery clock.
    const catalogue = account
      ? await Promise.allSettled(
          RANGE_FUNDS.map(async (fund) =>
            catalogueThrough((await marketHistoryPreview("stocks/us/" + fund, fetcher)).text, fund, clock()),
          ),
        )
      : [];
    let allowanceError: Error | undefined;
    async function requireFreeBalance(active: FreeHourlyAccount, day: string) {
      if (allowanceError) throw allowanceError;
      if (active.remaining === undefined) {
        try {
          const fee = await authenticatedFreeMarketHistoryResponse(
            "https://getmarkethistory.com/query/v1/fee-rules?dataset=stocks%2Fus&scheme=regulatory_levy&at=" +
              day,
            active.key,
            fetcher,
            slot,
          );
          try {
            if (fee.headers.has("x-bars-charged") && fee.headers.get("x-bars-charged") !== "0")
              throw Error("Unexpected charge on free account preflight");
            active.remaining = freeMarketHistoryBalance(fee.headers);
          } finally {
            await fee.body?.cancel();
          }
        } catch (e) {
          allowanceError = e instanceof Error ? e : Error("Free balance unavailable");
          throw allowanceError;
        }
      }
      if (active.remaining < 100) throw Error("Insufficient free bars for a bounded range request");
    }
    async function fetchBasis(fund: RangeFund, basis: MarketHistoryAdjustment, day: string) {
      // At most four UTC dates: <=97 hourly buckets including the grid's leading half-hour,
      // so each native leg fits a single 100-bar billing block.
      const firstDay = new Date(Date.parse(day) - 3 * DAY).toISOString().slice(0, 10);
      const from = dates.filter((d) => d >= firstDay && d <= day).at(-1) ?? day;
      const pair: Loaded[] = [];
      for (const grid of grids) {
        const stem = [fund, from, day, basis, side(grid)].join("-") + ".json",
          legs = join(dir, "legs"),
          file = join(legs, stem);
        let delivery = await readResearchReceipt<Native>(file);
        if (!delivery) {
          if (!account || slot.aborted) throw Error("No free hourly request available");
          await requireFreeBalance(account, day);
          const url = etfHourSource(fund, from, day, grid, basis),
            claim = join(dir, "requests", newYorkDate(clock()));
          await durableDirectory(claim, 0o700);
          // Reserve at most one billable call per fund, grid and basis on this NY day. A crash may
          // leave a charge ambiguous. The original daily claim bounds subsequent automatic runs.
          const request = join(claim, [fund, basis, side(grid)].join("-") + ".json");
          try {
            await durableJSON(request, { source: url, startedAt: clock(), maxFreeBars: 100 }, true);
          } catch (e) {
            if (otherFile(e)) throw Error("Today's hourly request was already reserved");
            throw e;
          }
          const fresh = await fetchFreeEtfHours(fund, from, day, grid, account, fetcher, basis);
          if (fresh.source !== url) throw Error("Unexpected signed hourly source");
          if (Number(fresh.headers["x-bars-charged"]) > 100) throw Error("Unexpected free range charge");
          await durableDirectory(legs, 0o700);
          // A partial response is a real point-in-time delivery. Keep it by its content, but do
          // not occupy the canonical date range and prevent a subsequent completed delivery.
          const parsed = loadLeg(file, fresh, fund, grid, basis, clock());
          if (!completeLeg(parsed, grid, day)) {
            await first(join(legs, digest(fresh) + ".json"), fresh);
            // Use an earlier completed day in the same delivered range when the top day has a gap.
            pair.push({ ...parsed, file: join(legs, digest(fresh) + ".json") });
            continue;
          }
          delivery = await first(file, fresh);
        }
        const query = new URL(delivery.source);
        if (
          delivery.source !== etfHourSource(fund, from, day, grid, basis) ||
          query.searchParams.get("start") !== from
        )
          throw Error("Stored request changed");
        pair.push(loadLeg(file, delivery, fund, grid, basis, clock()));
      }
      return pair as [Loaded, Loaded];
    }
    for (const [i, fund] of RANGE_FUNDS.entries()) {
      try {
        const result = catalogue[i],
          watermark = result?.status === "fulfilled" ? result.value : null;
        const target =
          watermark === null
            ? undefined
            : dates.find((d) => Date.parse(exchangeSession(d)!.closeAt) <= watermark);
        let newRaw: [Loaded, Loaded] | null = null,
          newSplits: [Loaded, Loaded] | null = null;
        for (const day of dates) {
          const previous = await readRangeReview(root, fund, day, clock()).catch(() => null);
          if (previous) {
            diagnostics[fund] = "retained " + day;
            break;
          }
          let raw = await cachedPair(inventory.get(fund + "/raw") ?? [], fund, "raw", day, clock(), local);
          let splits = await cachedPair(
            inventory.get(fund + "/splits") ?? [],
            fund,
            "splits",
            day,
            clock(),
            local,
          );
          if (day === target) {
            // A transport failure on one fund preserves other funds' independent source checks.
            if (!raw)
              try {
                newRaw = await fetchBasis(fund, "raw", day);
              } catch (e) {
                diagnostics[fund] = e instanceof Error ? e.message : "hourly source unavailable";
              }
            if ((raw || newRaw) && !splits)
              try {
                newSplits = await fetchBasis(fund, "splits", day);
              } catch (e) {
                diagnostics[fund] = e instanceof Error ? e.message : "hourly source unavailable";
              }
          }
          raw ??= newRaw;
          splits ??= newSplits;
          if (raw && splits && (await pinReview(root, fund, day, [...raw, ...splits], clock()))) {
            diagnostics[fund] = "verified " + day;
            break;
          }
        }
        diagnostics[fund] ??=
          result?.status === "rejected"
            ? "catalogue unavailable"
            : account
              ? "awaiting complete native range"
              : "no fresh cached range";
      } catch (e) {
        diagnostics[fund] = e instanceof Error ? e.message : "unavailable";
      }
    }
    const evidence = await loadMarketHistoryRanges(root, clock());
    return {
      mode: opts.live ? (account ? "free-account" : "no-free-account") : "cached-only",
      rows: evidence?.rows.map(({ fund, session }) => ({ fund, session })) ?? [],
      funds: diagnostics,
    };
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(lock, failure);
  }
}
