import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicText } from "../lib/consensus/collector.ts";
import { adjustETFPrices } from "../lib/consensus/corporate-adjustment.ts";
import { evaluateOutcome, outcomeTrainingRow, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { exchangeSessions, exchangeSession, hasReviewedCalendar } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { planCandidate } from "../lib/consensus/learning.ts";
import { MINIMUM_TEST_LABELS, PROSPECTIVE_MINIMUM, readReservations } from "../lib/consensus/learning-audit.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { ENGINE_VERSION } from "../lib/consensus/registry.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import type { Outcome } from "../lib/consensus/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const now = new Date().toISOString();
const source = "https://www.dolthub.com/repositories/post-no-preference/stocks";
const endpoint = "https://www.dolthub.com/api/v1alpha1/post-no-preference/stocks/master";
const licenseHash = "23ee78c8bae49cf08ea2f0c84945c66b987ebe4520881fb51b3dad4fb43d07c2";
const instruments = INSTRUMENTS.filter(symbol => symbol !== "MARKET");

async function query(sql: string) {
  const url = new URL(endpoint);
  url.searchParams.set("q", sql);
  const { text, sha256, retrievedAt } = await publicText(url.href);
  const parsed = JSON.parse(text);
  if (parsed.query_execution_status !== "Success" || parsed.repository_owner !== "post-no-preference" ||
      parsed.repository_name !== "stocks" || !Array.isArray(parsed.rows))
    throw new Error("DoltHub price candidate query unavailable or invalid");
  return { rows: parsed.rows as Record<string, unknown>[], sha256, retrievedAt };
}

function decimal(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0)
    throw new Error("Invalid DoltHub price or action amount");
  return Number(value);
}

const { snapshots } = await verifyPublicationTree(root);
const reservations = await readReservations(root);
const snapshotById = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
const collection = await query("SELECT commit_hash,date,message FROM dolt_log LIMIT 48");
const revision = collection.rows[0]?.commit_hash;
if (typeof revision !== "string" || !/^[0-9a-v]{32}$/.test(revision)) throw new Error("Unverified DoltHub revision");
const checkpoint = (table: string) => {
  const pattern = new RegExp("^" + table + " (\\d{4}-\\d{2}-\\d{2}) update$");
  for (const entry of collection.rows) {
    const match = pattern.exec(String(entry.message));
    if (match && hasReviewedCalendar(match[1])) return match[1];
  }
  throw new Error("Missing recent DoltHub update checkpoint for " + table);
};
const cutoffs = { prices: checkpoint("ohlcv"), dividends: checkpoint("dividend"), splits: checkpoint("split") };
const today = newYorkDate(now);
const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
const to = [yesterday, ...Object.values(cutoffs)].sort()[0];
const lookback = new Date(Date.parse(yesterday) - 45 * 86400000).toISOString().slice(0, 10);
const firstIssue = newYorkDate(snapshots[0].issuedAt);
const firstProbe = "2026-10-30";
const from = [lookback, firstProbe < firstIssue ? firstProbe : firstIssue].sort().at(-1)!;
const expectedSessions = exchangeSessions(from, to);
const through = expectedSessions.at(-1);
if (!through) throw new Error("No completed DoltHub sessions with corporate-action coverage");

const symbols = "(" + instruments.map(symbol => "'" + symbol + "'").join(",") + ")";
const filter = " AND act_symbol IN " + symbols;
const table = (name: string) => name + " AS OF '" + revision + "'";
const range = (column: string) => column + " BETWEEN '" + from + "' AND '" + through + "'" + filter;
const reads = await Promise.allSettled([
  query("SELECT doc_name,SHA2(doc_text,256) AS sha256 FROM " + table("dolt_docs") + " WHERE doc_name = 'LICENSE.md'"),
  query("SELECT date,act_symbol,open,close FROM " + table("ohlcv") + " WHERE date IN (" +
    expectedSessions.map(date => "'" + date + "'").join(",") + ")" + filter + " LIMIT 250"),
  query("SELECT act_symbol,ex_date,amount FROM " + table("dividend") + " WHERE " + range("ex_date") + " LIMIT 100"),
  query("SELECT act_symbol,ex_date,to_factor,for_factor FROM " + table("split") + " WHERE " + range("ex_date") + " LIMIT 100"),
]);
const [license, bars, dividends, splits] = reads.map(read => {
  if (read.status === "rejected") throw read.reason;
  return read.value;
});
if (license.rows.length !== 1 || license.rows[0].sha256 !== licenseHash)
  throw new Error("DoltHub database license changed or could not be verified");
