import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { outcomeWindowSessions, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions, REVIEWED_EXCHANGE_THROUGH } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import {
  KIBOT_RESEARCH_FILE, KIBOT_RESEARCH_LICENSE, KIBOT_RESEARCH_STUDIES,
  KIBOT_RESEARCH_SYMBOLS, validateKibotResearch, type KibotResearch,
} from "../lib/consensus/kibot-research.ts";
import type { Outcome } from "../lib/consensus/types.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--publish"))
  throw new Error("Usage: stage-kibot-research.ts [--publish]");
const root = fileURLToPath(new URL("../", import.meta.url));
const path = resolve(root, "public/consensus", KIBOT_RESEARCH_FILE);
const lock = await acquirePublicationLock(root, "kibot-aggregate-research");
let failure: { error: unknown } | undefined;
try {
  const { history, snapshots } = await verifyPublicationTree(root);
  const ledger = JSON.parse(await readFile(resolve(root, ".consensus/private-kibot/evaluation.json"), "utf8"));
  const through = typeof ledger.summary?.through === "string" ? ledger.summary.through : "";
  const lastSession = exchangeSession(through);
  if (ledger.schemaVersion !== 2 || !lastSession || !Array.isArray(ledger.outcomes) ||
      !(lastSession.closeAt < ledger.evaluatedAt && ledger.evaluatedAt <= new Date().toISOString()))
    throw new Error("Private Kibot ledger must cover a completed, reviewed session");

  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const calendar = exchangeSessions(EXCHANGE_CALENDAR.from, REVIEWED_EXCHANGE_THROUGH);
  const fullSessions = (ledger.outcomes as Outcome[]).filter(row => {
    const snapshot = byId.get(row.snapshotId);
    const target = snapshot && outcomeWindowSessions(snapshot.issuedAt, "daily", calendar)[0];
    const clock = target && exchangeSession(target);
    if (!snapshot || !clock || target > through || row.source !== KIBOT_PRICE_CITATION ||
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
  const daily = KIBOT_RESEARCH_SYMBOLS.map(instrument => {
    const rows = selected.filter(row => row.instrument === instrument);
    return { instrument, sessions: rows.length, calls: rows.filter(row => !row.abstained).length };
  });

  const studyIds = new Set(KIBOT_RESEARCH_STUDIES.map(study => study.id));
  const reports = new Map(await Promise.all([...studyIds].map(async id => {
    const report = JSON.parse(await readFile(resolve(root, ".consensus/private-family-research", id + ".json"), "utf8"));
    if (report.method !== id || report.beforeFirstPublicForecast !== snapshots[0].issuedAt ||
        report.priceSource !== KIBOT_PRICE_CITATION) throw new Error("Saved research differs from the verified publication history");
    return [id, report] as const;
  })));
  const studies: KibotResearch["studies"] = KIBOT_RESEARCH_STUDIES.flatMap(study => {
    const report = reports.get(study.id);
    const rows = study.family === "rates"
      ? [{ instrument: "TLT", result: report.results }]
      : (report.experiments as { instrument: string; family?: string; result: typeof report.results }[])
        .filter(row => row.family === study.family || (study.family === "news" && row.family === undefined));
    return rows.map(({ instrument, result }) => {
      if (result.status !== "evaluated" || !(result.split?.testEnds < snapshots[0].issuedAt) ||
          typeof result.candidateBrier !== "number" || typeof result.baseRateBrier !== "number" ||
          result.coinBrier !== 0.25 || typeof result.promoted !== "boolean")
        throw new Error("Saved research requires completed prelaunch test results");
      return {
        family: study.family, instrument: instrument as typeof KIBOT_RESEARCH_SYMBOLS[number],
        samples: result.samples, testSamples: result.split.test,
        modelBrier: Number(result.candidateBrier.toFixed(4)),
        baseRateBrier: Number(result.baseRateBrier.toFixed(4)),
        clearedMargin: result.promoted,
      };
    });
  });
  const aggregate: KibotResearch = {
    schemaVersion: 1, source: KIBOT_RESEARCH_LICENSE, firstEdition: history[0].id, through, daily, studies,
  };
  validateKibotResearch(aggregate, history[0]);
  const next = JSON.stringify(aggregate, null, 2) + "\n";
  const prior = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  const changed = prior !== next;
  if (args[0] === "--publish" && changed) await durableJSON(path, aggregate);
  console.log(JSON.stringify({
    through, selected: selected.length, calls: daily.reduce((sum, row) => sum + row.calls, 0),
    studies: studies.length, cleared: studies.filter(row => row.clearedMargin).length,
    status: !changed ? "unchanged" : args[0] === "--publish" ? "staged" : "reviewed",
  }));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(lock, failure);
}
