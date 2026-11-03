import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ecbPoints } from "../lib/consensus/collector.ts";
import { rsi, realizedVolatility, sma } from "../lib/indicators.ts";
import { trainCandidate } from "../lib/consensus/learning.ts";
import { SESSION_HORIZONS } from "../lib/consensus/evaluation.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
import type { Horizon } from "../lib/consensus/types.ts";

// This is explicitly a latest-vintage historical experiment, never backdated as-issued performance.
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  at = new Date().toISOString();
const xml = await readFile(resolve(root, ".consensus/ecb-history.xml"), "utf8"),
  sourceHash = createHash("sha256").update(xml).digest("hex");
if (Buffer.byteLength(xml) > 25_000_000)
  throw new Error("Historical source exceeds bound");
const rates = ecbPoints(xml),
  usd = rates.get("USD");
if (!usd?.length) throw new Error("Missing official ECB USD observations");
const source = {
  name: "European Central Bank",
  url: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml",
  sha256: sourceHash,
  retrievedAt: at,
  attribution:
    "Source: ECB. Cross rates, features, outcomes and models calculated by The Daily Consensus.",
};
const experiments = [];
await mkdir(resolve(root, ".consensus/experiments"), { recursive: true });
for (const currency of ["EUR", "JPY", "GBP"]) {
  const input =
    currency === "EUR"
      ? usd.map((point) => ({ ...point, value: 1 }))
      : (rates.get(currency) ?? []);
  const map = new Map(usd.map((point) => [point.date, point.value]));
  const points = input
    .flatMap((point) => {
      const dollar = map.get(point.date);
      return dollar && point.date <= at.slice(0, 10)
        ? [{ date: point.date, value: dollar / point.value }]
        : [];
    })
    .slice(-3000);
  const closes = points.map((point) => point.value);
  for (const [horizon, count] of Object.entries(SESSION_HORIZONS) as [
    Horizon,
    number,
  ][]) {
    const rows: TrainingRow[] = [];
    for (let i = 60; i + 1 + count < points.length; i++) {
      const known = closes.slice(Math.max(0, i - 250), i + 1),
        latest = known.at(-1)!;
      // Inputs end on fix i. Issue at next UTC midnight, entry at the following fix, exit N fixes later.
      const issuedAt = new Date(
        Date.parse(`${points[i].date}T00:00:00Z`) + 86400000,
      ).toISOString();
      const exit = points[i + 1 + count],
        entry = points[i + 1];
      const features = [
        latest / known.at(-6)! - 1,
        latest / known.at(-21)! - 1,
        (rsi(known) ?? 50) / 100 - 0.5,
        (realizedVolatility(known) ?? 0) / 100,
        latest / sma(known, 50)! - 1,
      ];
      rows.push({
        id: `${currency}:${horizon}:${points[i].date}`,
        issuedAt,
        labelKnownAt: `${exit.date}T23:59:59.000Z`,
        features,
        up: exit.value > entry.value ? 1 : 0,
      });
    }
    const result = trainCandidate(rows, at);
    const id = `ecb-${currency}-${horizon}-${result.datasetHash.slice(0, 16)}`;
    const artifact = {
      id,
      kind: "historical_reconstruction",
      asIssued: false,
      instrument: `${currency}/USD`,
      horizon,
      source,
      training: result,
      activated: false,
      featureSchema: [
        "5-fix momentum",
        "20-fix momentum",
        "Wilder RSI-14",
        "20-fix realized volatility",
        "distance from 50-fix average",
      ],
      limitations: [
        "Latest-vintage reference rates, not a real-time archived data vintage.",
        "Reference fixes are not executable transaction prices. No trading-profit claim.",
        "This is currency-only research and does not validate an equity, options or social model.",
        "One declared candidate selection using validation, followed by an untouched chronological test. No feature search against this test.",
        "Historical success would require prospective shadow evaluation before activation.",
      ],
    };
    await writeFile(
      resolve(root, ".consensus/experiments", `${id}.json`),
      JSON.stringify(artifact, null, 2),
      { flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    experiments.push({
      id,
      instrument: artifact.instrument,
      horizon,
      samples: result.samples,
      status: result.status,
      baselineBeaten: result.promoted,
      activated: false,
      ...(result.status === "evaluated"
        ? {
            testSamples: result.split.test,
            candidateBrier: result.candidateBrier,
            baseRateBrier: result.baseRateBrier,
            coinBrier: result.coinBrier,
            calibration: result.calibration,
            split: result.split,
          }
        : {}),
      reason: result.reason,
    });
    console.log(
      JSON.stringify({
        instrument: artifact.instrument,
        horizon,
        status: result.status,
        samples: result.samples,
        baselineBeaten: result.promoted,
      }),
    );
  }
}
await writeFile(
  resolve(root, "lib/consensus/experiments.json"),
  `${JSON.stringify({ evaluatedAt: at, source, kind: "historical_reconstruction", asIssued: false, activated: false, experiments, note: "Historical currency research using ECB reference fixes. These are not as-issued predictions, executable-price returns or evidence of equity-model accuracy. No candidate is activated by this experiment." }, null, 2)}\n`,
);
