import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { outcomeWindowSessions, selectScoredOutcomes } from "./evaluation.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions, REVIEWED_EXCHANGE_THROUGH } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { replayRecordedFund, type reviewedFund, type CloseProof } from "./kibot-after-close.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "./kibot.ts";
import { KIBOT_RESEARCH_SYMBOLS, type KibotResearch } from "./kibot-research.ts";
import { ETF_SYMBOLS } from "./marketparquet.ts";
import { dailySessionOutcomes } from "./outcome-coverage-audit.ts";
import { verifyPreopenReceipt } from "./preopen-receipt.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import type { Outcome, Snapshot } from "./types.ts";

type SessionReport = ReturnType<typeof dailySessionOutcomes>;
type Recorded = ReturnType<typeof reviewedFund> & {
  schemaVersion: 1; retrospective: boolean; recordedAt: string; archiveSha256: string; proofDigest: string;
};

/** Replay the private outcomes from the last publicly observed pre-open edition, including partial source delivery. */
export async function verifiedPrivateSession(root: string, snapshots: Snapshot[], day: string, engine: string, asOf: string): Promise<SessionReport> {
  const report = dailySessionOutcomes(snapshots, [], day, engine, { asOf, ledgerObservedAt: asOf });
  const directory = resolve(root, ".consensus/private-kibot/after-close", day);
  const recorded = await Promise.all(ETF_SYMBOLS.map(symbol => readResearchReceipt<Recorded>(resolve(directory, symbol + ".json"))));
  if (recorded.every(row => row === null || row.retrospective === true)) return report;

  const snapshot = snapshots.find(item => item.id === report.edition);
  const previous = exchangeSessions(EXCHANGE_CALENDAR.from, day).at(-2);
  if (!snapshot || !previous) throw new Error("No selected pre-open edition or prior exchange session for the private results");
  const archive = await readFile(resolve(root, "public/consensus", snapshot.id + ".json"));
  const pin = await verifyPreopenReceipt(root, day, snapshot.id, archive, asOf);
  const proofs = new Map<string, CloseProof>();
  for (const [index, record] of recorded.entries()) {
    if (!record || record.retrospective === true) continue;
    if (record.retrospective !== false || !/^[a-f0-9]{64}$/.test(record.proofDigest) || record.archiveSha256 !== pin.archiveSha256 ||
        !Number.isFinite(Date.parse(record.recordedAt)) || new Date(record.recordedAt).toISOString() !== record.recordedAt ||
        record.recordedAt < record.observedAt || record.recordedAt > asOf)
      throw new Error("Private outcome differs from its pre-open archive or observation time");
    let proof = proofs.get(record.proofDigest);
    if (!proof) {
      const saved = await readResearchReceipt<CloseProof>(resolve(directory, day + "-" + record.proofDigest + ".json"));
      if (!saved || digest(saved) !== record.proofDigest || saved.schemaVersion !== 1 || saved.purpose !== "owner-private-after-close-ETF-proof" ||
          saved.day !== day || saved.previous !== previous || saved.edition !== snapshot.id || saved.market?.session !== day ||
          saved.market.openAt !== report.openAt || saved.market.closeAt !== report.closeAt)
        throw new Error("Private outcome differs from its dated price and issuer proof");
      proof = saved;
      proofs.set(record.proofDigest, proof);
    }
    const symbol = ETF_SYMBOLS[index], source = proof.sources[symbol];
    if (!source || (source.sources.issuer.targetExDates.length > 0 && !record.cashBoundary))
      throw new Error("Missing private fund or issuer boundary evidence");
    const checked = await replayRecordedFund(root, symbol, source, day, previous, snapshot, asOf);
    if (digest(record) !== digest({ schemaVersion: 1, recordedAt: record.recordedAt, archiveSha256: pin.archiveSha256,
      proofDigest: record.proofDigest, retrospective: false, ...checked }))
      throw new Error("Private outcome differs from the as-issued call or reviewed prices");
    const fund = report.funds.find(item => item.instrument === symbol)!;
    fund.status = "resolved";
    fund.returnPct = checked.returnPct;
    fund.actualDirection = checked.returnPct > 0 ? "up" : checked.returnPct < 0 ? "down" : "flat";
    fund.directionCorrect = checked.directionCorrect;
  }
  if (report.funds.every(item => item.status === "resolved")) report.stage = "settled";
  report.eligibleOutcomes = report.funds.filter(item => item.status === "resolved" && item.inputEligible).length;
  return report;
}

