import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import {
  extendedResearchSession,
  extendedResearchSessions,
} from "../lib/consensus/extended-research-calendar.ts";
import {
  isFullKibotSession,
  MAX_KIBOT_RESPONSE_BYTES,
  parseKibotDaily,
} from "../lib/consensus/kibot.ts";
import {
  chronologicalSplit,
  predict,
  trainCandidate,
  type TrainingRow,
} from "../lib/consensus/learning.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";
import { meetingEnds, pairedEves } from "./research-fomc-eve.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const file = fileURLToPath(import.meta.url);
const method = "prelaunch-spy-cambria-tail-risk-v1";
const before = "2026-11-03T06:28:30.460Z";
const instruments = ["SPY", "IEF", "TAIL"] as const;
type Fund = (typeof instruments)[number];
type Basis = "raw" | "splits";
type Inputs = {
  day: string;
  prior: string;
  issuedAt: string;
  labelKnownAt: string;
};
type Capture = {
  source: string;
  receivedAt: string;
  sha256: string;
  text: string;
};
type Bar = { open: number; close: number };
type Loss = [number, number, number];
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const clock = extendedResearchSession;
const stamp = () => new Date().toISOString();

const rosterSources = {
  earlier: [
    "private-h6-retail-iwm/earlier-overlap.json",
    "77054d1f9e535f0d8cac3aa463f7110955678cf3f23e8c2b3cc706a8f8fe606b",
  ],
  swvxx: [
    "private-retail-nmfp/source-candidates.json",
    "37e1e98f661dc42806be7dfcab8611f561a467410153d7bfa6fae16b6f6a904c",
  ],
  iem: [
    "private-iem-screen/extended-source.json",
    "cf718b3022d7026797be015ae8cb83ee9506c08725b10f32f568c596aab8f427",
  ],
  fed2018: [
    "private-spy-fomc-eve/sources/schedule-2018.html",
    "755c04581a617df3afe5aaeb1493bc441cfcee480d812c5121112ea0f109217e",
  ],
  fed2019: [
    "private-spy-fomc-eve/sources/schedule-2019.html",
    "6d877d803e158d2ef002fe0f7b738300779615e5cf2cf026f7155472459185b8",
  ],
} as const;
async function earlierSPY(root: string) {
  const source = async (id: keyof typeof rosterSources) => {
    const [name, sha256] = rosterSources[id];
    const bytes = await readFile(resolve(root, name));
    assert.equal(
      hash(bytes),
      sha256,
      "Earlier study exclusion receipt changed",
    );
    return bytes.toString("utf8");
  };
  const past = JSON.parse(await source("earlier")) as {
    oldSPYDates: Record<string, string[]>;
  };
  const old = Object.values(past.oldSPYDates).flat();
  const schwab = JSON.parse(await source("swvxx")) as { day: string }[];
  const iem = JSON.parse(await source("iem")) as { rows: { target: string }[] };
  const fed: string[] = [];
  for (const [year, accession] of [
    [2018, "20170511b"],
    [2019, "20180525a"],
  ] as const) {
    const pairs = pairedEves(
      meetingEnds(
        await source(year === 2018 ? "fed2018" : "fed2019"),
        year,
        accession,
      ),
    );
    assert.equal(pairs.length, 8);
    fed.push(...pairs.flatMap(({ eve, control }) => [eve, control]));
  }
  return {
    previouslyScreened: old,
    retailCash: schwab.map((row) => row.day),
    campaigns: iem.rows.map((row) => row.target),
    policyMeetings: fed,
  };
}
export function tailTargetCalendar(excluded: Set<string>) {
  const rows: Inputs[] = [];
  const removed = {
    sourceOrTargetShort: 0,
    sourcePreviouslyExamined: 0,
    targetPreviouslyExamined: 0,
  };
  const all = extendedResearchSessions("2017-12-20", "2019-12-31");
  for (let i = 3; i < all.length; i++) {
    const day = all[i],
      prior = all[i - 3];
    if (day < "2018") continue;
    const target = clock(day)!,
      input = clock(prior)!;
    const issuedAt = newYorkTimestamp(day.replaceAll("-", "") + "T074800")!;
    if (
      !isFullKibotSession(target.openAt, target.closeAt) ||
      !isFullKibotSession(input.openAt, input.closeAt)
    ) {
      removed.sourceOrTargetShort++;
    } else if (excluded.has(day)) {
      removed.targetPreviouslyExamined++;
    } else if (excluded.has(prior)) {
      removed.sourcePreviouslyExamined++;
    } else {
      assert(
        Date.parse(issuedAt) - Date.parse(input.closeAt) >= 48 * 3600_000 &&
          target.closeAt < before,
      );
      rows.push({ day, prior, issuedAt, labelKnownAt: target.closeAt });
    }
  }
  return { rows, removed };
}
async function register(other: string) {
  const rosters = await earlierSPY(other);
  const dates = new Set(Object.values(rosters).flat());
  const calendar = tailTargetCalendar(dates);
  assert(calendar.rows.length >= 120);
  return {
    method,
    before,
    policy: hash(
      await readFile(resolve(web, "scripts/tail-risk-spy-policy.json")),
    ),
    program: hash(await readFile(file)),
    learning: hash(await readFile(resolve(web, "lib/consensus/learning.ts"))),
    calendar: hash(
      await readFile(
        resolve(web, "lib/consensus/extended-research-calendar.ts"),
      ),
    ),
    rosterSources,
    rosters,
    ...calendar,
  };
}
async function lockRegistration(root: string, source: string, create: boolean) {
  const data = await register(source);
  const filename = resolve(root, "reservation.json");
  const previous = await readResearchReceipt<{
    recordedAt: string;
    data: typeof data;
  }>(filename);
  if (previous) {
    assert.deepEqual(
      previous.data,
      data,
      "Reservation, study source or economic dates changed",
    );
    return previous;
  }
  if (!create)
    throw Error("Register the study before reading any market or target price");
  const receipt = { recordedAt: stamp(), data };
  await durableJSON(filename, receipt, true);
  return receipt;
}

