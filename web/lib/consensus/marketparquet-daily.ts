import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import type { PriceEvidence } from "./evaluation.ts";
import { digest } from "./history.ts";
import { collectMarketParquetFundReference, type FundProof } from "./marketparquet-market-history.ts";
import { verifyMarketParquetControlEntitlement, type LicensedMarketParquetLedger } from "./marketparquet-settlement.ts";
import { ETF_SYMBOLS, MARKETPARQUET_SOURCE, reconcileMarketParquet, type ReferenceBars } from "./marketparquet.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { readResearchReceipt } from "./research-price-capture.ts";

type ETF = typeof ETF_SYMBOLS[number];
type Policy = { schemaVersion: 1; control: "market-history"; registeredAt: string };
type Approval = { schemaVersion: 1; day: string; symbol: ETF; policy: string; ledger: string; approvedAt: string; reference: FundProof };
type Envelope<T> = { value: T; sha256: string };
const store = (root: string) => resolve(root, ".consensus/private-marketparquet/daily");
const isInstant = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isHash = (value: string) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const regular = (day: string) => {
  const clock = exchangeSession(day);
  return !!clock && Date.parse(clock.closeAt) - Date.parse(clock.openAt) === 6.5 * 3_600_000;
};

async function original<T>(path: string, value: T) {
  const envelope = { value, sha256: digest(value) };
  try { await durableJSON(path, envelope, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const saved = await readResearchReceipt<Envelope<T>>(path);
  if (!saved || digest(saved.value) !== saved.sha256) throw new Error("A sealed daily MarketParquet source changed");
  return saved;
}

export async function marketParquetDailyPolicy(root: string): Promise<Policy | null> {
  const record = await readResearchReceipt<Envelope<Policy>>(resolve(store(root), "policy.json"));
  if (!record) return null;
  const p = record.value;
  if (!p || Object.keys(p).sort().join() !== "control,registeredAt,schemaVersion" || p.schemaVersion !== 1 ||
      p.control !== "market-history" || !isInstant(p.registeredAt) || p.registeredAt > new Date().toISOString() ||
      digest(p) !== record.sha256) throw new Error("The private MarketParquet daily policy could not be verified");
  return p;
}

/** Enrollment records the real current clock, with no credential, price request or retroactive eligibility. */
export async function registerMarketParquetDaily(root: string) {
  const existing = await marketParquetDailyPolicy(root);
  if (existing) return existing;
  const policy: Policy = { schemaVersion: 1, control: "market-history", registeredAt: new Date().toISOString() };
  await durableDirectory(store(root), 0o700);
  await original(resolve(store(root), "policy.json"), policy);
  return (await marketParquetDailyPolicy(root))!;
}

function dayLedger(ledger: LicensedMarketParquetLedger, day: string) {
  const files = ledger.bars.filter(file => file.session === day);
  const downloads = ledger.licensedCapture?.downloads.filter(item => item.session === day);
  if (files.length !== 1 || downloads?.length !== 1) throw new Error("No unique licensed MarketParquet ETF file for this date");
  const { source, capturedAt, document, sha256 } = ledger.licensedCapture.entitlement;
  const input = downloads[0];
  return { schemaVersion: ledger.schemaVersion, capturedAt: ledger.capturedAt, expectedSessions: [day], bars: files,
    distributions: ledger.distributions.map(({ symbol, source, responseUrl, capturedAt, sha256, actionsSha256, cash }) =>
      ({ symbol, source, responseUrl, capturedAt, sha256, actionsSha256, cash: cash.map(({ session, amount }) => ({ session, amount })) })),
    licensedCapture: { entitlement: { source, capturedAt, document, sha256 },
      downloads: [{ session: input.session, source: input.source, objectHost: input.objectHost, authorizedAt: input.authorizedAt,
        retrievedAt: input.retrievedAt, size: input.size, sha256: input.sha256, authorizationSha256: input.authorizationSha256,
        pricesSha256: input.pricesSha256 }] } };
}

function clockPermits(policy: Policy, day: string, asOf: string) {
  const clock = exchangeSession(day);
  return isInstant(asOf) && !!clock && regular(day) && policy.registeredAt < clock.openAt && clock.closeAt < asOf;
}

async function checkedDay(root: string, ledger: LicensedMarketParquetLedger, symbol: ETF, day: string,
  policy: Policy, asOf: string, cachedOnly: boolean, fetcher?: typeof fetch, signal?: AbortSignal) {
  if (!clockPermits(policy, day, asOf)) throw new Error("The session predates registration, remains open or has a shortened close");
  const licensed = verifyMarketParquetControlEntitlement(JSON.stringify(ledger), day, asOf);
  if (licensed.dates.length !== 1) throw new Error("A daily receipt must contain exactly one session");
  const fund = await collectMarketParquetFundReference(root, symbol, [day], licensed.cash[symbol], cachedOnly,
    { fetcher, signal, ...(cachedOnly ? { asOf } : {}) });
  const references = Object.fromEntries(ETF_SYMBOLS.map(s => [s, s === symbol ? fund.prices : []])) as ReferenceBars;
  const checked = reconcileMarketParquet([day], licensed.ledger.bars, licensed.cash, references,
    { openBps: 3, closeBps: 15 }, { requireDirection: true });
  if (!checked.symbols.find(s => s.symbol === symbol)?.matched.includes(day)) return null;
  // Every edition targeting this open was issued after the prior session opened, including weekends.
  // Two reviewed calendar dates admit the previous evening's issue, with a single price row for this session.
  const lookback = new Date(Date.parse(day) - 14 * 86_400_000).toISOString().slice(0, 10);
  const expectedSessions = exchangeSessions(lookback < EXCHANGE_CALENDAR.from ? EXCHANGE_CALENDAR.from : lookback, day).slice(-2);
  if (expectedSessions.length !== 2) throw new Error("The prior exchange session is outside the reviewed calendar");
  const evidence: PriceEvidence = { instrument: symbol, source: MARKETPARQUET_SOURCE, adjustment: OUTCOME_PRICE_BASIS,
    expectedSessions,
    sessions: [{ ...exchangeSession(day)!, ...licensed.ledger.bars[0].bars[symbol] }] };
  return { reference: fund.proof, evidence };
}

async function replayDay(root: string, policy: Policy, file: string, day: string, symbol: ETF, asOf: string) {
  const sealed = await readResearchReceipt<Envelope<Approval>>(file);
  if (!sealed) return null;
  const row = sealed.value;
  if (!row || Object.keys(row).sort().join() !== "approvedAt,day,ledger,policy,reference,schemaVersion,symbol" ||
      row.schemaVersion !== 1 || row.day !== day || row.symbol !== symbol || row.policy !== digest(policy) ||
      !isHash(row.ledger) || !isInstant(row.approvedAt) || sealed.sha256 !== digest(row))
    throw new Error("Invalid daily MarketParquet approval");
  if (row.approvedAt > asOf) return null;
  const capture = await readResearchReceipt<Envelope<LicensedMarketParquetLedger>>(resolve(store(root), "captures", row.ledger + ".json"));
  if (!capture || capture.sha256 !== row.ledger || digest(capture.value) !== row.ledger)
    throw new Error("The licensed one-day archive changed");
  const checked = await checkedDay(root, capture.value, symbol, day, policy, row.approvedAt, true);
  if (!checked || digest(checked.reference) !== digest(row.reference)) throw new Error("The native one-day controls changed");
  return checked.evidence;
}

export async function collectMarketParquetDaily(root: string, ledger: LicensedMarketParquetLedger, policy: Policy) {
  const saved = await marketParquetDailyPolicy(root);
  if (!saved || digest(saved) !== digest(policy)) throw new Error("Daily price collection requires its original prospective registration");
  const now = new Date().toISOString(), calendar = ledger.expectedSessions;
  if (!Array.isArray(calendar) || !calendar.length || calendar.join() !== exchangeSessions(calendar[0], calendar.at(-1)!).join())
    throw new Error("Invalid selected daily archive calendar");
  const shortenedSessions = calendar.filter(day => {
    const clock = exchangeSession(day)!;
    return policy.registeredAt < clock.openAt && clock.closeAt < now && !regular(day);
  });
  const days = calendar.filter(day => clockPermits(policy, day, now)).reverse();
  const directory = store(root), approvals = resolve(directory, "approvals"), captures = resolve(directory, "captures");
  await durableDirectory(approvals, 0o700);
  await durableDirectory(captures, 0o700);
  const deadline = AbortSignal.timeout(120_000);
  const accepted: { symbol: ETF; day: string }[] = [], withheld: { symbol: ETF; day: string; reason: string }[] = [];
  const resume = resolve(directory, "resume.json");
  const cursor = await readResearchReceipt<{ next: ETF; previousBackfill?: Partial<Record<ETF, string>> }>(resume);
  const first = cursor ? Math.max(ETF_SYMBOLS.indexOf(cursor.next), 0) : 0;
  const funds = [...ETF_SYMBOLS.slice(first), ...ETF_SYMBOLS.slice(0, first)];
  const previousBackfill = { ...cursor?.previousBackfill };
  const existing = new Set(await readdir(approvals));
  const latest: { symbol: ETF; day: string }[] = [], backfill: typeof latest = [];
  for (const symbol of funds) {
    const due = days.filter(day => !existing.has(day + "-" + symbol + ".json"));
    if (!due.length) continue;
    latest.push({ symbol, day: due[0] });
    const remaining = due.slice(1), last = previousBackfill[symbol];
    if (remaining.length) backfill.push({ symbol, day: (last && remaining.find(day => day < last)) || remaining[0] });
  }
  // Give each fund its newest missing session before rotating through older gaps, including failed dates.
  for (const job of [...latest, ...backfill]) {
    const { symbol, day } = job;
    if (deadline.aborted) return { accepted, withheld, shortenedSessions, deadlineReached: true };
    const file = resolve(approvals, day + "-" + symbol + ".json");
    try {
      if (await readResearchReceipt(file)) continue;
      if (backfill.includes(job)) previousBackfill[symbol] = day;
      // Resume after this fund even when a provider exhausts the run clock during its retry.
      const next = ETF_SYMBOLS[(ETF_SYMBOLS.indexOf(symbol) + 1) % ETF_SYMBOLS.length];
      await durableJSON(resume, { next, previousBackfill });
      const capture = dayLedger(ledger, day);
      const comparisonDeadline = AbortSignal.any([deadline, AbortSignal.timeout(75_000)]);
      const fetcher: typeof fetch = (input, init) => fetch(input, { ...init,
        signal: AbortSignal.any([deadline, comparisonDeadline, ...(init?.signal ? [init.signal] : [])]) });
      const checked = await checkedDay(root, capture, symbol, day, policy, now, false, fetcher, comparisonDeadline);
      if (!checked) { withheld.push({ symbol, day, reason: "price_difference" }); continue; }
      deadline.throwIfAborted();
      const ledgerHash = digest(capture);
      const captured = await original(resolve(captures, ledgerHash + ".json"), capture);
      if (captured.sha256 !== ledgerHash) throw new Error("A different licensed file already occupies this fingerprint");
      const approvedAt = new Date().toISOString();
      const row: Approval = { schemaVersion: 1, day, symbol, policy: digest(policy), ledger: ledgerHash,
        approvedAt, reference: checked.reference };
      await original(file, row);
      if (!await replayDay(root, policy, file, day, symbol, approvedAt)) throw new Error("Daily approval could not replay");
      accepted.push({ symbol, day });
    } catch { withheld.push({ symbol, day, reason: "source_unavailable" }); }
  }
  return { accepted, withheld, shortenedSessions, deadlineReached: false };
}

export async function loadMarketParquetDaily(root: string, asOf: string, warn: (message: string) => void = console.error) {
  const policy = await marketParquetDailyPolicy(root);
  if (!policy) return [];
  const directory = resolve(store(root), "approvals");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const series: PriceEvidence[] = [];
  for (const name of names.sort()) {
    const match = /^(\d{4}-\d\d-\d\d)-(SPY|QQQ|IWM|DIA|TLT)\.json$/.exec(name);
    if (!match) continue;
    const [, day, symbol] = match;
    try {
      if (!clockPermits(policy, day, asOf)) continue;
      const evidence = await replayDay(root, policy, resolve(directory, name), day, symbol as ETF, asOf);
      if (evidence) series.push(evidence);
    } catch { warn("Withheld the MarketParquet daily approval for " + symbol + " on " + day + " because the original failed replay."); }
  }
  return series;
}