if (bars.rows.length !== expectedSessions.length * instruments.length || dividends.rows.length >= 100 || splits.rows.length >= 100)
  throw new Error("Missing or truncated DoltHub prices/actions");

let verifiedTLTDistribution = false;
const outcomes: Outcome[] = [];
for (const instrument of instruments) {
  const raw = bars.rows.filter(row => row.act_symbol === instrument).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (raw.length !== expectedSessions.length || raw.some((row, index) => row.date !== expectedSessions[index]))
    throw new Error("DoltHub prices differ from the reviewed exchange calendar for " + instrument);
  const sessions = raw.map(row => ({ ...exchangeSession(String(row.date))!, open: decimal(row.open), close: decimal(row.close) }));
  const cash = dividends.rows.filter(row => row.act_symbol === instrument)
    .map(row => ({ session: String(row.ex_date), amount: decimal(row.amount) }));
  const ratios = splits.rows.filter(row => row.act_symbol === instrument)
    .map(row => ({ session: String(row.ex_date), ratio: decimal(row.to_factor) / decimal(row.for_factor) }));
  const adjusted = adjustETFPrices(sessions, cash, ratios);
  if (instrument === "TLT" && from <= firstProbe && through >= "2026-11-02") {
    const event = cash.find(row => row.session === "2026-11-02");
    const prior = sessions.findIndex(row => row.session === firstProbe);
    // iShares publishes $0.343177. Dolt stores amounts at five decimal places.
    if (!event || Math.abs(event.amount - 0.343177) >= 0.00001 || prior < 0 ||
        !(adjusted[prior].open < sessions[prior].open && adjusted[prior].close < sessions[prior].close))
      throw new Error("DoltHub failed the issuer-confirmed TLT distribution check");
    verifiedTLTDistribution = true;
  }
  const evidence = { instrument, source, adjustment: OUTCOME_PRICE_BASIS, sessions: adjusted, expectedSessions };
  for (const snapshot of snapshots)
    for (const horizon of HORIZONS) {
      const outcome = evaluateOutcome(snapshot, evidence, horizon, now);
      if (outcome) outcomes.push(outcome);
    }
}
const selected = selectScoredOutcomes(outcomes).selected;
const cohorts = instruments.flatMap(instrument => HORIZONS.map(horizon => {
  const rows = selected.filter(row => row.instrument === instrument && row.horizon === horizon && row.engineVersion === ENGINE_VERSION)
    .map(row => outcomeTrainingRow(row, snapshotById.get(row.snapshotId)!));
  const consumedThrough = reservations.filter(record => record.instrument === instrument && record.horizon === horizon)
    .sort((a, b) => b.attempt - a.attempt)[0]?.consumedThrough;
  const plan = planCandidate(rows, now, {
    engineVersion: ENGINE_VERSION, consumedThrough, minimumSamples: PROSPECTIVE_MINIMUM,
    minimumTestSamples: MINIMUM_TEST_LABELS, nonOverlappingTest: true,
  });
  return { instrument, horizon, status: plan.status, samples: plan.samples };
}));
const summary = {
  source, revision, cutoffs, through, verifiedTLTDistribution, symbols: instruments.length,
  sessionsPerSymbol: expectedSessions.length, resolved: outcomes.length, selected: selected.length,
  eligible: cohorts.filter(cohort => cohort.status === "ready").length, trained: 0,
};
const directory = resolve(root, ".consensus/private-dolthub");
await mkdir(directory, { recursive: true, mode: 0o700 });
const temporary = resolve(directory, randomUUID() + ".tmp");
try {
  await writeFile(temporary, JSON.stringify({
    collectedAt: now, from, summary, cohorts, outcomes,
    evidence: { collection, license, bars, dividends, splits },
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, resolve(directory, "research.json"));
} finally { await unlink(temporary).catch(() => undefined); }
console.log(JSON.stringify(summary));