/** Inspect calendar identities first. Prices of excluded sessions are never parsed. */
export function selectTailBars(
  csv: string,
  calendar: string[],
  selected: Set<string>,
) {
  const allowed = new Set(calendar),
    kept: string[] = [],
    keptDates: string[] = [];
  let last = "";
  for (const line of csv.trim().split(/\r?\n/)) {
    const m = /^(\d\d)\/(\d\d)\/(\d{4}),/.exec(line);
    if (!m)
      throw Error(
        "Historical native response has an invalid date or access status",
      );
    const day = m[3] + "-" + m[1] + "-" + m[2];
    if (!allowed.has(day) || day <= last)
      throw Error(
        "Historical native dates are duplicated or outside the frozen calendar",
      );
    last = day;
    if (selected.has(day)) {
      kept.push(line);
      keptDates.push(day);
    }
  }
  return kept.length ? parseKibotDaily(kept.join("\n"), keptDates, clock) : [];
}
function canonical(symbol: Fund, from: string, through: string, basis: Basis) {
  const date = (v: string) =>
    v.slice(5, 7) + "/" + v.slice(8) + "/" + v.slice(0, 4);
  const url = new URL("https://api.kibot.com/");
  url.search = new URLSearchParams({
    action: "history",
    interval: "daily",
    symbol,
    ...(basis === "raw" ? { unadjusted: "1" } : { splitadjusted: "1" }),
    startdate: date(from),
    enddate: date(through),
  }).toString();
  return url.href;
}
async function history(
  root: string,
  fund: Fund,
  basis: Basis,
  year: string,
  dates: Set<string>,
  after: string,
  live: boolean,
) {
  const selected = [...dates].filter((day) => day.startsWith(year)).sort();
  const from = selected[0],
    through = selected.at(-1)!;
  const calendar = extendedResearchSessions(from, through);
  const url = canonical(fund, from, through, basis);
  const cache = resolve(root, `${fund}-${year}-${basis}.json`);
  let capture = await readResearchReceipt<Capture>(cache);
  if (!capture) {
    if (!live)
      throw Error(`Missing offline ${fund} ${year} ${basis} research original`);
    const request = new URL(url);
    request.searchParams.set("user", "guest");
    request.searchParams.set("password", "guest");
    const r = await fetch(request, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(20000),
    });
    if (r.status !== 200 || !r.body)
      throw Error(
        `Unsuccessful historical research price acquisition for ${fund}`,
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const bytes of r.body) {
      length += bytes.byteLength;
      if (length > MAX_KIBOT_RESPONSE_BYTES)
        throw Error("Oversized historical research response");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const bars = selectTailBars(text, calendar, dates);
    if (!bars.length)
      throw Error(`No registered historical observations for ${fund}`);
    capture = { source: url, receivedAt: stamp(), sha256: hash(bytes), text };
    await durableJSON(cache, capture, true);
  }
  assert.equal(capture.source, url, "Wrong native instrument, fields or range");
  assert.equal(capture.sha256, hash(capture.text));
  assert(
    new Date(capture.receivedAt).toISOString() === capture.receivedAt &&
      after < capture.receivedAt &&
      capture.receivedAt <= stamp(),
  );
  return {
    bars: selectTailBars(capture.text, calendar, dates),
    hash: capture.sha256,
  };
}
export function validatedReturn(raw?: Bar, splits?: Bar): number | undefined {
  if (!raw || !splits) return undefined;
  const a = raw.close / raw.open,
    b = splits.close / splits.open;
  if (
    ![a, b].every((n) => Number.isFinite(n) && n > 0) ||
    Math.sign(a - 1) !== Math.sign(b - 1) ||
    Math.abs(a - b) > 0.0001
  )
    return undefined;
  return Math.log(a);
}
function pairedLossInterval(rows: Loss[]) {
  const b = [[], [], []] as number[][];
  let state = 20261124;
  for (let i = 0; i < 100000; i++) {
    const sums = [0, 0, 0];
    for (let a = 0; a < rows.length; a += 3) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const start = Math.floor((state * (rows.length - 2)) / 2 ** 32);
      for (let j = 0; j < Math.min(3, rows.length - a); j++) {
        for (let k = 0; k < 3; k++) sums[k] += rows[start + j][k];
      }
    }
    for (let k = 0; k < 3; k++) b[k].push(sums[k] / rows.length);
  }
  return b.map((samples) => {
    samples.sort((a, b) => a - b);
    return {
      twoSided95: [samples[2499], samples[97499]],
      correctedLower: samples[Math.floor((100000 * 0.05) / (35 * 3)) - 1],
    };
  });
}
async function compare(
  root: string,
  reservation: Awaited<ReturnType<typeof lockRegistration>>,
  live: boolean,
) {
  const allPrices = new Map<Fund, Map<string, number>>();
  const hashes: Record<string, string> = {};
  for (const symbol of ["TAIL", "IEF", "SPY"] as const) {
    if (symbol === "SPY") {
      const ready = reservation.data.rows.filter(
        ({ prior }) =>
          allPrices.get("TAIL")!.has(prior) && allPrices.get("IEF")!.has(prior),
      );
      if (ready.length < 120)
        throw Error(
          "Insufficient eligible tail and collateral observations before opening SPY labels",
        );
    }
    const days = new Set(
      reservation.data.rows.flatMap((r) =>
        symbol === "SPY" ? [r.day, r.prior] : [r.prior],
      ),
    );
    const returns = new Map<string, number>();
    for (const year of [
      ...new Set([...days].map((day) => day.slice(0, 4))),
    ].sort()) {
      const raw = await history(
        root,
        symbol,
        "raw",
        year,
        days,
        reservation.recordedAt,
        live,
      );
      const splits = await history(
        root,
        symbol,
        "splits",
        year,
        days,
        reservation.recordedAt,
        live,
      );
      hashes[`${symbol}-${year}-raw`] = raw.hash;
      hashes[`${symbol}-${year}-splits`] = splits.hash;
      const map = new Map(splits.bars.map((bar) => [bar.session, bar]));
      for (const bar of raw.bars) {
        const value = validatedReturn(bar, map.get(bar.session));
        if (value !== undefined) returns.set(bar.session, value);
      }
    }
    allPrices.set(symbol, returns);
  }
  const dropped: { day: string; missing: string[] }[] = [];
  const training: TrainingRow[] = [];
  for (const row of reservation.data.rows) {
    const missing = instruments
      .filter((id) => !allPrices.get(id)!.has(row.prior))
      .map((id) => id + "-input");
    const move = allPrices.get("SPY")!.get(row.day);
    if (move === undefined) missing.push("SPY-outcome");
    if (missing.length) {
      dropped.push({ day: row.day, missing });
      continue;
    }
    training.push({
      id: `SPY:${row.day}`,
      engineVersion: method,
      issuedAt: row.issuedAt,
      labelKnownAt: row.labelKnownAt,
      features: instruments.map((id) => allPrices.get(id)!.get(row.prior)!),
      up: move! > 0 ? 1 : 0,
    });
  }
  // Missing quotes cannot shift an already reserved test or validation boundary.
  const reserved = reservation.data.rows;
  const validationFrom = reserved[Math.floor(reserved.length * 0.6)].issuedAt;
  const testFrom = reserved[Math.floor(reserved.length * 0.8)].issuedAt;
  const folds = chronologicalSplit(training);
  if (
    folds.validation.some(
      (row) => row.issuedAt < validationFrom || row.issuedAt >= testFrom,
    ) ||
    folds.train.some((row) => row.issuedAt >= validationFrom) ||
    folds.test.some((row) => row.issuedAt < testFrom)
  ) {
    throw Error(
      "Missing observations would change the frozen chronological fold membership",
    );
  }
  const full = trainCandidate(training, before);
  const control = trainCandidate(
    training.map((row) => ({ ...row, features: row.features.slice(0, 2) })),
    before,
  );
  if (full.status !== "evaluated" || control.status !== "evaluated")
    throw Error(
      "Insufficient matched full sessions or eligible chronological folds",
    );
  assert.deepEqual(full.split, control.split);
  const split = chronologicalSplit(training);
  const base = split.train.reduce((n, r) => n + r.up, 0) / split.train.length;
  const deltas = split.test.map((row) => {
    const modelLoss = (predict(full.model, row.features) - row.up) ** 2;
    return [predict(control.model, row.features.slice(0, 2)), base, 0.5].map(
      (p) => (p - row.up) ** 2 - modelLoss,
    ) as Loss;
  });
  const intervals = pairedLossInterval(deltas);
  const candidate = full.candidateBrier;
  const summary = {
    eligible: training.length,
    excludedMissing: dropped.length,
    training: split.train.length,
    validation: split.validation.length,
    test: split.test.length,
    model: candidate,
    control: control.candidateBrier,
    baseRate: full.baseRateBrier,
    coin: full.coinBrier,
    coefficient: full.model.weights[2],
    intervals,
    testFrom: split.test[0].id.slice(4),
    testThrough: split.test.at(-1)!.id.slice(4),
    passes:
      full.model.weights[2] < 0 &&
      Math.min(control.candidateBrier, full.baseRateBrier, full.coinBrier) -
        candidate >
        0.01 &&
      intervals.every((value) => value.correctedLower > 0),
  };
  const result = {
    method,
    before,
    reservation: hash(JSON.stringify(reservation)),
    hashes,
    featuresAndLabels: full.datasetHash,
    matchedControl: control.datasetHash,
    dropped,
    summary,
  };
  const destination = resolve(root, "result.json");
  const previous = await readResearchReceipt<typeof result>(destination);
  if (previous)
    assert.deepEqual(
      result,
      previous,
      "Sealed result disagrees with offline reconstruction",
    );
  else if (live) await durableJSON(destination, result, true);
  else throw Error("Unsealed result cannot pass offline verification");
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === file) {
  const [mode, source, directory, ...extra] = process.argv.slice(2);
  if (
    !["--register", "--capture", "--replay"].includes(mode) ||
    !source ||
    !directory ||
    extra.length
  ) {
    throw Error(
      "Expected --register|--capture|--replay SHARED_PRIVATE_SOURCES PRIVATE_STUDY_DIRECTORY",
    );
  }
  const root = resolve(directory);
  await durableDirectory(root, 0o700);
  const reservation = await lockRegistration(
    root,
    resolve(source),
    mode === "--register",
  );
  const output =
    mode === "--register"
      ? {
          method,
          recordedAt: reservation.recordedAt,
          registered: reservation.data.rows.length,
          removed: reservation.data.removed,
          reservation: hash(JSON.stringify(reservation)),
        }
      : await compare(root, reservation, mode === "--capture");
  console.log(JSON.stringify(output));
}
