import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicBytes } from "../lib/consensus/collector.ts";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { verifyPublicationTree, digest } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt, type ResearchPriceReceipt } from "../lib/consensus/research-price-capture.ts";
import { parseTicRelease, TIC_RELEASE_CLOCK, type TicReleaseReading } from "../lib/consensus/tic-release.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(web, ".consensus/private-tic-treasury-demand");
const sources = resolve(directory, "sources");
const method = "prelaunch-tlt-tic-treasury-demand-v1";
const policyHash = "8396c501e2f980deb22bb863b7b0222424576cb7f8f40c8d4367f6e48f0f7d99";
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
// The linked Treasury press PDFs independently reproduce these conflicting headers or periods.
const conflicts = new Set(["sm711", "jy1482", "sb0055"]);

async function original(key: string, cached: boolean, registeredAt: string) {
  if (!/^[a-z]+\d+$/.test(key)) throw new Error("Invalid Treasury release identifier");
  const route = key === "sm0146" ? "press-release" : "press-releases";
  const url = "https://home.treasury.gov/news/" + route + "/" + key;
  const path = resolve(sources, key + ".html"), metaPath = resolve(sources, key + ".receipt.json");
  let receipt = await readResearchReceipt<{ url: string; sha256: string; retrievedAt: string }>(metaPath);
  if (!receipt) {
    if (cached) throw new Error("Missing private Treasury original " + key);
    const capture = await publicBytes(url, fetch, 1_200_000, "text/html");
    // An interrupted file-only capture can safely resume after exact-byte comparison.
    try { await writeFile(path, capture.bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha(await readFile(path)) !== capture.sha256) throw error;
    }
    receipt = { url, sha256: capture.sha256, retrievedAt: capture.retrievedAt };
    await durableJSON(metaPath, receipt, true);
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || !stat.size || stat.size > 1_200_000 || receipt.url !== url ||
      !Number.isFinite(Date.parse(receipt.retrievedAt)) || Date.parse(receipt.retrievedAt) < Date.parse(registeredAt))
    throw new Error("Invalid private Treasury source receipt " + key);
  const body = await readFile(path);
  if (sha(body) !== receipt.sha256) throw new Error("Treasury original changed after capture " + key);
  return { text: body.toString("utf8"), sha256: receipt.sha256 };
}

type Target = { day: string; key: string; originalSHA256: string; reading: TicReleaseReading };
async function sourceCohort(cached: boolean) {
  const policy = JSON.parse(await readFile(resolve(web, "docs/research/tic-treasury-policy-v1.json"), "utf8"));
  if (policy.sha256 !== policyHash || sha(JSON.stringify(policy.policy, Object.keys(policy.policy).sort())) !== policyHash ||
      policy.policy.method !== method || !Number.isFinite(Date.parse(policy.registeredAt))) throw new Error("TIC policy changed");
  const releases: Record<string, string> = JSON.parse(await readFile(resolve(web, "docs/research/tic-treasury-releases-v1.json"), "utf8"));
  const dates = Object.keys(releases).sort();
  if (dates.length !== 129 || new Set(Object.values(releases)).size !== dates.length) throw new Error("TIC original census changed");
  const sessions = extendedResearchSessions(policy.policy.fromTarget, policy.policy.throughTarget);
  const targets: Target[] = [], excluded: { day: string; key: string; reason: string; originalSHA256: string }[] = [];
  for (let i = 0; i < dates.length; i += 3) {
    const batch = await Promise.all(dates.slice(i, i + 3).map(async day => ({ day, key: releases[day],
      original: await original(releases[day], cached, policy.registeredAt) })));
    for (const { day, key, original: source } of batch) {
      let reading;
      try { reading = parseTicRelease(source.text); }
      catch (error) {
        if (!conflicts.has(key) || !(error instanceof Error) || error.message !== "TIC monthly, trailing-year or units header differs") throw error;
        excluded.push({ day, key, reason: error.message, originalSHA256: source.sha256 });
        continue;
      }
      if (conflicts.has(key) || reading.releasedAt.slice(0, 10) !== day) throw new Error("Treasury date differs from sealed source census " + key);
      const target = sessions.find(d => d > day);
      if (!target) continue;
      const session = extendedResearchSession(target)!;
      if (!isFullKibotSession(session.openAt, session.closeAt)) {
        excluded.push({ day, key, reason: "next session was shortened", originalSHA256: source.sha256 });
        continue;
      }
      targets.push({ day: target, key, originalSHA256: source.sha256, reading });
    }
  }
  if (new Set(targets.map(t => t.day)).size !== targets.length || new Set(targets.map(t => t.reading.observationMonth)).size !== targets.length)
    throw new Error("Duplicate TIC release month or target");
  return { policyHash, clock: TIC_RELEASE_CLOCK, targets, excluded };
}

