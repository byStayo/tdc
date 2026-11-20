import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { adjustETFPrices, type CashDistribution } from "../lib/consensus/corporate-adjustment.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const METHOD = "prelaunch-technical-momentum-volatility-v1";
const FROM = "2022-01-01", THROUGH = "2026-11-02", ISSUER_CAPTURE = "2026-11-17";
const LONG_WINDOW = 20, SHORT_WINDOW = 5;
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-technical-momentum");
type ETF = typeof ETF_SYMBOLS[number];
type Issuer = { symbol: ETF; source: string; sha256: string; capturedAt: string; cash: CashDistribution[] };

export function technicalMomentumRows(symbol: ETF, prices: SessionPrice[], before: string): TrainingRow[] {
  const dates = extendedResearchSessions(prices[0].session, prices.at(-1)!.session);
  if (dates.length !== prices.length || prices.some((bar, i) => {
    const clock = extendedResearchSession(dates[i])!;
    return bar.session !== dates[i] || bar.openAt !== clock.openAt || bar.closeAt !== clock.closeAt ||
      bar.closeAt >= before || ![bar.open, bar.close].every(price => Number.isFinite(price) && price > 0);
  })) throw new Error("Technical study needs contiguous valid sessions entirely before the first edition");

  const logs = prices.map(row => Math.log(row.close));
  const full = prices.map(row => isFullKibotSession(row.openAt, row.closeAt));
  const rows: TrainingRow[] = [];
  for (let i = LONG_WINDOW + 1; i < prices.length; i++) {
    const start = i - LONG_WINDOW - 1;
    if (full.slice(start, i + 1).includes(false)) continue;
    const bar = prices[i], last = prices[i - 1];
    const priorLogs = logs.slice(start, i - 1);
    const squared = priorLogs.reduce((sum, close, j) => sum + (logs[start + j + 1] - close) ** 2, 0);
    const body = Math.log(last.close / last.open);
    const momentum = logs[i - 1] - logs[i - 1 - SHORT_WINDOW];
    const trend = logs[i - 1] - priorLogs.reduce((sum, close) => sum + close, 0) / LONG_WINDOW;
    const volatility = Math.sqrt(squared / LONG_WINDOW);
    rows.push({ id: `${symbol}:${bar.session}`, engineVersion: METHOD,
      issuedAt: newYorkTimestamp(bar.session.replaceAll("-", "") + "T080000")!, labelKnownAt: bar.closeAt,
      features: [body, momentum, trend, volatility], up: bar.close > bar.open ? 1 : 0 });
  }
  return rows;
}

async function run() {
  if (process.argv.length !== 2) throw new Error("This fixed prelaunch technical experiment accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-technical-momentum-study");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || before <= extendedResearchSession(THROUGH)!.closeAt)
      throw new Error("Technical research would overlap an issued forecast");
    const output = resolve(directory, METHOD + ".json");
    const saved = await readResearchReceipt<{ method: string; before: string; summary: unknown }>(output);
    if (saved) {
      if (saved.method !== METHOD || saved.before !== before) throw new Error("Saved technical study has a different archive boundary");
      console.log(JSON.stringify({ status: "reused", summary: saved.summary }));
      return;
    }

    const issuerInput = execFileSync("python3", ["-B", resolve(root, "scripts/collect-firstrate-inputs.py"),
      ISSUER_CAPTURE, "--cached-issuer-history-from", FROM], { encoding: "utf8", timeout: 15000, maxBuffer: 256000 });
    const { issuers } = JSON.parse(issuerInput) as { issuers: Issuer[] };
    const finalClose = extendedResearchSession(ISSUER_CAPTURE)!.closeAt;
    if (!Array.isArray(issuers) || issuers.length !== ETF_SYMBOLS.length || !ETF_SYMBOLS.every(symbol =>
      issuers.some(row => row.symbol === symbol && row.capturedAt > finalClose &&
        row.capturedAt <= new Date().toISOString() && /^[a-f0-9]{64}$/.test(row.sha256))))
      throw new Error("Historical cash histories need five original issuer captures taken after the reviewed close");

    await durableDirectory(directory, 0o700);
    const sessions = extendedResearchSessions(FROM, THROUGH);
    const cohorts = [];
    for (const symbol of ETF_SYMBOLS) {
      const raw = await collectResearchPrices(directory, symbol, sessions);
      const splits = await collectResearchPrices(directory, symbol, sessions, { splitAdjusted: true });
      const prices = raw.flatMap(receipt => receipt.sessions);
      const splitPrices = splits.flatMap(receipt => receipt.sessions);
      if (prices.length !== splitPrices.length || prices.some((row, i) =>
        row.session !== splitPrices[i].session || row.open !== splitPrices[i].open || row.close !== splitPrices[i].close))
        throw new Error(`${symbol} share basis differs from the split-only control`);
      const { cash, ...issuer } = issuers.find(row => row.symbol === symbol)!;
      const distributions = cash.filter(action => action.session >= sessions[0] && action.session <= THROUGH);
      const adjusted = adjustETFPrices(prices, distributions, []);
      const rows = technicalMomentumRows(symbol, adjusted, before);
      const reference = trainCandidate(rows.map(row => ({ ...row, features: [row.features[0]] })), before);
      const candidate = trainCandidate(rows, before);
      cohorts.push({ instrument: symbol, issuer, distributions: distributions.length, raw: raw.map(row => row.sha256),
        splitOnly: splits.map(row => row.sha256), adjustedDigest: digest(adjusted), reference, candidate });
    }
    const summary = { from: sessions[0], through: THROUGH, checkedSessions: sessions.length,
      cohorts: cohorts.map(({ instrument, distributions, candidate, reference }) => ({
        instrument, distributions, samples: candidate.samples, status: candidate.status,
        ...(candidate.status === "evaluated" && reference.status === "evaluated" ? {
          test: candidate.split.test, testStarts: candidate.split.testStarts, bodyBrier: reference.candidateBrier,
          candidateBrier: candidate.candidateBrier, baseBrier: candidate.baseRateBrier, coinBrier: candidate.coinBrier,
          clearsResearchMargin: candidate.promoted && candidate.candidateBrier < reference.candidateBrier - 0.01,
        } : {}),
      })) };
    await durableJSON(output, { method: METHOD, before, summary, cohorts,
      calendar: EXTENDED_CALENDAR_IDS, priceSource: KIBOT_PRICE_CITATION, issuerCapture: ISSUER_CAPTURE,
      policy: "Use the previous full-session body, five-session adjusted close momentum, adjusted close relative to the prior 20-close geometric mean, and RMS of 20 completed close-to-close log moves. Exclude any shortened session in the full lookback or target. Compare with the previous-session body alone, the training base rate and 50/50 on one fixed chronological split. This internal historical study uses retrospectively retrieved bars and issuer actions and is separate from the prospective holdout." }, true);
    console.log(JSON.stringify({ status: "saved", summary }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(unlock, failure); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
