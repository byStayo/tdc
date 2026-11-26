import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { durableJSON } from "../lib/publication-storage.ts";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import {
  isFullKibotSession,
  kibotHistorySource,
  parseKibotDaily,
  MAX_KIBOT_RESPONSE_BYTES,
} from "../lib/consensus/kibot.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { sourceChunk, sourceResponse } from "../lib/consensus/source-failure.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const before = "2026-11-03T06:28:30.460Z";
const method = "prelaunch-fed-h6-retail-deposit-iwm-v1";
const policyHash = "5ae31205a2eb69600d9030042346b9b435842199150267a91863a48f97551d0d";
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

interface EconomicRelease {
  month: string;
  period?: string;
  release?: string;
  raw?: string;
  excluded?: string;
  current?: [string, string];
  previous?: [string, string];
  previousOriginal?: { day: string; latest: string; raw: string };
}
interface Feature {
  month: string;
  release: string;
  day: string;
  issuedAt: string;
  openAt: string;
  closeAt: string;
  features: number[];
  original: string;
}
type Clock = typeof extendedResearchSession;
type Draw = [number, number, number];
type Basis = "raw" | "splits";
interface PriceFile {
  source: string;
  basis: Basis;
  receivedAt: string;
  sha256: string;
  csv: string;
}
interface Reservation {
  frozenAt: string;
  cohortSha256: string;
  scriptSha256: string;
  sourceScriptSha256: string;
  renditionsScriptSha256: string;
  policySha256: string;
  status: "ready" | "insufficient_data";
}
async function required<T>(path: string, wanted?: string): Promise<T> {
  const value = await readResearchReceipt<T>(path);
  if (!value || (wanted && hash(await readFile(path)) !== wanted))
    throw Error("Required owner-only receipt or digest differs");
  return value;
}
async function save<T>(path: string, value: T) {
  const existing = await readResearchReceipt<T>(path);
  if (existing) assert.deepEqual(value, existing, "Cannot revise a previous study receipt");
  else await durableJSON(path, value, true);
}
function dayAfter(day: string) {
  return new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
}
function sourceClock(older: Record<string, { early: boolean }>): Clock {
  return (day: string) => {
    if (day >= "2016-01-01") return extendedResearchSession(day);
    if (day < "2008-01-01") throw Error("Date outside the H.6 research calendar");
    if (!older[day]) return null;
    const compact = day.replaceAll("-", "");
    return {
      session: day,
      openAt: newYorkTimestamp(compact + "T093000")!,
      closeAt: newYorkTimestamp(compact + (older[day].early ? "T130000" : "T160000"))!,
    };
  };
}
export function buildH6Cohort(months: EconomicRelease[], excludedDays: Set<string>, clock: Clock) {
  const rows: Feature[] = [],
    excluded: { month: string; reason: string; target?: string }[] = [];
  const targets = new Set<string>();
  const periods = new Set<string>();
  for (const month of months) {
    if (month.excluded) {
      excluded.push({ month: month.month, reason: month.excluded });
      continue;
    }
    const { period, release, previous, current, raw, previousOriginal } = month;
    if (
      !period ||
      !release ||
      !raw ||
      !previous ||
      !current ||
      !previousOriginal ||
      previousOriginal.day >= release ||
      previousOriginal.latest >= period ||
      periods.has(period)
    )
      throw Error("Invalid first-release evidence");
    periods.add(period);
    let day = dayAfter(release);
    let session = clock(day);
    for (let n = 0; !session && n < 8; n++) {
      day = dayAfter(day);
      session = clock(day);
    }
    if (!session || day.slice(0, 4) > "2021" || day <= release) throw Error("No qualifying exchange clock");
    if (targets.has(day)) throw Error("Duplicate economic target date");
    targets.add(day);
    const reason = !isFullKibotSession(session.openAt, session.closeAt)
      ? "short_session"
      : excludedDays.has(day)
        ? "previously_examined_iwm"
        : null;
    if (reason) {
      excluded.push({ month: month.month, target: day, reason });
      continue;
    }
    const features = current.map((v, i) => {
      const ratio = Number(v) / Number(previous[i]);
      if (!Number.isFinite(ratio) || ratio <= 0) throw Error("Invalid balance growth");
      return Math.max(-1, Math.min(1, (-100 * Math.log(ratio)) / 5));
    });
    const issuedAt = newYorkTimestamp(day.replaceAll("-", "") + "T074800")!;
    if (!issuedAt || issuedAt >= session.openAt) throw Error("Invalid pre-open decision");
    rows.push({
      month: period,
      release,
      day,
      issuedAt,
      openAt: session.openAt,
      closeAt: session.closeAt,
      features,
      original: raw,
    });
  }
  if (rows.some((row, i) => i > 0 && row.issuedAt <= rows[i - 1].closeAt))
    throw Error("Overlapping study observations");
  return { rows, excluded };
}
export function h6Intervals(differences: Draw[]) {
  if (
    differences.length < 20 ||
    differences.some((row) => row.length !== 3 || row.some((x) => !Number.isFinite(x) || Math.abs(x) > 1))
  )
    throw Error("Expected three paired loss differences for each reserved test date");
  const draws: number[][] = [[], [], []];
  let state = 20261124;
  const n = differences.length;
  for (let iteration = 0; iteration < 100_000; iteration++) {
    const sum = [0, 0, 0];
    for (let used = 0; used < n; used += 3) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const start = Math.floor((state / 4294967296) * (n - 2));
      for (let offset = 0; offset < Math.min(3, n - used); offset++)
        for (let j = 0; j < 3; j++) sum[j] += differences[start + offset][j];
    }
    for (let j = 0; j < 3; j++) draws[j].push(sum[j] / n);
  }
  return draws.map((data, j) => {
    data.sort((a, b) => a - b);
    return {
      mean: differences.reduce((s, row) => s + row[j], 0) / n,
      interval95: [data[2499], data[97499]],
      correctedLower: data[Math.floor((data.length * 0.05) / (33 * 3)) - 1],
    };
  });
}
/** Verify the exchange dates of a native response without decoding any price outside the sealed selection. */
export function selectReservedPrices(csv: string, allDays: string[], selected: string[], clock: Clock) {
  const chosen = new Set(selected);
  if (chosen.size !== selected.length || [...chosen].some((day) => !allDays.includes(day)))
    throw Error("Unknown reserved session");
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length !== allDays.length) throw Error("Incomplete native IWM date cover");
  const reserved: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const day = allDays[i];
    if (!lines[i].startsWith(day.slice(5, 7) + "/" + day.slice(8) + "/" + day.slice(0, 4) + ","))
      throw Error("Native date sequence disagrees with the venue calendar");
    if (chosen.has(day)) reserved.push(lines[i]);
  }
  return parseKibotDaily(reserved.join("\n"), selected, clock);
}
async function historicalPrices(
  root: string,
  rows: Feature[],
  clock: Clock,
  capture: boolean,
  reservedAt: string,
) {
  const sign = new Map<string, number>(),
    sourceHashes: Record<string, string> = {};
  for (const year of new Set(rows.map((r) => r.day.slice(0, 4)))) {
    const targets = rows.filter((r) => r.day.startsWith(year)).map((r) => r.day);
    const [from, through] = [targets[0], targets.at(-1)!];
    const allDays: string[] = [];
    for (let day = from; day <= through; day = dayAfter(day)) if (clock(day)) allDays.push(day);
    for (const basis of ["raw", "splits"] as const) {
      const name = "IWM-" + from + "-" + through + "-" + basis + ".json";
      const file = resolve(root, "prices", name),
        source = kibotHistorySource("IWM", from, through, basis);
      let receipt = await readResearchReceipt<PriceFile>(file);
      if (!receipt && capture) {
        const url = new URL(source);
        url.searchParams.set("user", "guest");
        url.searchParams.set("password", "guest");
        const response = await sourceResponse(fetch, url.href, {
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        });
        const reader = response.body!.getReader(),
          parts: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await sourceChunk(reader);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_KIBOT_RESPONSE_BYTES) throw Error("Oversized research price response");
            parts.push(chunk.value);
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
        const raw = Buffer.concat(parts),
          csv = raw.toString("utf8");
        selectReservedPrices(csv, allDays, targets, clock);
        receipt = { source, basis, receivedAt: new Date().toISOString(), sha256: hash(raw), csv };
        await save(file, receipt);
      }
      if (
        !receipt ||
        receipt.source !== source ||
        receipt.basis !== basis ||
        hash(receipt.csv) !== receipt.sha256 ||
        receipt.receivedAt <= reservedAt ||
        receipt.receivedAt > new Date().toISOString()
      )
        throw Error("Invalid or missing native evaluation-price receipt " + name);
      for (const bar of selectReservedPrices(receipt.csv, allDays, targets, clock)) {
        const direction = Math.sign(bar.close - bar.open);
        if (basis === "splits" && direction !== sign.get(bar.session))
          throw Error("Native bases disagree on reserved outcome " + bar.session);
        if (basis === "raw") sign.set(bar.session, direction);
      }
      sourceHashes[name] = hash(await readFile(file));
    }
  }
  return { sign, sourceHashes };
}
async function runStudy(directory: string, action: "reserve" | "capture" | "replay") {
  const scripts = resolve(web, "scripts");
  const policy = await readFile(resolve(scripts, "h6-retail-iwm-policy.json"));
  assert.equal(hash(policy), policyHash);
  const pins = JSON.parse(String(policy)).sealedInputPolicy;
  const initial = await required<{ registeredAt: string; policySha256: string; priceFilesOpenedForStudy: number }>(
    resolve(directory, "registration.json"),
  );
  assert.equal(initial.policySha256, policyHash);
  assert.equal(initial.priceFilesOpenedForStudy, 0);
  assert.equal(hash(await readFile(resolve(web, "public/consensus/kibot-research.json"))), pins.public32);
  assert.equal(hash(await readFile(resolve(web, "lib/consensus/learning.ts"))), pins.learning);
  assert.equal(
    hash(await readFile(resolve(web, "lib/consensus/extended-research-calendar.ts"))),
    pins.calendar2016plus,
  );
  await required(resolve(directory, "earlier-overlap.json"), pins.earlierOverlap);
  const roster = await required<{ releases: { day: string }[] }>(
    resolve(directory, "excluded-roster.json"),
    pins.dolRoster,
  );
  const excludedDays = new Set(roster.releases.map((r) => r.day));
  if (excludedDays.size !== 147) throw Error("Earlier DOL reservation changed");
  const sourceScript = resolve(scripts, "research-h6-retail-originals.py");
  const { stdout } = await run("python3", ["-B", sourceScript, "--directory", directory], {
    maxBuffer: 8192,
    timeout: 120_000,
  });
  const source = await required<{ study: string; months: EconomicRelease[]; calendar: string }>(
    resolve(directory, "board-first-months.json"),
    JSON.parse(stdout).seal,
  );
  const renditionsScript = resolve(scripts, "verify-h6-retail-pdfs.py");
  const sourceRendering = await run("python3", ["-B", renditionsScript, "--directory", directory], {
    maxBuffer: 8192,
    timeout: 120_000,
  });
  const renderingHash = JSON.parse(sourceRendering.stdout).sha256;
  const verified = await required<{ source: string; rows: unknown[] }>(
    resolve(directory, "board-renderings.json"),
    renderingHash,
  );
  assert.equal(verified.source, JSON.parse(stdout).seal);
  assert.equal(verified.rows.length, source.months.filter((m) => m.release).length);
  assert.equal(source.study, policyHash);
  const calendar = await required<{ days: Record<string, { early: boolean }> }>(
    resolve(directory, "historical-sessions.json"),
    source.calendar,
  );
  const clock = sourceClock(calendar.days);
  const { rows, excluded } = buildH6Cohort(source.months, excludedDays, clock);
  const split = chronologicalSplit(
    rows.map((r) => ({
      id: r.day,
      engineVersion: method,
      issuedAt: r.issuedAt,
      labelKnownAt: r.closeAt,
      features: r.features,
      up: 0,
    })),
  );
  const cohort = {
    method,
    before,
    source: JSON.parse(stdout).seal,
    renderingHash,
    policyHash,
    rows,
    excluded,
    train: split.train.map((r) => r.id),
    validation: split.validation.map((r) => r.id),
    test: split.test.map((r) => r.id),
  };
  const journal = resolve(directory, "cohort.json"),
    reservationFile = resolve(directory, "reservation.json");
  if (action === "reserve") await save(journal, cohort);
  assert.deepEqual(await required(journal), cohort);
  const fields = {
    cohortSha256: hash(await readFile(journal)),
    scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    sourceScriptSha256: hash(await readFile(sourceScript)),
    renditionsScriptSha256: hash(await readFile(renditionsScript)),
    policySha256: policyHash,
    status: rows.length >= 120 ? ("ready" as const) : ("insufficient_data" as const),
  };
  let reservation = await readResearchReceipt<Reservation>(reservationFile);
  if (!reservation && action === "reserve") {
    reservation = { ...fields, frozenAt: new Date().toISOString() };
    await save(reservationFile, reservation);
  }
  if (!reservation || reservation.frozenAt <= new Date(initial.registeredAt).toISOString())
    throw Error("No valid prior selection");
  assert.deepEqual(reservation, { ...fields, frozenAt: reservation.frozenAt });
  const stats = {
    pairedCandidates: rows.length,
    train: split.train.length,
    validation: split.validation.length,
    test: split.test.length,
    excluded: Object.fromEntries(
      [...new Set(excluded.map((e) => e.reason))].map((key) => [
        key,
        excluded.filter((e) => e.reason === key).length,
      ]),
    ),
    releaseCandidates: source.months.filter((m) => m.release).length,
    reservation: hash(await readFile(reservationFile)),
  };
  if (action === "reserve" || fields.status !== "ready") return { ...stats, status: fields.status };
  const { sign, sourceHashes } = await historicalPrices(
    directory,
    rows,
    clock,
    action === "capture",
    reservation.frozenAt,
  );
  assert.equal(sign.size, rows.length);
  const combined: TrainingRow[] = rows.map((r) => ({
    id: "IWM-" + r.day,
    engineVersion: method,
    issuedAt: r.issuedAt,
    labelKnownAt: r.closeAt,
    features: r.features,
    up: sign.get(r.day)! > 0 ? 1 : 0,
  }));
  const control = combined.map((r) => ({ ...r, features: [r.features[1]] }));
  const result = trainCandidate(combined, before),
    baseline = trainCandidate(control, before);
  if (result.status !== "evaluated" || baseline.status !== "evaluated")
    throw Error("Existing learning gate did not admit this cohort");
  const { train, test } = chronologicalSplit(combined);
  const rate = train.reduce((s, r) => s + r.up, 0) / train.length;
  const differences = test.map((r): Draw => {
    const loss = (p: number) => (p - r.up) ** 2;
    const evaluated = loss(predict(result.model, r.features));
    return [
      loss(predict(baseline.model, [r.features[1]])) - evaluated,
      loss(rate) - evaluated,
      loss(0.5) - evaluated,
    ];
  });
  const uncertainty = h6Intervals(differences);
  const passed = result.model.weights[0] > 0 && uncertainty.every((d) => d.mean > 0.01 && d.correctedLower > 0);
  const summary = {
    ...stats,
    sourceHashes,
    method,
    before,
    interval: result.split,
    combined: result.candidateBrier,
    control: baseline.candidateBrier,
    trainingBase: result.baseRateBrier,
    coin: 0.25,
    coefficient: result.model.weights[0],
    combinedHash: result.datasetHash,
    controlHash: baseline.datasetHash,
    uncertainty,
    passed,
  };
  if (action === "capture") await save(resolve(directory, "result.json"), summary);
  assert.deepEqual(await required(resolve(directory, "result.json")), summary);
  return {
    ...stats,
    interval: summary.interval,
    combined: summary.combined,
    control: summary.control,
    trainingBase: summary.trainingBase,
    coin: 0.25,
    coefficient: summary.coefficient,
    uncertainty,
    passed,
    resultHash: hash(await readFile(resolve(directory, "result.json"))),
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv[2],
    path = process.argv[3] ?? resolve(web, ".consensus/private-h6-retail-iwm");
  if (!["--reserve", "--capture", "--replay"].includes(mode) || process.argv.length > 4)
    throw Error("Choose --reserve, --capture or --replay and an optional private directory");
  if ((await lstat(path)).mode & 0o077) throw Error("Study directory must be owner-only");
  console.log(JSON.stringify(await runStudy(resolve(path), mode.slice(2) as "reserve" | "capture" | "replay")));
}
