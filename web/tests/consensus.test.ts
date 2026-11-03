import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blackScholes,
  impliedVolatility,
  fibonacci,
  sessionRange,
  gammaExposure,
  pivotLevels,
} from "../lib/consensus/math.ts";
import {
  calculateConsensus,
  effectiveStatus,
} from "../lib/consensus/engine.ts";
import {
  fredPoints,
  ecbPoints,
  rssItems,
  safeURL,
  publicText,
  newYorkTimestamp,
  blsEvents,
  secQuarters,
} from "../lib/consensus/collector.ts";
import { publishSnapshot, validateSnapshot } from "../lib/consensus/history.ts";
import { evaluateOutcome, performance } from "../lib/consensus/evaluation.ts";
import {
  trainCandidate,
  chronologicalSplit,
} from "../lib/consensus/learning.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";
import type { Bar } from "../lib/contracts.ts";
import { forecastSnapshot, predict } from "../lib/consensus/model.ts";

const at = "2026-11-03T12:00:00.000Z";
const signal = (id = "test"): Signal => ({
  ...missingSignals(at)[0],
  id,
  family: "rates",
  title: "Test government rate",
  status: "available",
  series: [{ date: "2026-11-02", value: 4 }],
  metrics: [],
  scores: { daily: 0.5, weekly: -0.3, monthly: 0.1 },
  source: {
    ...missingSignals(at)[0].source,
    name: "Test public source",
    observedAt: "2026-11-02",
    sha256: "a".repeat(64),
  },
});
const snapshot = (): Snapshot => ({
  schemaVersion: 1,
  id: "2026-11-03T12-00-00-000Z",
  issuedAt: at,
  cutoff: at,
  engineVersion: "test-v1",
  origin: "prospective",
  signals: [signal()],
  catalysts: [],
  sourcesAttempted: 1,
  collectionErrors: [],
});

