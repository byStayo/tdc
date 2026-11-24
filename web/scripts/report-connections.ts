import { fileURLToPath } from "node:url";
import { asIssuedConsensus, versionedConsensus } from "../lib/consensus/as-issued.ts";
import { effectiveStatus as legacyStatus } from "../lib/consensus/engines/v1.ts";
import { effectiveStatus as currentStatus, ENGINE_VERSION } from "../lib/consensus/engines/v2.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import { renderConnectionChart } from "./render-connection-chart.ts";

const args = process.argv.slice(2);
const formats = args.filter(arg => arg.startsWith("--"));
const ids = args.filter(arg => !arg.startsWith("--"));
if (ids.length > 1 || formats.length > 1 || formats.some(arg => arg !== "--json" && arg !== "--html") ||
    (ids[0] && !/^[0-9TZ-]{20,30}$/.test(ids[0])))
  throw new Error("Usage: npm run consensus:connections -- [EDITION_ID] [--json | --html]");

const root = fileURLToPath(new URL("../", import.meta.url));
const { current, history, snapshots } = await verifyPublicationTree(root);
const snapshot = ids.length ? snapshots.find(item => item.id === ids[0]) : current;
if (!snapshot) throw new Error("Requested edition is absent from the verified archive");
const entry = history.find(item => item.id === snapshot.id)!;
const statusAt = snapshot.engineVersion === ENGINE_VERSION ? currentStatus : legacyStatus;

const signals = snapshot.signals.map(signal => ({
  id: signal.id,
  title: signal.title,
  family: signal.family,
  instruments: signal.instruments,
  status: statusAt(signal, snapshot.cutoff),
  providerLabel: signal.source.name === "Not connected" ? null : signal.source.name,
  source: signal.source,
  summary: signal.summary,
  limitation: signal.limitation,
  metrics: signal.metrics,
  historyPoints: signal.series.length,
}));
const sourceLabels = [...new Set(signals.map(signal => signal.providerLabel))].filter(label => label !== null).sort();
const sources = sourceLabels.map(label => ({
  label,
  signals: signals.filter(signal => signal.providerLabel === label).map(signal => signal.id),
}));

const views = INSTRUMENTS.flatMap(instrument => HORIZONS.map(horizon => {
  const consensus = asIssuedConsensus(snapshot, instrument, horizon);
  const scores = new Map<string, number>();
  for (const signal of snapshot.signals.filter(signal => signal.instruments.includes(instrument))) {
    // Evaluate a single source with the edition's own engine, including expiry and instrument restrictions.
    const single = versionedConsensus({ ...snapshot, signals: [signal] }, instrument, horizon);
    const score = single.families.find(family => family.id === signal.family)?.score;
    if (score != null) scores.set(signal.id, score);
  }
  const families = consensus.families.map(family => {
    const contributors = signals.filter(signal => signal.family === family.id && scores.has(signal.id))
      .map(signal => ({ signal: signal.id, score: scores.get(signal.id)! }));
    const mean = contributors.length ? contributors.reduce((sum, row) => sum + row.score, 0) / contributors.length : null;
    if ((mean === null) !== (family.score === null) ||
        (mean !== null && family.score !== null && Math.abs(mean - family.score) > 1e-12))
      throw new Error(`Source scores do not reproduce the archived ${instrument} ${horizon} ${family.id} vote`);
    return { ...family, contributors };
  });
  return { ...consensus, families };
}));

const byStatus = { available: 0, stale: 0, unavailable: 0, not_formed: 0 };
for (const signal of signals) byStatus[signal.status]++;
if (formats[0] === "--html") {
  console.log(renderConnectionChart(entry, snapshot, signals, sources, views));
} else if (formats[0] === "--json") {
  console.log(JSON.stringify({ edition: entry, cutoff: snapshot.cutoff, byStatus, sources, signals, views }, null, 2));
} else {
  console.log(`${entry.id} · Observations at ${snapshot.cutoff}`);
  console.log(`${signals.length} source records · ${byStatus.available} current · ${byStatus.stale} stale · ${byStatus.unavailable} unavailable · ${byStatus.not_formed} not formed\n`);
  console.log("| Instrument | Horizon | Observations | Family votes | Voting families |");
  console.log("| --- | --- | ---: | ---: | --- |");
  for (const view of views) {
    const voting = view.families.filter(family => family.score !== null);
    console.log(`| ${view.instrument} | ${view.horizon} | ${(100 * view.coverage).toFixed(1)}% | ${voting.length}/${view.families.length} | ${voting.map(family => family.label).join(", ") || "None"} |`);
  }
}
