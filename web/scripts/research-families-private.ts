import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock } from "../lib/publication-lock.ts";
import { positioning } from "../lib/consensus/collector.ts";
import { EXCHANGE_CALENDAR } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { newYorkDate } from "../lib/consensus/time.ts";

// Freeze this experiment before the first public forecast. Reuse its saved
// result on later calls instead of repeatedly inspecting the same test window.
const METHOD = "prelaunch-family-screen-v1";
if (process.argv.length !== 2) throw new Error("This fixed experiment accepts no overrides");
const contracts = { SPY: "13874A", QQQ: "209742", IWM: "239742", DIA: "124603", TLT: "020601" };
const root = fileURLToPath(new URL("../", import.meta.url));
const release = await acquirePublicationLock(root, "private-family-research");
try {
  const { snapshots } = await verifyPublicationTree(root);
  const cutoff = [...snapshots].map(snapshot => snapshot.issuedAt).sort()[0];
  const directory = resolve(root, ".consensus/private-family-research");
  const destination = resolve(directory, METHOD + ".json");
  let saved;
  try {
    saved = JSON.parse(await readFile(destination, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (saved) {
    if (saved.method !== METHOD || saved.beforeFirstPublicForecast !== cutoff)
      throw new Error("Saved family experiment differs from its frozen policy");
    console.log(JSON.stringify({ status: "reused-private-experiment", experiments: saved.experiments.length }));
  } else {
    const { evidence, hashes, through } = await collectKibotPrices(EXCHANGE_CALENDAR.from, cutoff);
    const positions = await positioning(fetch);
    const experiments = [];
    for (const prices of evidence) {
      const contract = contracts[prices.instrument as keyof typeof contracts];
      if (!contract) throw new Error("No approved related futures contract");
      const signal = positions.find(signal => signal.id === `cftc-${contract}-asset`);
      if (!signal || signal.status !== "available") throw new Error("CFTC source did not return a usable history");
      const technicalRows: TrainingRow[] = [];
      const institutionRows: TrainingRow[] = [];
      for (let i = 1; i < prices.sessions.length; i++) {
        const session = prices.sessions[i];
        const previous = prices.sessions[i - 1];
        if (session.closeAt >= cutoff || previous.closeAt >= session.openAt)
          throw new Error("Research window overlaps a published forecast or has unordered sessions");
        const row = {
          id: `${prices.instrument}:${session.session}`,
          engineVersion: METHOD, issuedAt: session.openAt, labelKnownAt: session.closeAt,
          up: (session.close > session.open ? 1 : 0) as 0 | 1,
        };
        // Same-session ratios cancel any common dividend/split adjustment factor.
        technicalRows.push({ ...row, features: [previous.close / previous.open - 1] });
        const knownBefore = new Date(Date.parse(newYorkDate(session.openAt)) - 7 * 86_400_000)
          .toISOString().slice(0, 10);
        const index = signal.series.findLastIndex(point => point.date <= knownBefore);
        if (index < 1) continue;
        const current = signal.series[index];
        const prior = signal.series[index - 1];
        // A fixed seven-day assumed delay is a historical experiment convention.
        // It does not establish actual publication or unrevised vintage dates.
        institutionRows.push({ ...row, id: row.id + ":" + current.date,
          features: [(current.value - prior.value) / 100] });
      }
      for (const [family, rows] of [["technicals", technicalRows], ["institutions", institutionRows]] as const) {
        const result = trainCandidate(rows, cutoff);
        experiments.push({ instrument: prices.instrument, family, result,
          distinctFeatureDates: family === "institutions"
            ? new Set(rows.map(row => row.id.split(":").at(-1))).size : rows.length });
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(destination, JSON.stringify({
      method: METHOD, createdAt: new Date().toISOString(), beforeFirstPublicForecast: cutoff,
      through, priceSource: evidence[0].source, priceHashes: hashes,
      positioningHashes: [...new Set(positions.map(signal => signal.source.sha256))],
      positioningSource: "https://publicreporting.cftc.gov/resource/gpe5-46if.json",
      limitations: [
        "Private historical discovery with latest-vintage observations.",
        "CFTC assumed availability is seven calendar days after the report date. Actual publication times and revisions are unverified.",
        "Weekly positioning repeats across daily labels. Daily rows are not independent weekly observations.",
        "Technicals test only yesterday's regular-session body against the next regular-session body.",
        "Separate per-family tests do not establish incremental value after existing families or causal effects.",
        "Private provider bars and derived results remain outside Git and public output.",
        "Historical model gates are distinct from the unchanged prospective activation requirements.",
      ],
      experiments,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: "saved-private-experiment", through,
      beforeFirstPublicForecast: cutoff, experiments: experiments.map(({ instrument, family, result, distinctFeatureDates }) =>
        ({ instrument, family, samples: result.samples, status: result.status, distinctFeatureDates })),
    }, null, 2));
  }
} finally {
  await release();
}