test("options math matches an independent Black-Scholes benchmark and inverts volatility", () => {
  const call = blackScholes(100, 100, 1, 0.05, 0.2, "call")!,
    put = blackScholes(100, 100, 1, 0.05, 0.2, "put")!;
  assert.ok(Math.abs(call.price - 10.4506) < 0.0001);
  assert.ok(Math.abs(put.price - 5.5735) < 0.0001);
  assert.ok(
    Math.abs(call.price - put.price - (100 - 100 * Math.exp(-0.05))) < 1e-6,
  );
  assert.ok(
    Math.abs(impliedVolatility(call.price, 100, 100, 1, 0.05, "call")! - 0.2) <
      1e-6,
  );
  assert.equal(impliedVolatility(101, 100, 100, 1, 0.05, "call"), null);
  assert.equal(blackScholes(100, 100, 0, 0.05, 0.2, "call"), null);
  assert.equal(gammaExposure([], 100), null);
});
test("Fibonacci excludes future bars and preserves the declared trailing window", () => {
  const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 9, i + 1)).toISOString(),
    open: 100 + i,
    close: 100 + i,
    high: 101 + i,
    low: 99 + i,
    volume: 10,
  }));
  const future = { ...bars[0], time: "2027-01-01T00:00:00Z", high: 9999 };
  assert.deepEqual(fibonacci(bars, at), fibonacci([...bars, future], at));
  assert.equal(fibonacci(bars.slice(1), at), null);
  assert.equal(
    fibonacci(bars, at)?.levels.find((level) => level.ratio === 0.5)?.value,
    109.5,
  );
  assert.deepEqual(
    pivotLevels({
      time: at,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      volume: 1,
    }),
    { pivot: 100, r1: 110, s1: 90, r2: 120, s2: 80 },
  );
});
test("opening range requires the entire New York session interval, handles DST, and never forms early", () => {
  const bars: Bar[] = Array.from({ length: 15 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 10, 3, 14, 30 + i)).toISOString(),
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 100,
  }));
  assert.equal(
    sessionRange(bars, "2026-11-03", "2026-11-03T14:44:59Z", "opening").status,
    "not_formed",
  );
  assert.equal(
    sessionRange(bars, "2026-11-03", "2026-11-03T14:45:00Z", "opening").volume,
    1500,
  );
  assert.equal(
    sessionRange(bars.slice(1), "2026-11-03", "2026-11-03T14:45:00Z", "opening")
      .status,
    "unavailable",
  );
  assert.throws(
    () =>
      sessionRange(
        [...bars, { ...bars[0], time: "2026-11-03T09:30:00-05:00" }],
        "2026-11-03",
        "2026-11-03T14:45:00Z",
        "opening",
      ),
    /Duplicate/,
  );
});
test("missing and stale observations never vote neutral; correlated indicators do not multiply family weight", () => {
  const one = signal(),
    other = {
      ...signal("fx"),
      family: "fx" as const,
      scores: { daily: -0.5, weekly: 0, monthly: 0 },
    };
  const initial = calculateConsensus([one, other], "SPY", "daily", at),
    repeated = calculateConsensus(
      [
        ...Array.from({ length: 30 }, (_, i) => ({
          ...one,
          id: `duplicate-${i}`,
        })),
        other,
      ],
      "SPY",
      "daily",
      at,
    );
  assert.equal(initial.score, 0);
  assert.equal(repeated.score, initial.score);
  assert.ok(initial.abstain);
  assert.equal(
    calculateConsensus(missingSignals(at), "SPY", "daily", at).score,
    null,
  );
  assert.equal(effectiveStatus(one, "2026-12-01T12:00:00Z"), "stale");
  assert.equal(
    calculateConsensus([one], "SPY", "daily", "2026-12-01T12:00:00Z").score,
    null,
  );
});
test("source parsers reject missing/non-numeric/future observations and preserve valid zero", () => {
  assert.deepEqual(
    fredPoints(
      "observation_date,X\n2026-11-01,.\n2026-11-02,0\n2026-11-03,abc\n2027-01-01,5",
      "X",
      at,
    ),
    [{ date: "2026-11-02", value: 0 }],
  );
  const pairs = ecbPoints(
    '<Cube time="2026-11-02"><Cube currency="USD" rate="1.2"/><Cube currency="JPY" rate="150"/></Cube>',
  );
  assert.equal(pairs.get("JPY")?.[0].value, 150);
  const rss =
    "<item><title>Policy &amp; rates</title><link>http://www.boj.or.jp/en/official.htm</link><pubDate>Mon, 02 Nov 2026 14:00:00 +0900</pubDate></item>";
  assert.equal(
    rssItems(rss, "BOJ", "www.boj.or.jp", at)[0].url,
    "https://www.boj.or.jp/en/official.htm",
  );
  assert.equal(
    rssItems(
      rss.replace("www.boj.or.jp", "evil.example"),
      "BOJ",
      "www.boj.or.jp",
      at,
    ).length,
    0,
  );
  assert.throws(() => safeURL("https://localhost/data"));
  assert.throws(() => safeURL("https://fred.stlouisfed.org/data?token=secret"));
});
test("source fetches are bounded and refuse HTTP errors", async () => {
  await assert.rejects(
    publicText(
      "https://fred.stlouisfed.org/test",
      async () => new Response("down", { status: 503 }),
    ),
    /503/,
  );
  await assert.rejects(
    publicText(
      "https://fred.stlouisfed.org/test",
      async () => new Response("x".repeat(2_000_001)),
    ),
    /2 MB/,
  );
});
test("publication rejects provenance gaps and future data before any write", () => {
  validateSnapshot(snapshot());
  assert.throws(
    () =>
      validateSnapshot({
        ...snapshot(),
        signals: [
          { ...signal(), source: { ...signal().source, sha256: null } },
        ],
      }),
    /provenance/,
  );
  assert.throws(
    () =>
      validateSnapshot({
        ...snapshot(),
        signals: [{ ...signal(), series: [{ date: "2027-01-01", value: 4 }] }],
      }),
    /future/,
  );
});
test("immutable publication rejects overwrite, shares editorial lock, and skips unchanged observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-consensus-"));
  try {
    const first = await publishSnapshot(root, snapshot());
    assert.equal(first.changed, true);
    const next = {
      ...snapshot(),
      id: "2026-11-03T12-10-00-000Z",
      issuedAt: "2026-11-03T12:10:00.000Z",
      cutoff: "2026-11-03T12:10:00.000Z",
    };
    assert.equal((await publishSnapshot(root, next)).changed, false);
    const saved = await readFile(
      join(root, "public/consensus", `${snapshot().id}.json`),
      "utf8",
    );
    await assert.rejects(
      publishSnapshot(root, { ...snapshot(), engineVersion: "different" }),
      /follow/,
    );
    assert.equal(
      await readFile(
        join(root, "public/consensus", `${snapshot().id}.json`),
        "utf8",
      ),
      saved,
    );
    await mkdir(join(root, ".editorial"), { recursive: true });
    await writeFile(join(root, ".editorial/publish.lock"), "other publisher");
    await assert.rejects(
      publishSnapshot(root, { ...next, engineVersion: "v2" }),
      /EEXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("outcomes wait for the correct future session and reject missing entry sessions", () => {
  const evidence = {
    instrument: "SPY" as const,
    source: "https://example.com/approved-test-fixture",
    adjustment: "split-adjusted",
    expectedSessions: ["2026-11-02", "2026-11-03", "2026-11-04"],
    sessions: [
      {
        session: "2026-11-03",
        openAt: "2026-11-03T14:30:00.000Z",
        closeAt: "2026-11-03T21:00:00.000Z",
        open: 100,
        close: 102,
      },
      {
        session: "2026-11-04",
        openAt: "2026-11-04T14:30:00.000Z",
        closeAt: "2026-11-04T21:00:00.000Z",
        open: 102,
        close: 101,
      },
    ],
  };
  assert.equal(
    evaluateOutcome(snapshot(), evidence, "daily", "2026-11-03T20:00:00Z"),
    null,
  );
  const outcome = evaluateOutcome(
    snapshot(),
    evidence,
    "daily",
    "2026-11-04T22:00:00Z",
  )!;
  assert.ok(Math.abs(outcome.returnPct - 2) < 1e-8);
  assert.equal(outcome.abstained, true);
  assert.equal(outcome.directionCorrect, null);
  assert.equal(
    evaluateOutcome(
      snapshot(),
      { ...evidence, sessions: evidence.sessions.slice(1) },
      "daily",
      "2026-11-04T22:00:00Z",
    ),
    null,
  );
  assert.equal(
    evaluateOutcome(snapshot(), evidence, "weekly", "2026-11-04T22:00:00Z"),
    null,
  );
  assert.equal(performance([outcome]).accuracy, null);
  assert.throws(() => performance([outcome, outcome]), /Duplicate/);
});
test("learning refuses insufficient data and purges labels crossing split boundaries", () => {
  assert.equal(trainCandidate([], at).status, "insufficient_data");
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    issuedAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    labelKnownAt: new Date(Date.UTC(2025, 0, i + 22)).toISOString(),
    features: [Math.sin(i)],
    up: (i % 2) as 0 | 1,
  }));
  const split = chronologicalSplit(rows);
  assert.ok(
    split.train.every((row) => row.labelKnownAt < split.validation[0].issuedAt),
  );
  assert.ok(
    split.validation.every((row) => row.labelKnownAt < split.test[0].issuedAt),
  );
  const result = trainCandidate(rows, at);
  assert.equal(result.status, "insufficient_data");
  assert.equal(trainCandidate(rows, "2024-01-01T00:00:00Z").samples, 0);
  assert.throws(() => trainCandidate([rows[0], rows[0]], at), /Invalid/);
});
test("BLS calendar converts Eastern summer and winter release times and excludes expired events", () => {
  assert.equal(newYorkTimestamp("20261103T100000"), "2026-11-03T15:00:00.000Z");
  assert.equal(newYorkTimestamp("20260703T083000"), "2026-07-03T12:30:00.000Z");
  assert.equal(newYorkTimestamp("20260308T023000"), null);
  const calendar =
    "BEGIN:VEVENT\nDTSTART;TZID=US-Eastern:20261103T100000\nSUMMARY:Job Openings and Labor Turnover Survey\nEND:VEVENT";
  assert.equal(blsEvents(calendar, at)[0].importance, "major");
  assert.equal(blsEvents(calendar, "2026-11-03T16:00:00Z").length, 0);
});
test("SEC quarter normalization excludes annual totals, later filings and issuer mismatches", () => {
  const base = {
    start: "2026-04-01",
    end: "2026-06-30",
    val: 100,
    accn: "0000320193-26-000020",
    filed: "2026-07-31",
    form: "10-Q",
  };
  const data = {
    cik: 320193,
    units: {
      USD: [
        base,
        { ...base, start: "2025-07-01", val: 400 },
        { ...base, filed: "2027-01-01", val: 999 },
      ],
    },
  };
  assert.deepEqual(
    secQuarters(data, "0000320193", "USD", at).map((row) => row.value),
    [100],
  );
  assert.equal(secQuarters(data, "0000789019", "USD", at).length, 0);
});
test("candidate training evaluates untouched chronological test data and reports calibration", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    id: String(i),
    issuedAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    labelKnownAt: new Date(Date.UTC(2025, 0, i + 2)).toISOString(),
    features: [i % 2 ? 1 : -1],
    up: (i % 2) as 0 | 1,
  }));
  const result = trainCandidate(rows, at);
  assert.equal(result.status, "evaluated");
  if (result.status === "evaluated") {
    assert.ok(result.candidateBrier < result.baseRateBrier);
    assert.equal(
      result.calibration.reduce((sum, bin) => sum + bin.count, 0),
      result.split.test,
    );
    assert.equal(result.model.means.length, 1);
  }
});
test("model inference refuses invalid features and models trained after the issue cutoff", () => {
  const model = {
    intercept: 0,
    weights: [1],
    means: [0],
    scales: [1],
    regularization: 1,
  };
  assert.ok(Math.abs(predict(model, [0]) - 0.5) < 1e-10);
  assert.throws(() => predict({ ...model, weights: [NaN] }, [1]), /schema/);
  assert.throws(
    () =>
      forecastSnapshot(snapshot(), [
        {
          id: "future",
          instrument: "SPY",
          horizon: "daily",
          trainedAt: "2027-01-01T00:00:00.000Z",
          labelsThrough: "2026-12-31T00:00:00.000Z",
          datasetHash: "a",
          samples: 150,
          featureSchema: "family-score-plus-observation-mask-v1",
          model,
          testBrier: 0.1,
          baselineBrier: 0.25,
          testSamples: 30,
        },
      ]),
    /time/,
  );
});
