import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import type { CashDistribution } from "../lib/consensus/corporate-adjustment.ts";
import { isFullKibotSession } from "../lib/consensus/kibot.ts";
import { brierScore, fitLogisticModel, planCandidate, predict, type LogisticModel, type TrainingRow } from "../lib/consensus/learning.ts";
import { closeMomentum, coreSessionCloses, parseMarketHistoryHours, reconcileCoreCloses,
  type MarketHistoryCapture } from "../lib/consensus/market-history-closes.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { historicalResearchSession, historicalResearchSessions, HISTORICAL_RESEARCH_CALENDAR } from "../lib/consensus/research-session-calendar.ts";
import { roundTltCloseChange, TLT_CLOSE_STALE_DAYS } from "../lib/consensus/tlt-close-signal.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-market-history");
const method = "prelaunch-tlt-close-indicator-2025-v2";
const path = resolve(directory, method + ".json");
const specPath = resolve(directory, method + ".spec.json");
const dayMs = 86_400_000;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const protocol = {
  method, instrument: "TLT", year: 2025, cutoffNewYork: "07:48",
  features: ["one-session issuer-adjusted close change percent",
    "five-session issuer-adjusted close change percent", "twenty-session issuer-adjusted close change percent"],
  rounding: "Number(value.toFixed(1)) || 0",
  sourceAvailability: "First 03:00 UTC refresh strictly after 48 hours from the observed session's 20:00 New York extended close.",
  maximumSourceAgeDays: TLT_CLOSE_STALE_DAYS,
  validationStarts: "2025-08-18T11:48:00.000Z", testStarts: "2025-10-08T11:48:00.000Z",
  selection: "Latest source session available strictly before the target cutoff, then exclude an incomplete or shortened 21-close window.",
  target: "Positive as-traded full-session close/open change on the cutoff's scheduled core session.",
  reference: "Immediately previous full-session as-traded log(close/open), evaluated on the same target observations.",
  exclusions: "Exclude stale readings under the live five-day rule. Exclude any shortened session in the source lookback, previous-body session, or target. Preserve missing exchange sessions.",
  minimumSamples: 120, split: "Existing chronological 60/20/20 split, purged by actual label-known time.",
  regularization: 1, iterations: 600, learningRate: 0.08,
  validationUse: "Report the fixed chronological split without parameter selection.",
  margin: "Candidate test Brier must beat previous-body, training-base-rate and 50/50 by at least 0.01.",
};
type Observation = {
  row: TrainingRow; sourceSession: string; sourceCloseAt: string; scheduledAvailableAt: string;
  lookbackFrom: string; referenceSession: string; referenceBody: number;
};
const digest = (value: unknown) => sha256(JSON.stringify(value));
function sourceAvailableAt(session: string) {
  const extendedClose = newYorkTimestamp(session.replaceAll("-", "") + "T200000")!;
  const earliest = Date.parse(extendedClose) + 2 * dayMs;
  const nightly = Math.floor(earliest / dayMs) * dayMs + 3 * 3_600_000;
  return new Date(nightly <= earliest ? nightly + dayMs : nightly).toISOString();
}

