import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { compareHoldingPeriods } from "../lib/consensus/holding-periods.ts";
import { collectKibotSeries, kibotHistorySource, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { kibotCashBoundary, kibotPrimaryPriceCheck } from "../lib/consensus/kibot-eod-primary.ts";
import { kibotPostCloseIssuerActions } from "../lib/consensus/kibot-session-witnesses.ts";
import { firstRateIssuerActionProof } from "../lib/consensus/market-history-actions.ts";
import { collectMarketHistoryPriceControls } from "../lib/consensus/market-history-price-controls.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { QUARTERLY_PRICE_FILE, validateQuarterlyPriceCheck } from "../lib/consensus/quarterly-price-check.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

// Last full quarter-end distribution month before the first forecast. The extra sessions
// supply September 1's preceding close and October 1's ex-date for the bond fund.
const root = fileURLToPath(new URL("../", import.meta.url));
const from = "2026-08-31", through = "2026-10-01", issuerVintage = "2026-11-23";
const dates = exchangeSessions(from, through);
const folder = resolve(root, ".consensus/private-quarterly-price-qualification/2026-09");
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !["--collect", "--stage"].includes(arg)))
  throw new Error("Usage: qualify-quarterly-etf-prices.ts [--collect | --stage]");
const collect = args[0] === "--collect";
type ETF = (typeof ETF_SYMBOLS)[number];
type Basis = "raw" | "splits";
type NativePrices = { source: string; receivedAt: string; csv: string; sha256: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const selection = await readFile(resolve(root, "scripts/quarterly-etf-price-policy.json"), "utf8");
if (hash(selection) !== "1d234ee9330e9671c99a1d2c397f4965a555e7425aced4b78e9fe7524c63b418")
  throw new Error("The dated, pre-collection comparison plan has changed");
const selectedAt = Date.parse(JSON.parse(selection).chosenAt);

async function kibotOriginal(symbol: ETF, basis: Basis) {
  const file = resolve(folder, symbol + "-" + basis + ".json");
  const source = kibotHistorySource(symbol, from, through, basis);
  let saved = await readResearchReceipt<NativePrices>(file);
  if (!saved && collect) {
    let csv = "";
    const response = await collectKibotSeries(symbol, dates, { unadjusted: basis === "raw", splitAdjusted: basis === "splits",
      onVerifiedResponse: body => { csv = body; } });
    if (!csv || hash(csv) !== response.sha256) throw new Error("Kibot response differs from its checked original");
    const capture = { source, receivedAt: new Date().toISOString(), sha256: response.sha256, csv };
    try { await durableJSON(file, capture, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    saved = await readResearchReceipt<NativePrices>(file);
  }
  if (!saved || saved.source !== source || typeof saved.csv !== "string" || hash(saved.csv) !== saved.sha256 ||
      new Date(saved.receivedAt).toISOString() !== saved.receivedAt || saved.receivedAt <= exchangeSession(through)!.closeAt ||
      Date.parse(saved.receivedAt) <= selectedAt || Date.parse(saved.receivedAt) > Date.now())
    throw new Error("Missing or invalid " + symbol + " " + basis + " original");
  return { sha256: saved.sha256, sessions: parseKibotDaily(saved.csv, dates) };
}

async function checkFund(symbol: ETF) {
  const issuer = await kibotPostCloseIssuerActions(root, resolve(root, ".consensus/private-kibot/sources", issuerVintage),
    symbol, issuerVintage, undefined, false, true);
  if (!issuer.cashHistory || Date.parse(issuer.capturedAt) > Date.now()) throw new Error("Missing original issuer cash history");
  const cash = issuer.cashHistory.filter(action => action.session >= from && action.session <= through);
  const [raw, splits] = [await kibotOriginal(symbol, "raw"), await kibotOriginal(symbol, "splits")];
  const control = await collectMarketHistoryPriceControls(root, symbol, dates, !collect);
  const actions = await firstRateIssuerActionProof(root, symbol, from, through, cash, !collect);
  const independent = control.raw[0].sessions, independentSplits = control.splits[0].sessions;
  const differences = dates.flatMap((day, i) => {
    const vendor = raw.sessions[i], ref = independent[i], otherBasis = independentSplits[i];
    const reasons = [];
    if (vendor.open !== splits.sessions[i].open || vendor.close !== splits.sessions[i].close) reasons.push("Kibot split basis");
    if (ref.open !== otherBasis.open || ref.close !== otherBasis.close) reasons.push("Market History split basis");
    if (Math.abs(vendor.open / ref.open - 1) * 10_000 > 3) reasons.push("open");
    if (Math.abs(vendor.close / ref.close - 1) * 10_000 > 15) reasons.push("close");
    if (Math.sign(vendor.close - vendor.open) !== Math.sign(ref.close - ref.open)) reasons.push("daily direction");
    const passed = kibotPrimaryPriceCheck(day, vendor, splits.sessions[i], ref) &&
      ref.session === otherBasis.session && ref.open === otherBasis.open && ref.close === otherBasis.close;
    if (passed !== (reasons.length === 0)) throw new Error("Daily diagnostics differ from the production price check");
    return passed ? [] : [{ day, reasons }];
  });
  const cashChecks = cash.map(({ session, amount }) => {
    const previous = dates.indexOf(session) - 1;
    return { session, verified: previous >= 0 && kibotCashBoundary(amount, raw.sessions[previous],
      splits.sessions[previous], independent[previous]) && !differences.some(d => d.day === dates[previous]) };
  });
  const holding = compareHoldingPeriods(dates, raw.sessions, independent, cash).map(window => {
    const crossing = cashChecks.filter(action => action.session > window.from && action.session <= window.through);
    const sameDirection = window.vendorDirection === window.referenceDirection;
    const priceDifference = differences.some(row => row.day >= window.from && row.day <= window.through);
    return { horizon: window.horizon, from: window.from, through: window.through, sameDirection,
      exDates: crossing.map(action => action.session), cashBasisVerified: window.cashBasisVerified,
      qualified: sameDirection && window.cashBasisVerified && !priceDifference && crossing.every(action => action.verified) };
  });
  const counts = (horizon: "weekly" | "monthly") => {
    const rows = holding.filter(window => window.horizon === horizon);
    return { total: rows.length, agreeingDirections: rows.filter(window => window.sameDirection).length,
      passingAllChecks: rows.filter(window => window.qualified).length };
  };
  return { symbol, sessions: dates.length, dailyPassing: dates.length - differences.length, differences, cashChecks,
    weekly: counts("weekly"), monthly: counts("monthly"), holding,
    sources: { kibotRaw: raw.sha256, kibotSplits: splits.sha256, hourly: control.proof,
      issuer: { sha256: issuer.sha256, capturedAt: issuer.capturedAt }, actions } };
}

if (collect) await durableDirectory(folder, 0o700);
const funds = [];
for (const symbol of ETF_SYMBOLS) funds.push(await checkFund(symbol));
const report = { method: "quarterly-etf-price-qualification-v1", scope: "private historical price qualification",
  from, through, issuerVintage, funds };
const reportFile = resolve(folder, "report.json");
let saved = await readResearchReceipt<typeof report>(reportFile);
if (!saved && collect) {
  try { await durableJSON(reportFile, report, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  saved = await readResearchReceipt<typeof report>(reportFile);
}
if (!saved || digest(saved) !== digest(report)) throw new Error("The private source replay needs its matching original report");
const independent: unknown = JSON.parse(execFileSync("python3", ["-E", "-B", "scripts/verify-quarterly-etf-prices.py"],
  { cwd: root, encoding: "utf8", timeout: 60_000 }));
const aggregate: unknown = { method: report.method, from, through, funds: independent };
validateQuarterlyPriceCheck(aggregate);
for (const [i, row] of aggregate.funds.entries()) {
  const checked = funds[i];
  if (row.daily.passed !== checked.dailyPassing || row.daily.checked !== checked.sessions ||
      row.dividends.checked !== checked.cashChecks.length || row.dividends.passed !== checked.cashChecks.filter(c => c.verified).length)
    throw new Error("Independent daily or dividend count differs for " + row.symbol);
  for (const horizon of ["weekly", "monthly"] as const) {
    const original = checked[horizon];
    const crossing = checked.holding.filter(w => w.horizon === horizon && w.exDates.length > 0).length;
    if (row[horizon].checked !== original.total || row[horizon].passed !== original.passingAllChecks || row[horizon].withDividend !== crossing)
      throw new Error("Independent holding-period count differs for " + row.symbol);
  }
}
if (args[0] === "--stage") {
  const release = await acquirePublicationLock(root, "quarterly-etf-price-comparison");
  let failure;
  try {
    const file = resolve(root, "public" + QUARTERLY_PRICE_FILE);
    try { await durableJSON(file, aggregate, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const existing: unknown = JSON.parse(await readFile(file, "utf8"));
    validateQuarterlyPriceCheck(existing);
    if (digest(existing) !== digest(aggregate)) throw new Error("The published price comparison differs from the native replay");
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}
console.log(JSON.stringify({ scope: report.scope, reportSha256: digest(report), comparison: aggregate }));
