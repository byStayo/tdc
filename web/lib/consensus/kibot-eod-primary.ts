import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import type { Horizon, Instrument } from "./types.ts";
import { exchangeSession, exchangeSessions, EXCHANGE_CALENDAR, REVIEWED_EXCHANGE_THROUGH } from "./exchange-calendar.ts";
import { outcomeWindowSessions, type PriceEvidence, type SessionPrice } from "./evaluation.ts";
import { digest } from "./history.ts";
import { isFullKibotSession } from "./kibot.ts";
import { kibotPostCloseIssuerActions } from "./kibot-session-witnesses.ts";
import { authenticateKibotSubscriber, kibotSubscriberCredentials, verifyKibotSubscriberProof, type KibotSubscriberProof } from "./kibot-subscriber.ts";
import { collectMarketHistoryFundReference } from "./marketparquet-market-history.ts";
import { ETF_SYMBOLS } from "./marketparquet.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { collectResearchPrices, readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";

import { createKibotCommitment, kibotCommitment, KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
const method = "kibot-subscriber-eod-v1-market-history-consolidated";
const store = (root: string) => resolve(root, ".consensus/private-kibot/production-daily");
type ETF = (typeof ETF_SYMBOLS)[number];
type Choice = { action: "choose-primary"; recordedAt: string; authorization: KibotSubscriberProof } |
  { action: "resume-default"; recordedAt: string };
type Registration = { method: typeof method; registeredAt: string; commitment: string; authorization: KibotSubscriberProof };
export type PrimaryPolicy = Registration & { changes: Choice[] };
type Envelope<T> = { sha256: string; value: T };
type PricePair = Pick<SessionPrice, "session" | "open" | "close">;
type FailureReason = "issuer_original" | "subscriber_prices" | "independent_prices_or_actions" |
  "price_difference" | "ex_date_boundary" | "integrity" | "deadline";
class SourceCheckFailed extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) { super(reason); this.reason = reason; }
}

async function sealed<T>(path: string): Promise<T | null> {
  const saved = await readResearchReceipt<Envelope<T>>(path);
  if (!saved) return null;
  if (Object.keys(saved).sort().join() !== "sha256,value" || digest(saved.value) !== saved.sha256)
    throw Error("A private Kibot primary receipt failed integrity verification");
  return saved.value;
}

