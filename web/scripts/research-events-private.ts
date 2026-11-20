import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock } from "../lib/publication-lock.ts";
import { EXCHANGE_CALENDAR, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";

// Frozen before running. Reuse the saved result instead of inspecting the
// same prelaunch test window again with a revised feature.
const METHOD = "prelaunch-scheduled-events-v1";
if (process.argv.length !== 2) throw new Error("This fixed experiment accepts no overrides");
// Decision days of the scheduled 2026 meetings, read from the Federal Reserve
// calendar on 2026-11-11. The schedule is published before the year begins.
const FOMC_SOURCE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const FOMC_DECISIONS = new Set(["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29",
  "2026-09-16", "2026-10-28", "2026-12-09"]);

/** Standard monthly expiration: the third Friday, or the prior session when it is a holiday. */
function monthlyExpiration(year: number, month: number): string {
  const first = new Date(Date.UTC(year, month, 1));
  let day = new Date(Date.UTC(year, month, 1 + ((5 - first.getUTCDay() + 7) % 7) + 14));
  while (!exchangeSession(day.toISOString().slice(0, 10))) day = new Date(day.getTime() - 86_400_000);
  return day.toISOString().slice(0, 10);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const release = await acquirePublicationLock(root, "private-events-research");
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
      throw new Error("Saved events experiment differs from its frozen policy");
    console.log(JSON.stringify({ status: "reused-private-experiment", experiments: saved.experiments.length }));
  } else {
    const expirations = new Set(Array.from({ length: 12 }, (_, month) => monthlyExpiration(2026, month)));
    const { evidence, hashes, through } = await collectKibotPrices(EXCHANGE_CALENDAR.from, cutoff);
    const experiments = [];
    for (const prices of evidence) {
      const rows: TrainingRow[] = prices.sessions.map(session => {
        if (session.closeAt >= cutoff) throw new Error("Research window overlaps a published forecast");
        return {
          id: `${prices.instrument}:${session.session}`, engineVersion: METHOD,
          issuedAt: session.openAt, labelKnownAt: session.closeAt,
          // Both indicators are fixed by schedules known before the session opens.
          features: [FOMC_DECISIONS.has(session.session) ? 1 : 0, expirations.has(session.session) ? 1 : 0],
          // Same-session ratios cancel any common dividend or split adjustment factor.
          up: (session.close > session.open ? 1 : 0) as 0 | 1,
        };
      });
      const result = trainCandidate(rows, cutoff);
      const split = result.status === "evaluated" ? result.split : null;
      const inTest = (index: number) => split ? rows.filter(row => row.features[index] === 1 &&
        row.issuedAt >= split.testStarts && row.labelKnownAt <= split.testEnds).length : null;
      experiments.push({ instrument: prices.instrument, family: "events", result,
        eventSessions: { fomcDecision: rows.filter(row => row.features[0]).length,
          monthlyExpiration: rows.filter(row => row.features[1]).length },
        eventSessionsInTest: { fomcDecision: inTest(0), monthlyExpiration: inTest(1) } });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(destination, JSON.stringify({
      method: METHOD, createdAt: new Date().toISOString(), beforeFirstPublicForecast: cutoff,
      through, priceSource: evidence[0].source, priceHashes: hashes, eventSource: FOMC_SOURCE,
      features: ["scheduled FOMC decision day", "standard monthly options expiration session"],
      limitations: [
        "Private historical discovery on internal-use daily bars.",
        "Indicators mark scheduled dates only. They carry no probability, wording, volume or liquidity evidence.",
        "Seven decision days and ten expirations fall before the first public forecast, so the test window holds very few event sessions.",
        "Separate per-family tests do not establish incremental value after existing families or causal effects.",
        "Private provider bars and derived results remain outside Git and public output.",
        "Historical model gates are distinct from the unchanged prospective activation requirements.",
      ],
      experiments,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: "saved-private-experiment", through, beforeFirstPublicForecast: cutoff,
      experiments: experiments.map(({ instrument, result, eventSessions, eventSessionsInTest }) => ({
        instrument, samples: result.samples, status: result.status, eventSessions, eventSessionsInTest,
        ...(result.status === "evaluated" ? { promoted: result.promoted, candidateBrier: +result.candidateBrier.toFixed(4),
          baseRateBrier: +result.baseRateBrier.toFixed(4), coinBrier: result.coinBrier } : {}),
      })) }, null, 2));
  }
} finally {
  await release();
}