/** Read the same verified settlement history for the public counts and the private family coverage report. */
export async function readPrivateResearchSessions(root: string, snapshots: Snapshot[], engine: string, asOf = new Date().toISOString()) {
  const ledger = JSON.parse(await readFile(resolve(root, ".consensus/private-kibot/evaluation.json"), "utf8"));
  const bulkThrough = typeof ledger.summary?.through === "string" ? ledger.summary.through : "";
  const lastSession = exchangeSession(bulkThrough);
  if (ledger.schemaVersion !== 2 || !lastSession || !Array.isArray(ledger.outcomes) ||
      !(lastSession.closeAt < ledger.evaluatedAt && ledger.evaluatedAt <= asOf))
    throw new Error("Private Kibot ledger must cover a completed, reviewed session");

  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const calendar = exchangeSessions(EXCHANGE_CALENDAR.from, REVIEWED_EXCHANGE_THROUGH);
  const fullSessions = (ledger.outcomes as Outcome[]).filter(row => {
    const snapshot = byId.get(row.snapshotId);
    const target = snapshot && outcomeWindowSessions(snapshot.issuedAt, "daily", calendar)[0];
    const clock = target && exchangeSession(target);
    if (!snapshot || !clock || target > bulkThrough || row.source !== KIBOT_PRICE_CITATION ||
        row.engineVersion !== snapshot.engineVersion || row.issuedAt !== snapshot.issuedAt ||
        !KIBOT_RESEARCH_SYMBOLS.includes(row.instrument as typeof KIBOT_RESEARCH_SYMBOLS[number]) ||
        row.horizon !== "daily" || row.entryAt !== clock.openAt || row.exitAt !== clock.closeAt ||
        typeof row.abstained !== "boolean")
      throw new Error("Private research outcome differs from the issued target or session clock");
    return isFullKibotSession(row.entryAt, row.exitAt);
  });
  const { selected } = selectScoredOutcomes(fullSessions);
  if (selected.length !== ledger.summary.selected)
    throw new Error("Private Kibot ledger differs from its selected session count");
  const dates = new Set(selected.map(row => row.entryAt.slice(0, 10)));
  const ledgerClock = { asOf: ledger.evaluatedAt, ledgerObservedAt: ledger.evaluatedAt };
  const sessions = [...dates].map(day =>
    dailySessionOutcomes(snapshots, selected.filter(row => row.entryAt.startsWith(day)), day, engine, ledgerClock));
  if (sessions.reduce((n, report) => n + report.funds.filter(row => row.status === "resolved").length, 0) !== selected.length)
    throw new Error("Private research ledger is missing the last issued edition for a settled ETF session");
  const directory = resolve(root, ".consensus/private-kibot/after-close");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      sessions.push(await verifiedPrivateSession(root, snapshots, entry.name, engine, asOf));
  }
  const checked = summarizePrivateSessions(sessions, bulkThrough);
  return { sessions, checked };
}

/** Count a checked fund/session once when the as-traded and adjusted files arrive at different times. */
export function summarizePrivateSessions(reports: SessionReport[], bulkThrough: string) {
  const settled = new Map<string, { session: string; edition: string; fund: SessionReport["funds"][number] }>();
  let through = bulkThrough;
  for (const report of reports) for (const fund of report.funds) {
    if (fund.status !== "resolved") continue;
    if (!report.edition) throw new Error("A resolved fund requires its pre-open edition");
    const key = report.session + ":" + fund.instrument;
    const prior = settled.get(key);
    if (prior && (prior.edition !== report.edition || prior.fund.asIssuedCall !== fund.asIssuedCall ||
        prior.fund.inputEligible !== fund.inputEligible || prior.fund.actualDirection !== fund.actualDirection))
      throw new Error(`Private price studies disagree for ${key}`);
    if (report.session > through) through = report.session;
    settled.set(key, { session: report.session, edition: report.edition, fund });
  }
  const daily = ETF_SYMBOLS.map(instrument => {
    const rows = [...settled.values()].filter(row => row.fund.instrument === instrument);
    return { instrument, sessions: rows.length, eligibleSessions: rows.filter(row => row.fund.inputEligible).length,
      calls: rows.filter(row => row.fund.asIssuedCall !== "withheld").length };
  });
  const identities = [...settled].map(([key, row]) => [key, row.edition, row.fund.asIssuedCall].join(":")).sort();
  const selections = [...settled.values()].map(({ session, edition, fund }) => ({
    session, edition, instrument: fund.instrument, inputEligible: fund.inputEligible,
  }));
  return { through, daily, selected: settled.size, identities, selections };
}

export type ResearchSessionReceipt = { aggregateSha256: string; identitiesSha256: string; identities: string[] };

export function verifyPreviousResearchSessions(previous: KibotResearch, receipt: ResearchSessionReceipt | null,
  reports: SessionReport[], current: ReturnType<typeof summarizePrivateSessions>) {
  const earlier = summarizePrivateSessions(reports.filter(report => report.session <= previous.through), previous.through);
  if (current.through < previous.through || earlier.daily.some((row, i) => row.sessions < previous.daily[i].sessions || row.calls < previous.daily[i].calls))
    throw new Error("Private evidence no longer accounts for the previously published research sessions");
  if (!receipt) return;
  const known = new Set(current.identities);
  if (receipt.aggregateSha256 !== digest(previous) || !Array.isArray(receipt.identities) ||
      digest(receipt.identities) !== receipt.identitiesSha256 || new Set(receipt.identities).size !== receipt.identities.length ||
      receipt.identities.length !== previous.daily.reduce((sum, fund) => sum + fund.sessions, 0) ||
      receipt.identities.some(key => !known.has(key)))
    throw new Error("A previously counted private fund and session could not be reproduced");
}