async function retain<T>(path: string, value: T) {
  try { await durableJSON(path, { value, sha256: digest(value) }, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return sealed<T>(path);
}

type Decision = Registration | { prior: string; choice: Choice };
type DecisionHead = { count: number; tip: string; decision: Decision };
const headPath = (root: string) => resolve(root, ".consensus/private-kibot/production-daily-choice-head.json");
function decisionPath(root: string, count: number) {
  return count === 0 ? resolve(store(root), "policy.json") :
    resolve(store(root), "changes", String(count).padStart(6, "0") + ".json");
}
async function readHead(root: string) {
  const head = await sealed<DecisionHead>(headPath(root));
  if (head && (Object.keys(head).sort().join() !== "count,decision,tip" || !Number.isSafeInteger(head.count) || head.count < 0 || head.count > 999999 ||
      !head.decision || head.tip !== digest(head.decision) || (head.count === 0) !== ("method" in head.decision)))
    throw Error("Invalid independent subscriber choice anchor");
  return head;
}

/** Called under the publication lock. A committed head contains the complete last decision, even after a crash. */
async function restoreChoiceTail(root: string) {
  const head = await readHead(root);
  if (!head) return;
  const path = decisionPath(root, head.count);
  const prior = await sealed<Decision>(path);
  if (prior && digest(prior) !== head.tip) throw Error("The stored subscriber choice differs from its anchor");
  if (!prior) {
    await durableDirectory(dirname(path), 0o700);
    if (digest(await retain(path, head.decision)) !== head.tip)
      throw Error("The independently anchored subscriber choice could not be restored");
  }
}

async function recordChoice(root: string, count: number, decision: Decision) {
  if (count) await durableDirectory(resolve(store(root), "changes"), 0o700);
  const value = { count, tip: digest(decision), decision };
  // This atomic, separately located commitment is first. Recovery can complete only these exact bytes.
  await durableJSON(headPath(root), { value, sha256: digest(value) });
  await restoreChoiceTail(root);
}

const iso = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const permitted = (proof: KibotSubscriberProof, at: string) => ETF_SYMBOLS.every(symbol =>
  verifyKibotSubscriberProof(proof, at, symbol)) && Date.parse(at) - Date.parse(proof.capturedAt) <= 300_000;

export async function kibotPrimaryPolicy(root: string): Promise<PrimaryPolicy | null> {
  const head = await readHead(root);
  const p = await sealed<Registration>(resolve(store(root), "policy.json"));
  if (!p) {
    const files = await readdir(store(root)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (head || files.length) throw Error("Missing primary choice in an existing private subscriber workspace");
    return null;
  }
  const now = new Date().toISOString();
  if (Object.keys(p).sort().join() !== "authorization,commitment,method,registeredAt" || p.method !== method ||
      !iso(p.registeredAt) || p.registeredAt > now || !permitted(p.authorization, p.registeredAt) ||
      p.commitment !== await kibotCommitment(root, "0".repeat(64))) throw Error("Invalid pre-open Kibot source choice");
  const folder = resolve(store(root), "changes");
  const files = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!head || head.count !== files.length)
    throw Error("The surviving subscriber source choices differ from their anchored count");
  const changes: Choice[] = [];
  let prior = digest(p), lastAt = p.registeredAt;
  for (const [i, file] of files.sort().entries()) {
    if (file !== String(i + 1).padStart(6, "0") + ".json") throw Error("Gap in the Kibot source-choice history");
    const item = await sealed<{ prior: string; choice: Choice }>(resolve(folder, file));
    const c = item?.choice;
    if (!item || item.prior !== prior || !c || !iso(c.recordedAt) || c.recordedAt <= lastAt || c.recordedAt > now ||
        c.action !== (i % 2 ? "choose-primary" : "resume-default") ||
        (c.action === "choose-primary" ? Object.keys(c).sort().join() !== "action,authorization,recordedAt" ||
          !permitted(c.authorization, c.recordedAt) : Object.keys(c).sort().join() !== "action,recordedAt"))
      throw Error("Invalid dated Kibot source-choice history");
    prior = digest(item);
    lastAt = c.recordedAt;
    changes.push(c);
  }
  if (prior !== head.tip) throw Error("The surviving subscriber source choices differ from their anchored history");
  return { ...p, changes };
}

function sourceChoiceAt(policy: PrimaryPolicy, openAt: string) {
  if (policy.registeredAt >= openAt) return null;
  const change = policy.changes.filter(c => c.recordedAt < openAt).at(-1);
  if (change?.action === "resume-default") return null;
  return { method, commitment: policy.commitment, registeredAt: change?.recordedAt ?? policy.registeredAt,
    authorization: change?.authorization ?? policy.authorization };
}

/** These actions read no prices. Subscription verification and the source choice must both precede the target open. */
export async function registerKibotPrimary(root: string, action: Choice["action"] = "choose-primary") {
  await restoreChoiceTail(root);
  const policy = await kibotPrimaryPolicy(root);
  const active = !!policy && policy.changes.at(-1)?.action !== "resume-default";
  if ((action === "choose-primary") === active) return policy;
  const subscriber = action === "choose-primary" ? await authenticateKibotSubscriber(root) : null;
  const recordedAt = new Date().toISOString();
  if (policy && recordedAt <= (policy.changes.at(-1)?.recordedAt ?? policy.registeredAt))
    throw Error("Source-choice clock has not advanced beyond the previous decision");
  if (subscriber && !permitted(subscriber.proof, recordedAt))
    throw Error("Kibot did not confirm a paid package covering all five ETFs");
  if (!policy) {
    if (!subscriber) return null;
    await createKibotCommitment(root);
    const first: Registration = { method, registeredAt: recordedAt, commitment: await kibotCommitment(root, "0".repeat(64)),
      authorization: subscriber.proof };
    await recordChoice(root, 0, first);
  } else {
    const { changes, ...first } = policy;
    let prior = digest(first);
    for (const choice of changes) prior = digest({ prior, choice });
    const choice: Choice = subscriber ? { action: "choose-primary", recordedAt, authorization: subscriber.proof }
      : { action: "resume-default", recordedAt };
    await recordChoice(root, changes.length + 1, { prior, choice });
  }
  return kibotPrimaryPolicy(root);
}

function addDays(day: string, n: number) {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

export function ordinaryDailyTarget(issuedAt: string, horizon: Horizon) {
  if (horizon !== "daily") return null;
  const issuedDay = newYorkDate(issuedAt);
  if (issuedDay < EXCHANGE_CALENDAR.from || issuedDay > REVIEWED_EXCHANGE_THROUGH) return null;
  const limit = [addDays(issuedDay, 10), REVIEWED_EXCHANGE_THROUGH].sort()[0];
  const [day] = outcomeWindowSessions(issuedAt, horizon, exchangeSessions(issuedDay, limit));
  const session = day && exchangeSession(day);
  // Shortened days retain their pre-existing auction policy. No regular-day fallback is selected after prices arrive.
  return session && isFullKibotSession(session.openAt, session.closeAt) ? day : null;
}

export function kibotSelectedTarget(policy: PrimaryPolicy | null, issuedAt: string, horizon: Horizon) {
  if (!policy) return null;
  const day = ordinaryDailyTarget(issuedAt, horizon);
  return day && sourceChoiceAt(policy, exchangeSession(day)!.openAt) ? day : null;
}

/** Compare two native price bases and the independently delivered regular-session edges. */
export function kibotPrimaryPriceCheck(day: string, raw: PricePair, splits: PricePair, independent: PricePair) {
  const clock = exchangeSession(day);
  if (!clock || !isFullKibotSession(clock.openAt, clock.closeAt) ||
      [raw, splits, independent].some(bar => bar.session !== day ||
        ![bar.open, bar.close].every(value => Number.isFinite(value) && value > 0))) return false;
  if (raw.open !== splits.open || raw.close !== splits.close) return false;
  return Math.abs(raw.open / independent.open - 1) * 10_000 <= 3 &&
    Math.abs(raw.close / independent.close - 1) * 10_000 <= 15 &&
    Math.sign(raw.close - raw.open) === Math.sign(independent.close - independent.open);
}

export function kibotCashBoundary(amount: number, raw: PricePair, splits: PricePair, comparison: PricePair) {
  return Number.isFinite(amount) && amount > 0 && amount < raw.close &&
    kibotPrimaryPriceCheck(raw.session, raw, splits, comparison) &&
    Math.abs(raw.close - comparison.close) < amount / 2;
}

function dailyCalendar(day: string) {
  const from = [EXCHANGE_CALENDAR.from, addDays(day, -14)].sort().at(-1)!;
  const calendar = exchangeSessions(from, day).slice(-2);
  if (calendar.length !== 2) throw Error("The previous session is outside the reviewed exchange calendar");
  return calendar;
}

export function kibotOneDayEvidence(symbol: ETF, bar: SessionPrice): PriceEvidence {
  const calendar = dailyCalendar(bar.session);
  return { instrument: symbol, source: KIBOT_SUBSCRIBER_EOD_SOURCE, adjustment: OUTCOME_PRICE_BASIS,
    expectedSessions: calendar, sessions: [bar] };
}

async function verifySources(root: string, p: PrimaryPolicy, day: string, symbol: ETF, asOf: string,
  cachedOnly: boolean, signal?: AbortSignal, permittedDays?: ReadonlySet<string>) {
  const clock = exchangeSession(day);
  if (!clock || !isFullKibotSession(clock.openAt, clock.closeAt) ||
      !sourceChoiceAt(p, clock.openAt) || clock.closeAt >= asOf) throw Error("Session outside the pre-open source policy");
  const choice = sourceChoiceAt(p, clock.openAt)!;
  const directory = resolve(store(root), "prices");
  const fetcher: typeof fetch = (input, init) => fetch(input, { ...init,
    signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal });
  const options = { cachedOnly, reviewedExchangeCalendar: true, productionRoot: root, fetcher };
  if (!cachedOnly) await durableDirectory(directory, 0o700);
  const issuer = await kibotPostCloseIssuerActions(root, resolve(root, ".consensus/private-kibot/sources", day), symbol, day, undefined, !cachedOnly, true)
    .catch(() => { throw new SourceCheckFailed("issuer_original"); });
  if (!issuer.cashHistory || issuer.targetExDates.length > 1) throw new SourceCheckFailed("issuer_original");
  const cash = issuer.targetExDates[0];
  const days = cash ? dailyCalendar(day) : [day];
  if (permittedDays && days.some(date => !permittedDays.has(date)))
    throw Error("The ex-date check crosses an unapproved private research date");
  const allRaw = await collectResearchPrices(directory, symbol, days, options)
    .catch(() => { throw new SourceCheckFailed("subscriber_prices"); });
  const allSplit = await collectResearchPrices(directory, symbol, days, { ...options, splitAdjusted: true })
    .catch(() => { throw new SourceCheckFailed("subscriber_prices"); });
  const rows = allRaw.flatMap(receipt => receipt.sessions), splitRows = allSplit.flatMap(receipt => receipt.sessions);
  const cutoff = cachedOnly ? asOf : new Date().toISOString();
  if ([...allRaw, ...allSplit].some(row => !row.paid || row.paid.capturedAt > cutoff ||
      row.paid.authorization.capturedAt < choice.registeredAt) || issuer.capturedAt > cutoff)
    throw Error("Native authorization or issuer source falls outside the proof clock");
  const reference = await collectMarketHistoryFundReference(root, symbol, days, issuer.cashHistory, cachedOnly,
    { fetcher, signal, ...(cachedOnly ? { asOf } : {}) })
    .catch(() => { throw new SourceCheckFailed("independent_prices_or_actions"); });
  if (reference.prices.length !== days.length || rows.length !== days.length || splitRows.length !== days.length ||
      !kibotPrimaryPriceCheck(day, rows.at(-1)!, splitRows.at(-1)!, reference.prices.at(-1)!))
    throw new SourceCheckFailed("price_difference");
  if (cash && !kibotCashBoundary(cash.amount, rows[0], splitRows[0], reference.prices[0]))
    throw new SourceCheckFailed("ex_date_boundary");
  const proof = { controlDays: days, raw: digest(allRaw), splits: digest(allSplit), issuer: digest(issuer), comparison: reference.proof };
  return { proof, evidence: kibotOneDayEvidence(symbol, rows.at(-1)!) };
}

type Approval = { day: string; symbol: ETF; approvedAt: string; policy: string;
  proof: Awaited<ReturnType<typeof verifySources>>["proof"] };

async function readApproval(root: string, policy: PrimaryPolicy, day: string, symbol: ETF, asOf: string, permittedDays?: ReadonlySet<string>) {
  const path = resolve(store(root), "approvals", day + "-" + symbol + ".json");
  const approved = await sealed<Approval>(path);
  if (!approved) return null;
  if (Object.keys(approved).sort().join() !== "approvedAt,day,policy,proof,symbol" ||
      approved.policy !== digest(sourceChoiceAt(policy, exchangeSession(day)!.openAt)) || approved.day !== day || approved.symbol !== symbol ||
      !Number.isFinite(Date.parse(approved.approvedAt)) || new Date(approved.approvedAt).toISOString() !== approved.approvedAt)
    throw Error("Kibot primary approval identity changed");
  if (approved.approvedAt > asOf) return null;
  if (permittedDays && (approved.proof.controlDays.some(date => !permittedDays.has(date)) || !permittedDays.has(day))) return null;
  const checked = await verifySources(root, policy, day, symbol, approved.approvedAt, true, undefined, permittedDays);
  if (digest(checked.proof) !== digest(approved.proof)) throw Error("A primary source differs from its initial approved original");
  return { ...checked.evidence, approvedAt: approved.approvedAt };
}

/** Research must request an already-cleared fund/date. It never opens any sibling approval or embargoed ex-date leg. */
export async function readKibotPrimarySession(root: string, symbol: Instrument, day: string, asOf: string, permittedDays: ReadonlySet<string>) {
  if (symbol === "MARKET" || !ETF_SYMBOLS.includes(symbol) || !permittedDays.has(day) || !exchangeSession(day)) return null;
  const policy = await kibotPrimaryPolicy(root);
  return policy ? readApproval(root, policy, day, symbol, asOf, permittedDays) : null;
}

export async function readKibotPrimaryPrices(root: string, policy: PrimaryPolicy | null, asOf: string,
  warn: (message: string) => void = console.error) {
  if (!policy) return [];
  const dir = resolve(store(root), "approvals");
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const prices: (PriceEvidence & { approvedAt: string })[] = [];
  for (const name of names.sort()) {
    const parts = /^(\d{4}-\d\d-\d\d)-(SPY|QQQ|IWM|DIA|TLT)\.json$/.exec(name);
    if (!parts) continue;
    const [, day, fund] = parts;
    try {
      const evidence = await readApproval(root, policy, day, fund as ETF, asOf);
      if (evidence) prices.push(evidence);
    } catch { warn("Kibot primary approval failed offline replay for " + fund + " on " + day); }
  }
  return prices;
}

export async function prepareKibotPrimary(root: string) {
  await restoreChoiceTail(root);
  const policy = await kibotPrimaryPolicy(root);
  if (!policy) return { status: "not_selected" };
  try { await kibotSubscriberCredentials(root); }
  catch { return { status: "awaiting_owner_subscriber_credentials" }; }
  const now = new Date().toISOString();
  const days = exchangeSessions(newYorkDate(policy.registeredAt), newYorkDate(now)).filter(day => {
    const clock = exchangeSession(day)!;
    return !!sourceChoiceAt(policy, clock.openAt) && clock.closeAt < now && isFullKibotSession(clock.openAt, clock.closeAt);
  }).reverse();
  if (!days.length) return { status: "awaiting_completed_ordinary_session" };
  const approvals = resolve(store(root), "approvals");
  await durableDirectory(approvals, 0o700);
  const old = new Set(await readdir(approvals));
  const resume = resolve(store(root), "resume.json");
  const cursor = await readResearchReceipt<{ next: ETF; olderByFund: Partial<Record<ETF, string>> }>(resume);
  const start = cursor ? Math.max(0, ETF_SYMBOLS.indexOf(cursor.next)) : 0;
  const funds = [...ETF_SYMBOLS.slice(start), ...ETF_SYMBOLS.slice(0, start)];
  const olderByFund = { ...cursor?.olderByFund };
  const current: { symbol: ETF; day: string }[] = [], older: typeof current = [];
  for (const symbol of funds) {
    const missing = days.filter(day => !old.has(day + "-" + symbol + ".json"));
    if (!missing.length) continue;
    current.push({ day: missing[0], symbol });
    const past = missing.slice(1);
    if (past.length) older.push({ day: past.find(day => day < (olderByFund[symbol] ?? "")) ?? past[0], symbol });
  }
  const deadline = AbortSignal.timeout(110_000);
  const accepted: typeof current = [];
  const withheld: { day: string; symbol: ETF; reason: FailureReason }[] = [];
  for (const job of [...current, ...older]) {
    const { symbol, day } = job;
    if (deadline.aborted) break;
    if (older.includes(job)) olderByFund[symbol] = day;
    await durableJSON(resume, { next: ETF_SYMBOLS[(ETF_SYMBOLS.indexOf(symbol) + 1) % ETF_SYMBOLS.length], olderByFund });
    try {
      const checked = await verifySources(root, policy, day, symbol, now, false, deadline);
      deadline.throwIfAborted();
      const approvedAt = new Date().toISOString();
      const receipt = { day, symbol, approvedAt, policy: digest(sourceChoiceAt(policy, exchangeSession(day)!.openAt)), proof: checked.proof };
      await retain(resolve(approvals, day + "-" + symbol + ".json"), receipt);
      if (!await readApproval(root, policy, day, symbol, approvedAt)) throw Error("Cannot replay new approval");
      accepted.push(job);
    } catch (error) {
      const reason = deadline.aborted ? "deadline" : error instanceof SourceCheckFailed ? error.reason : "integrity";
      withheld.push({ ...job, reason });
    }
  }
  return { status: "completed", accepted, withheld, timedOut: deadline.aborted };
}
