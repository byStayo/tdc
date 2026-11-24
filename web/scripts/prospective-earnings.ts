import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { earningsStudy } from "../lib/consensus/earnings-study.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { EARNINGS_POLICY_SHA256, EARNINGS_ROOT, earningsInput, registerEarningsStudy, replayEarningsSource } from "../lib/consensus/prospective-earnings.ts";
import { readProspectiveFamilyFeatures, recordProspectiveFamilyFeatures } from "../lib/consensus/prospective-family-features.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { matchGuidedQuarter, readIssuerReportedRevenue, readIssuerRevenue, filingIndex, exhibitURL } from "../lib/consensus/issuer-revenue.ts";
import { verifySecDocument, type ExhibitReceipt } from "../lib/consensus/issuer-results-source.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { validateIssuerGuidance } from "../lib/consensus/issuer-guidance-match.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const [action, ...args] = process.argv.slice(2);
if (!action || !["register", "record", "status", "advance", "source-replay"].includes(action) ||
    (["register", "status", "advance"].includes(action) ? args.length !== 0 : args.length !== 2))
  throw Error("Usage: prospective-earnings.ts register|status|advance; record YYYY-MM-DD EDITION; source-replay SOURCE_WEB_ROOT EDITION");

async function sourceReplay(sourceRoot: string, edition: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition)) throw Error("Invalid earnings archive identity");
  const observed = new Date().toISOString();
  const file = join(root, EARNINGS_ROOT, "source-replays", edition + ".json");
  type Stored = { capturedAt: string; value: Record<string, unknown> & { currentSession: string; realEnrolledFeatureRows: number }; sha256: string };
  const saved = await readResearchReceipt<Stored>(file);
  if (saved && (saved.capturedAt > observed || saved.sha256 !== digest(saved.value))) throw Error("Changed original earnings replay receipt");
  const snapshot: Snapshot = JSON.parse(await readFile(join(sourceRoot, "public/consensus", edition + ".json"), "utf8"));
  validateSnapshot(snapshot, "archive");
  if (snapshot.id !== edition || snapshot.issuedAt > observed || snapshot.cutoff > observed) throw Error("Source replay requires an already issued archive");
  const registration = await readResearchReceipt<{ registeredAt: string; policySha256: string }>(join(root, EARNINGS_ROOT, "registration.json"));
  if (!registration || registration.policySha256 !== EARNINGS_POLICY_SHA256) throw Error("Register the real earnings policy before source replay");
  const sources = [];
  for (const ticker of ["AMD", "NVDA"] as const) {
    const s = snapshot.signals.find(s => s.id === "sec-issuer-guidance-" + ticker.toLowerCase());
    if (!s) { sources.push({ ticker, status: "as-issued-input-unavailable" }); continue; }
    validateIssuerGuidance(s, snapshot.cutoff);
    if (s.status === "available" && s.issuerGuidance) {
      const native = await replayEarningsSource(sourceRoot, s, snapshot.cutoff);
      sources.push({ ticker, status: "verified-original-comparison", evidence: native.evidence, proofs: native.proofs,
        sourceHashes: native.sourceHashes, sourceLastDay: native.lastDay,
        guidanceFrozenBeforeResults: native.guidanceFrozenBeforeResults,
        managementMidpointDeviationPct: 100 * (native.evidence.actualMillions / native.evidence.midpointMillions - 1) });
    } else {
      // Verify only two bounded, already-captured original exhibits. This never substitutes for a missing statutory confirmation.
      const directory = join(sourceRoot, ".consensus/private-issuer-revenue");
      const names = (await readdir(directory)).filter(n => /^\d{10}-\d\d-\d{6}\.json$/.test(n));
      if (names.length > 80) throw Error("Bounded original-exhibit scan exceeded 80 receipts");
      const originals: { receipt: ExhibitReceipt; file: string }[] = [];
      for (const name of names) {
        const r = await readResearchReceipt<ExhibitReceipt>(join(directory, name));
        if (r?.filing.ticker !== ticker) continue;
        verifySecDocument(r.index, filingIndex(r.filing), r.filing.acceptedAt);
        verifySecDocument(r.original, exhibitURL(r.filing, r.index.text), r.filing.acceptedAt);
        if (r.original.retrievedAt > snapshot.cutoff || r.index.retrievedAt > snapshot.cutoff) continue;
        originals.push({ receipt: r, file: join(".consensus/private-issuer-revenue", name) });
      }
      const pair = originals.sort((a, b) => a.receipt.filing.acceptedAt.localeCompare(b.receipt.filing.acceptedAt)).slice(-2);
      const matched = pair.length === 2 ? matchGuidedQuarter(readIssuerRevenue(pair[0].receipt.filing, pair[0].receipt.original.text),
        readIssuerReportedRevenue(pair[1].receipt.filing, pair[1].receipt.original.text)) : null;
      sources.push({ ticker, status: s.status, statutoryComparison: "not-confirmed", originalExhibitPair: matched,
        proofs: pair.map(p => ({ file: p.file, sha256: digest(p.receipt) })),
        originals: pair.map(({ receipt: r }) => ({ accession: r.filing.accession, acceptedAt: r.filing.acceptedAt, filed: r.filing.filingDate,
          url: r.original.url, sha256: r.original.sha256, capturedAt: r.original.retrievedAt })) });
    }
  }
  // Replaying an immutable source receipt retains its original assessment date/count;
  // a later wall clock must not turn a source replay into a new enrollment report.
  const assessedSession = saved?.value.currentSession ?? newYorkDate(observed);
  const enrolled = saved?.value.realEnrolledFeatureRows ?? (await readProspectiveFamilyFeatures(root, undefined, "earnings")).rows.length;
  const value = { version: 1, policySha256: EARNINGS_POLICY_SHA256, registrationAt: registration.registeredAt,
    sourceRoot, edition, snapshotSha256: digest(snapshot), asIssuedCutoff: snapshot.cutoff, sources,
    currentSession: assessedSession, currentSourceDecision: await earningsInput(sourceRoot, snapshot.signals, assessedSession, snapshot.cutoff, registration.registeredAt),
    realEnrolledFeatureRows: enrolled, outcomeContentsRead: false, historicalFitsRun: 0,
    scope: "Source-only replay. Original release/capture clocks are retained. Historical originals do not enroll a past or already-public release, predict a future release, or establish prospective performance." };
  await durableDirectory(dirname(file), 0o700);
  if (saved) {
    if (saved.sha256 !== digest(saved.value) || digest(saved.value) !== digest(value)) throw Error("Changed write-once earnings source replay");
  } else await durableJSON(file, { capturedAt: observed, value, sha256: digest(value) }, true);
  return { receipt: file, receiptSha256: digest(saved?.value ?? value), receiptCapturedAt: saved?.capturedAt ?? observed,
    sources: sources.map(s => ({ ticker: s.ticker, status: s.status })),
    currentSourceDecision: value.currentSourceDecision, realEnrolledFeatureRows: enrolled, outcomeContentsRead: false };
}

async function run() {
  if (action === "register") return { source: await registerEarningsStudy(root), study: await earningsStudy.register(root) };
  if (action === "record") return { features: await recordProspectiveFamilyFeatures(root, args[0], args[1], "earnings"), study: await earningsStudy.enroll(root, args[0], args[1]) };
  if (action === "source-replay") return sourceReplay(resolve(args[0]), args[1]);
  return earningsStudy.status(root, action === "advance");
}
if (action === "status") console.log(JSON.stringify(await run(), null, 2));
else {
  const release = await acquirePublicationLock(root, "private-earnings-" + action);
  let failure;
  try { console.log(JSON.stringify(await run(), null, 2)); }
  catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}