async function targetPrices(days: string[], cached: boolean, splitAdjusted: boolean) {
  const result: ResearchPriceReceipt[] = [], shared = resolve(web, ".consensus/private-technical-momentum");
  for (const year of new Set(days.map(d => d.slice(0, 4)))) {
    const requested = days.filter(d => d.startsWith(year));
    const full = extendedResearchSessions(year + "-01-01", year + "-12-31");
    const name = ["TLT", year, full[0], full.at(-1), splitAdjusted ? "splits" : "raw"].join("-") + ".json";
    const reusable = await lstat(resolve(shared, name)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false; throw error;
    });
    result.push(...await collectResearchPrices(reusable ? shared : directory, "TLT", reusable ? full : requested,
      { cachedOnly: cached || reusable, splitAdjusted }));
  }
  return result;
}

export function ticTrainingRows(targets: Target[], raw: ResearchPriceReceipt[], split: ResearchPriceReceipt[]) {
  const index = (captures: ResearchPriceReceipt[]) => new Map(captures.flatMap(r => r.sessions.map(b => [b.session, b] as const)));
  const rawByDay = index(raw), splitByDay = index(split);
  return targets.map(({ day, reading }): TrainingRow => {
    const asTraded = rawByDay.get(day), adjusted = splitByDay.get(day), session = extendedResearchSession(day)!;
    const issuedAt = newYorkTimestamp(day.replaceAll("-", "") + "T074800")!;
    if (!asTraded || !adjusted || asTraded.openAt !== session.openAt || adjusted.closeAt !== session.closeAt ||
        reading.releasedAt >= issuedAt || issuedAt >= session.openAt ||
        Math.sign(asTraded.close - asTraded.open) !== Math.sign(adjusted.close - adjusted.open))
      throw new Error("TLT price bases or regular session failed on " + day);
    const denominator = reading.grossForeignPurchases + reading.grossForeignSales;
    const netTreasuries = reading.netTreasuryPrivate + reading.netTreasuryOfficial;
    return { id: "TLT:" + day, engineVersion: method, issuedAt, labelKnownAt: session.closeAt,
      features: [100 * (reading.netAll - netTreasuries) / denominator, Number(reading.observationMonth >= "2023-02"),
        100 * netTreasuries / denominator], up: asTraded.close > asTraded.open ? 1 : 0 };
  });
}

async function run(cached: boolean, sourceOnly: boolean) {
  const { history } = await verifyPublicationTree(web), before = history[0].issuedAt;
  const cohort = await sourceCohort(cached), hash = digest(cohort);
  const days = cohort.targets.map(t => t.day), snapshotFile = resolve(directory, "source-cohort.json");
  if (days.some(day => extendedResearchSession(day)!.closeAt >= before) || days.length < 120) throw new Error("Insufficient eligible prelaunch TIC dates");
  const prior = await readResearchReceipt(snapshotFile);
  if (prior && digest(prior) !== hash) throw new Error("Frozen TIC cohort changed");
  if (!prior) {
    if (cached) throw new Error("Missing TIC source seal");
    await durableJSON(snapshotFile, cohort, true);
  }
  const summary = { method, releases: days.length + cohort.excluded.length, eligibleDates: days.length,
    excluded: cohort.excluded.map(r => ({ date: r.day, reason: r.reason })), sourceHash: hash };
  if (sourceOnly) return summary;
  const raw = await targetPrices(days, cached, false), split = await targetPrices(days, cached, true);
  const rows = ticTrainingRows(cohort.targets, raw, split), fitted = trainCandidate(rows, before);
  const control = trainCandidate(rows.map(row => ({ ...row, features: row.features.slice(0, 2) })), before);
  if (fitted.status !== "evaluated" || control.status !== "evaluated" || digest(fitted.split) !== digest(control.split))
    throw new Error("TIC benchmark lacks a common chronological test");
  const coefficient = fitted.model.weights[2], margin = Math.min(control.candidateBrier, fitted.baseRateBrier, fitted.coinBrier) - fitted.candidateBrier;
  const metrics = { train: fitted.split.train, validation: fitted.split.validation, test: fitted.split.test, coefficient,
    candidateBrier: fitted.candidateBrier, controlBrier: control.candidateBrier, baseBrier: fitted.baseRateBrier,
    coinBrier: fitted.coinBrier, clearsResearchMargin: coefficient > 0 && margin > 0.01 };
  const study = { ...summary, policyHash, priceCitation: KIBOT_PRICE_CITATION, before, rowHash: digest(rows),
    prices: [...raw, ...split].map(r => ({ from: r.from, through: r.through, native: r.sha256, rows: r.priceDigest })), fitted, control, metrics };
  const path = resolve(directory, "study.json"), saved = await readResearchReceipt(path);
  if (saved && digest(saved) !== digest(study)) throw new Error("TIC study differs from reproducible input evidence");
  if (!saved) {
    if (cached) throw new Error("Missing initial TIC study receipt");
    await durableJSON(path, study, true);
  }
  return { ...summary, ...metrics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--sources-only", "--cached-only"].includes(arg)) || args.length !== new Set(args).size)
    throw new Error("Usage: consensus:research-tic-treasury [--sources-only] [--cached-only]");
  await durableDirectory(directory, 0o700); await durableDirectory(sources, 0o700);
  const lock = resolve(directory, "study.lock");
  await mkdir(lock, { mode: 0o700 });
  try { console.log(JSON.stringify(await run(args.includes("--cached-only"), args.includes("--sources-only")))); }
  finally { await rmdir(lock); }
}
