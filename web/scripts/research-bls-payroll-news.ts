import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { parsePayrollRelease } from "../lib/consensus/bls-payroll-news.ts";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { isFullKibotSession, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owner = resolve(web, ".consensus/private-bls-payroll-news");
const method = "prelaunch-tlt-original-bls-payroll-revisions-v1";
const firstIssue = "2026-11-03T06:28:30.460Z";
const policySHA256 = "69db484547a03f3800f10e35ad5d9e8808cbe8648ced266e728843c6d61d4b05";
const sealedSHA256 = "bf27c369a61f213963d33cb719d3f87fb1ca618ecaff7c21e0993062408ab066";
const sourceSHA256 = "c515848fb40c480dfa978a43bff6da4b065edd41310a9cc9bd46888ce77dd9e6";
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const DAY = 86400000;
type Clock = { session: string; openAt: string; closeAt: string };
type SourceTarget = {
  period: string;
  releaseDay: string;
  releasedAt: string;
  url: string;
  sha256: string;
  headlineJobs: number;
  revisionJobs: number;
  componentRevisions: Record<string, number>;
  combinedChecked: boolean;
  entry: Clock;
  issuedAt: string;
  control: number;
  feature: number;
};
type YearWitness = { year: string; from: string; through: string; raw: string; split: string };
export type BlsPayrollStudySummary = {
  eligible: number;
  paired: number;
  excluded: number;
  from: string;
  through: string;
  status: "evaluated";
  split: {
    train: number;
    validation: number;
    test: number;
    trainEnds: string;
    testStarts: string;
    testEnds: string;
  };
  candidateBrier: number;
  controlBrier: number;
  baseBrier: number;
  coinBrier: number;
  coefficient: number;
  incrementalBrier: number;
  uncertainty95: [number, number];
  clearsGate: boolean;
};
type SnapshotResult = {
  registration: string;
  before: string;
  witness: YearWitness[];
  rows: TrainingRow[];
  excluded: unknown[];
  summary: BlsPayrollStudySummary;
  combined: ReturnType<typeof trainCandidate>;
  control: ReturnType<typeof trainCandidate>;
};
async function privateBytes(name: string, expected?: string) {
  const path = resolve(owner, name),
    properties = await stat(path);
  if (!properties.isFile() || (properties.mode & 0o077) !== 0)
    throw Error("BLS research requires an owner-only input");
  const bytes = await readFile(path);
  if (expected && sha(bytes) !== expected) throw Error("BLS research input checksum differs");
  return bytes;
}
async function privateJson<T>(name: string, expected?: string): Promise<T> {
  return JSON.parse((await privateBytes(name, expected)).toString("utf8")) as T;
}
function clockFor(day: string, old: Record<string, { early: boolean }>): Clock | null {
  if (day >= "2016-01-01") return extendedResearchSession(day);
  if (day < "2013-01-01") throw Error("BLS study date outside its reviewed exchange calendar");
  const session = old[day];
  if (!session) return null;
  const stamp = day.replaceAll("-", "") + "T";
  return {
    session: day,
    openAt: newYorkTimestamp(stamp + "093000")!,
    closeAt: newYorkTimestamp(stamp + (session.early ? "130000" : "160000"))!,
  };
}
function dates(from: string, through: string, clock: (day: string) => Clock | null) {
  const range: string[] = [];
  for (let time = Date.parse(from); time <= Date.parse(through); time += DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (clock(date)) range.push(date);
  }
  return range;
}
async function originalSignal(member: SourceTarget, clock: (day: string) => Clock | null) {
  const { period, releaseDay, entry } = member;
  const compact = releaseDay.slice(5, 7) + releaseDay.slice(8) + releaseDay.slice(0, 4);
  const meta = await privateJson<{ url: string; sha256: string; bytes: number; retrieved: string }>(
    "originals/" + compact + ".json",
  );
  if (meta.url !== member.url || meta.sha256 !== member.sha256 || !/^[0-9a-f]{64}$/.test(meta.sha256))
    throw Error("BLS native source changed");
  const bytes = gunzipSync(await privateBytes("originals/" + meta.sha256 + ".gz"), {
    maxOutputLength: 3 * 1024 * 1024,
  });
  if (sha(bytes) !== meta.sha256 || bytes.length !== meta.bytes) throw Error("BLS original bytes changed");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  const original = parsePayrollRelease(text, { period, day: releaseDay, url: meta.url });
  if (
    period.endsWith("-01") ||
    !member.combinedChecked ||
    original.combined === null ||
    new Date(original.releasedAt).toISOString() !== new Date(member.releasedAt).toISOString() ||
    original.combined !== member.revisionJobs ||
    original.headline !== member.headlineJobs ||
    member.control !== original.headline / 1000 ||
    member.feature !== original.combined / 1000
  )
    throw Error("BLS source inputs differ from original news");
  let next: Clock | null = null;
  for (let i = 1; i <= 8 && !next; i++)
    next = clock(new Date(Date.parse(releaseDay) + i * DAY).toISOString().slice(0, 10));
  if (
    !isDeepStrictEqual(next, entry) ||
    !isFullKibotSession(entry.openAt, entry.closeAt) ||
    entry.closeAt >= firstIssue ||
    newYorkTimestamp(entry.session.replaceAll("-", "") + "T074800") !== member.issuedAt ||
    !(original.releasedAt < member.issuedAt && member.issuedAt < entry.openAt)
  )
    throw Error("BLS original embargo and next-session selection disagree");
}
async function priceBasis(witness: YearWitness, basis: "raw" | "splits", clock: (day: string) => Clock | null) {
  const name = "prices/TLT-" + witness.year + "-" + witness.from + "-" + witness.through + "-" + basis;
  const meta = await privateJson<{
    ticker: string;
    from: string;
    through: string;
    basis: string;
    sourceSHA256: string;
    receivedAt: string;
  }>(name + ".json");
  const expected = basis === "raw" ? witness.raw : witness.split;
  if (
    meta.ticker !== "TLT" ||
    meta.from !== witness.from ||
    meta.through !== witness.through ||
    meta.basis !== basis ||
    meta.sourceSHA256 !== expected
  )
    throw Error("BLS study price request or basis differs");
  const csv = await privateBytes(name + ".csv", expected);
  return new Map(
    parseKibotDaily(csv.toString("utf8"), dates(witness.from, witness.through, clock), clock).map((p) => [
      p.session,
      p,
    ]),
  );
}

/** Registered length-three moving blocks resample paired error differences in chronological order. */
export function payrollImprovementInterval(deltas: number[]): [number, number] {
  if (deltas.length < 3 || deltas.some((d) => !Number.isFinite(d)))
    throw Error("Invalid BLS held-out differences");
  let random = parseInt(policySHA256.slice(0, 8), 16);
  const replicates: number[] = [];
  for (let pass = 0; pass < 10000; pass++) {
    let sum = 0,
      count = 0;
    while (count < deltas.length) {
      random = (Math.imul(1664525, random) + 1013904223) >>> 0;
      const start = Math.floor((random / 4294967296) * (deltas.length - 2));
      for (let step = 0; step < 3 && count < deltas.length; step++, count++) sum += deltas[start + step];
    }
    replicates.push(sum / deltas.length);
  }
  replicates.sort((a, b) => a - b);
  return [replicates[249], replicates[9749]];
}

/** Replays the 134 registered prelaunch releases and their native TLT price deliveries without network access. */
export async function replayBlsPayrollNewsStudy(cached = true, expectedBefore = firstIssue) {
  if (!cached || expectedBefore !== firstIssue)
    throw Error("This BLS replay requires cached originals and the registered first forecast");
  const registration = await privateJson<{
    registeredAt: string;
    policySHA256: string;
    policy: {
      id: string;
      eligible: number;
      sourceOnlyAtRegistration: boolean;
      dependencies: Record<string, string>;
    };
  }>("registration.json", "3bde98e32fe7c33e43195eaf39e32bb739c92ba8859e11b8d1744fe65771ed75");
  if (
    registration.policySHA256 !== policySHA256 ||
    registration.policy.id !== method ||
    !registration.policy.sourceOnlyAtRegistration ||
    registration.policy.eligible !== 134
  )
    throw Error("BLS policy registration differs");
  for (const [name, expected] of Object.entries(registration.policy.dependencies)) {
    const path = resolve(owner, name);
    const bytes = name.startsWith("../../lib/") ? await readFile(path) : await privateBytes(name);
    if (sha(bytes) !== expected) throw Error("BLS registered dependency differs");
  }
  const sealed = await privateJson<SnapshotResult>("sealed-study.json", sealedSHA256);
  const source = await privateJson<{ targets: SourceTarget[] }>("source-targets.json", sourceSHA256);
  const old = await privateJson<{ days: Record<string, { early: boolean }> }>(
    "../private-issuer-guidance-archive-qualification/older-calendar-private.json",
  );
  const clock = (day: string) => clockFor(day, old.days);
  if (
    sealed.before !== firstIssue ||
    sealed.registration !== policySHA256 ||
    source.targets.length !== 134 ||
    sealed.excluded.length
  )
    throw Error("BLS study scope and exclusions differ");
  const rows: TrainingRow[] = [];
  for (const witness of sealed.witness) {
    const selected = source.targets.filter((t) => t.entry.session.startsWith(witness.year));
    if (selected[0]?.entry.session !== witness.from || selected.at(-1)?.entry.session !== witness.through)
      throw Error("BLS study witness covers other dates");
    const [raw, split] = await Promise.all([
      priceBasis(witness, "raw", clock),
      priceBasis(witness, "splits", clock),
    ]);
    for (const member of selected) {
      await originalSignal(member, clock);
      const day = member.entry.session,
        a = raw.get(day),
        b = split.get(day);
      if (
        !a ||
        !b ||
        a.openAt !== member.entry.openAt ||
        a.closeAt !== member.entry.closeAt ||
        Math.sign(a.close - a.open) !== Math.sign(b.close - b.open)
      )
        throw Error("BLS study TLT intraday price witnesses disagree");
      rows.push({
        id: method + ":" + day,
        engineVersion: method,
        issuedAt: member.issuedAt,
        labelKnownAt: a.closeAt,
        up: a.close > a.open ? 1 : 0,
        features: [member.control, member.feature],
      });
    }
  }
  if (
    !isDeepStrictEqual(sealed.rows, rows) ||
    rows.length !== 134 ||
    new Set(rows.map((r) => r.id)).size !== rows.length
  )
    throw Error("BLS reconstructed historical rows differ");
  const combined = trainCandidate(rows, firstIssue),
    control = trainCandidate(
      rows.map((row) => ({ ...row, features: [row.features[0]] })),
      firstIssue,
    );
  if (
    combined.status !== "evaluated" ||
    control.status !== "evaluated" ||
    !isDeepStrictEqual(combined, sealed.combined) ||
    !isDeepStrictEqual(control, sealed.control) ||
    !isDeepStrictEqual(combined.split, control.split)
  )
    throw Error("BLS reconstructed historical models differ");
  const test = chronologicalSplit(rows).test;
  const diffs = test.map(
    (r) =>
      (predict(control.model, [r.features[0]]) - r.up) ** 2 - (predict(combined.model, r.features) - r.up) ** 2,
  );
  const uncertainty95 = payrollImprovementInterval(diffs),
    coefficient = combined.model.weights[1];
  const summary: BlsPayrollStudySummary = {
    eligible: source.targets.length,
    paired: rows.length,
    excluded: 0,
    from: source.targets[0].entry.session,
    through: source.targets.at(-1)!.entry.session,
    status: "evaluated",
    split: combined.split,
    candidateBrier: combined.candidateBrier,
    controlBrier: control.candidateBrier,
    baseBrier: combined.baseRateBrier,
    coinBrier: combined.coinBrier,
    coefficient,
    incrementalBrier: control.candidateBrier - combined.candidateBrier,
    uncertainty95,
    clearsGate:
      coefficient < 0 &&
      uncertainty95[0] > 0 &&
      Math.min(control.candidateBrier, combined.baseRateBrier, combined.coinBrier) - combined.candidateBrier >
        0.01,
  };
  if (!isDeepStrictEqual(summary, sealed.summary))
    throw Error("BLS reported study result differs from its native replay");
  return { method, before: firstIssue, policySHA256, sealedSHA256, sourceSHA256, summary };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--cached"))
    throw Error("Use --cached for the registered BLS study");
  console.log(JSON.stringify(await replayBlsPayrollNewsStudy(), null, 2));
}