async function run() {
  if (process.argv.length !== 2) throw new Error("This fixed retrospective screen accepts no overrides");
  const release = await acquirePublicationLock(directory, method);
  let failure: { error: unknown } | undefined;
  try {
    // The index supplies the archive boundary without reading prospective outcomes.
    const index = JSON.parse(await readFile(resolve(root, "public/consensus/index.json"), "utf8")) as { issuedAt: string }[];
    const before = index.reduce<string | undefined>((first, entry) => !first || first > entry.issuedAt ? entry.issuedAt : first, undefined);
    if (!before || !Number.isFinite(Date.parse(before)) || before <= "2025-12-31T23:59:59.999Z")
      throw new Error("The fixed historical year must precede the first public forecast");
    const protocolSha256 = digest(protocol);
    const savedSpec = await readResearchReceipt<{ protocolSha256: string }>(specPath);
    if (savedSpec && savedSpec.protocolSha256 !== protocolSha256)
      throw new Error("The prespecified screen protocol has changed");
    if (!savedSpec) await durableJSON(specPath, {
      protocol, protocolSha256, frozenAt: new Date().toISOString(),
      scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    }, true);

    const dates = historicalResearchSessions(2025);
    const clocks = dates.map(day => historicalResearchSession(day)!);
    const originalPath = resolve(directory, "TLT-2025-1h.json");
    const original = await readResearchReceipt<MarketHistoryCapture>(originalPath);
    if (!original) throw new Error("The verified original hourly receipt is required");
    const hours = parseMarketHistoryHours(original, "TLT");
    const core = coreSessionCloses(hours, clocks, original.through);
    const controlDirectory = resolve(root, ".consensus/private-technical-momentum");
    const raw = (await collectResearchPrices(controlDirectory, "TLT", dates, { cachedOnly: true }))[0];
    const splits = (await collectResearchPrices(controlDirectory, "TLT", dates, { cachedOnly: true, splitAdjusted: true }))[0];
    const reconciliation = reconcileCoreCloses(core.closes, raw.sessions, splits.sessions);
    if (core.missingSessions.length || !reconciliation.qualified ||
        raw.sessions.some((bar, i) => bar.open !== splits.sessions[i].open || bar.close !== splits.sessions[i].close))
      throw new Error("The historical source and independent share-basis controls must reconcile");

    const issuerFolder = resolve(root, ".consensus/private-firstrate/captures/2026-11-17");
    const issuerMetadata = await readResearchReceipt<{ symbol: string; sha256: string; url: string; capturedAt: string }>(
      resolve(issuerFolder, "issuer-TLT.json"));
    const issuerOriginal = await readFile(resolve(issuerFolder, "issuer-TLT.bin"));
    if (!issuerMetadata || issuerMetadata.symbol !== "TLT" || sha256(issuerOriginal) !== issuerMetadata.sha256 ||
        issuerMetadata.url !== "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd" ||
        !Number.isFinite(Date.parse(issuerMetadata.capturedAt)) || Date.parse(issuerMetadata.capturedAt) > Date.now())
      throw new Error("The dated original iShares history must match its receipt");
    const parsedIssuer = JSON.parse(execFileSync("python3", ["-B", "-c",
      "import json,sys;from pathlib import Path;from issuer_corporate_actions import issuer_cash;print(json.dumps(issuer_cash('TLT',Path(sys.argv[1]).read_bytes(),'2025-01-01')))",
      resolve(issuerFolder, "issuer-TLT.bin")], { cwd: resolve(root, "scripts"),
      encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 })) as { sha256: string; cash: CashDistribution[] };
    assert.equal(parsedIssuer.sha256, issuerMetadata.sha256);
    const cash = parsedIssuer.cash.filter(action => action.session >= dates[0] && action.session <= dates.at(-1)!);
    if (!cash.length || cash.some(action => !dates.includes(action.session)))
      throw new Error("Historical issuer cash must identify reviewed exchange ex-dates");

    const inputs = {
      hourly: { name: "TLT-2025-1h.json", bodySha256: original.sha256,
        fileSha256: sha256(await readFile(originalPath)), capturedAt: original.capturedAt, count: original.count },
      raw: { sha256: raw.sha256, priceDigest: raw.priceDigest },
      splitOnly: { sha256: splits.sha256, priceDigest: splits.priceDigest },
      issuer: { symbol: issuerMetadata.symbol, url: issuerMetadata.url, capturedAt: issuerMetadata.capturedAt,
        originalSha256: issuerMetadata.sha256, cashSha256: digest(cash) },
      calendar: HISTORICAL_RESEARCH_CALENDAR.id, beforeFirstPublicForecast: before,
    };
    const inputsSha256 = digest(inputs);
    const saved = await readResearchReceipt<{ protocolSha256: string; inputsSha256: string; summary: unknown;
      observations: Observation[]; datasetSha256: string; bodySha256: string }>(path);
    if (saved) {
      const { bodySha256, ...body } = saved;
      if (bodySha256 !== digest(body) || !Array.isArray(saved.observations) ||
          saved.datasetSha256 !== digest(saved.observations.map(point => point.row))) throw new Error("Private screen receipt digest mismatch");
      if (saved.protocolSha256 !== protocolSha256 || saved.inputsSha256 !== inputsSha256)
        throw new Error("Saved screen differs from the frozen protocol or private inputs");
      console.log(JSON.stringify({ status: "reused_fixed_screen", summary: saved.summary, path }));
      return;
    }

    const full = clocks.map(row => isFullKibotSession(row.openAt, row.closeAt));
    const availability = dates.map(sourceAvailableAt);
    const observations: Observation[] = [];
    const exclusions = { targetShort: 0, sourceWarmup: 0, sourceLookbackShort: 0, sourceStale: 0, referenceShort: 0 };
    for (let target = 0; target < dates.length; target++) {
      if (!full[target]) { exclusions.targetShort++; continue; }
      const issuedAt = newYorkTimestamp(dates[target].replaceAll("-", "") + "T074800")!;
      const observed = availability.findLastIndex(at => at < issuedAt);
      if (observed < 20) { exclusions.sourceWarmup++; continue; }
      if (full.slice(observed - 20, observed + 1).includes(false)) { exclusions.sourceLookbackShort++; continue; }
      if (Date.parse(issuedAt) - Date.parse(clocks[observed].closeAt) > TLT_CLOSE_STALE_DAYS * dayMs) {
        exclusions.sourceStale++; continue;
      }
      if (target < 1 || !full[target - 1]) { exclusions.referenceShort++; continue; }
      const selectedDates = dates.slice(0, observed + 1);
      const changes = closeMomentum(core.closes.slice(0, observed + 1), selectedDates,
        cash.filter(action => action.session <= dates[observed]));
      if (changes.some(change => change.status !== "contiguous" || change.issuerAdjustedChangePct === null))
        throw new Error("The displayed feature window must remain contiguous");
      const features = changes.map(change => roundTltCloseChange(change.issuerAdjustedChangePct!));
      const bar = raw.sessions[target], reference = raw.sessions[target - 1];
      assert.ok(core.closes[observed].closeAt < availability[observed] &&
        availability[observed] < issuedAt && issuedAt < bar.openAt && bar.closeAt < before);
      observations.push({
        row: { id: `TLT:${bar.session}`, engineVersion: method, issuedAt, labelKnownAt: bar.closeAt,
          features, up: bar.close > bar.open ? 1 : 0 },
        sourceSession: dates[observed], sourceCloseAt: clocks[observed].closeAt,
        scheduledAvailableAt: availability[observed], lookbackFrom: dates[observed - 20],
        referenceSession: reference.session, referenceBody: Math.log(reference.close / reference.open),
      });
    }

    const rows = observations.map(point => point.row);
    const plan = planCandidate(rows, before, { engineVersion: method, minimumSamples: protocol.minimumSamples });
    const byId = new Map(observations.map(point => [point.row.id, point]));
    let result;
    if (plan.status !== "ready") result = { status: "insufficient_data" as const, reason: plan.reason };
    else {
      const { train, validation, test } = plan.split;
      assert.equal(validation[0].issuedAt, protocol.validationStarts, "Keep the original validation boundary");
      assert.equal(test[0].issuedAt, protocol.testStarts, "Keep the original test boundary");
      const candidate = fitLogisticModel(train, protocol.regularization);
      const bodyRows = (subset: TrainingRow[]) => subset.map(row => ({ ...row, features: [byId.get(row.id)!.referenceBody] }));
      const body = fitLogisticModel(bodyRows(train), protocol.regularization);
      const trainingRate = train.reduce((sum, row) => sum + row.up, 0) / train.length;
      const scores = {
        candidateBrier: brierScore(test, row => predict(candidate, row.features)),
        previousBodyBrier: brierScore(bodyRows(test), row => predict(body, row.features)),
        trainingBaseBrier: brierScore(test, () => trainingRate), coinBrier: brierScore(test, () => 0.5),
      };
      const describe = (subset: TrainingRow[]) => ({
        count: subset.length, firstCutoff: subset[0].issuedAt, lastCutoff: subset.at(-1)!.issuedAt,
        labelsKnownThrough: subset.at(-1)!.labelKnownAt,
      });
      result = { status: "evaluated" as const, split: {
        train: describe(train), validation: describe(validation), test: describe(test),
      }, trainingRate, scores,
      clearsResearchMargin: scores.candidateBrier < Math.min(
        scores.previousBodyBrier, scores.trainingBaseBrier, scores.coinBrier) - 0.01,
      candidate, referenceBody: body };
    }
    const summary = {
      method, samples: rows.length, minimum: protocol.minimumSamples, distributions: cash.length,
      uniqueSourceSessions: new Set(observations.map(point => point.sourceSession)).size,
      firstTarget: rows[0]?.issuedAt ?? null, lastTarget: rows.at(-1)?.issuedAt ?? null,
      exclusions, ...result,
    };
    // Keep fitted parameters and per-observation evidence inside the private receipt.
    const { candidate: _candidate, referenceBody: _reference, ...coarseSummary } =
      summary as typeof summary & { candidate?: LogisticModel; referenceBody?: LogisticModel };
    const receipt = { method, protocol, protocolSha256, inputs, inputsSha256,
      evaluatedAt: new Date().toISOString(), datasetSha256: digest(rows), summary: coarseSummary,
      result, observations, cash, reconciliation,
      limitations: [
        "This one-year retrospective screen uses latest-vintage bars and issuer histories retrieved in 2026.",
        "The source availability clock is a conservative reconstruction without as-issued 2025 delivery receipts.",
        "Historical hourly receipts retain body hashes but omit the original consolidated-feed header.",
        "Rolling windows overlap, and a dated source observation can appear at more than one target cutoff.",
        "The prior-body comparator assumes the prior independent daily bar was available by the morning cutoff.",
        "One chronological test block provides a preliminary screen with no prospective activation evidence.",
      ],
    };
    await durableJSON(path, { ...receipt, bodySha256: digest(receipt) }, true);
    console.log(JSON.stringify({ status: "saved_fixed_screen", summary: coarseSummary, path }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}

await run();
