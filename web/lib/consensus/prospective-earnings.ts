import { join } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { digest } from "./history.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { collectIssuerGuidance, validateIssuerGuidance, type IssuerGuidanceMatch } from "./issuer-guidance-match.ts";
import type { ExhibitReceipt, SecDocument } from "./issuer-results-source.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { newYorkDate } from "./time.ts";
import type { Signal } from "./types.ts";

export const EARNINGS_ROOT = ".consensus/private-prospective-earnings/v2";
export const EARNINGS_REGISTRATION = EARNINGS_ROOT + "/registration.json";
export const EARNINGS_EARLIEST = "2026-11-24T18:31:08.088Z";
export const EARNINGS_ID = "sec-management-revenue-qqq-prospective-v2";
export const EARNINGS_RULES = [{ id: EARNINGS_ID, family: "earnings", instrument: "QQQ", horizon: "daily", expectedSign: 1 }] as const;
export const EARNINGS_POLICY = {
  version: 2,
  rules: EARNINGS_RULES,
  selection: "Fixed AMD/NVDA semiconductor panel, QQQ only. One independent date: arithmetic mean of all eligible issuer events on the same target session. Original results AND separate statutory confirmation must become public after real registration. Prior guidance precedes period end; its original index and exhibit must be pinned strictly before actual-result SEC acceptance. First exchange session strictly after all original filing/report/NY acceptance dates; exclude early closes, never postpone a missed event. Same-day as-issued public pre-open witness and immutable native proofs required.",
  priceAccess: "Normal verified private production first settlement only, regular open to close. Existing familyTrainingPrefix, reservations, outcome clocks and readApprovedLabels apply before any label is read. No prelaunch replay labels or model fitting.",
  maturity: "Collection only until a separately sealed reserve-before-evaluation plan. At least 500 independent prospective dates and 100 nonoverlapping held-out dates, purged chronological 60/20/20, positive earnings coefficient and >0.01 Brier improvement versus matched age-only, training base and coin, with existing paired significance/alpha spending. No automatic promotion or public vote. Original historical studies, core/retail registrations and holdouts unchanged.",
  definitions: {
    [EARNINGS_ID]: {
      event: "Issuer/fiscal-quarter/original actual and statutory accessions. Pool coincident target dates once; both original EX-99.1 releases and an exact separate original 10-Q consolidated USD quarter must reconcile through the existing issuer parser.",
      candidate: "Arithmetic mean of 100*(reported consolidated quarterly GAAP revenue / original management guidance midpoint - 1), percent. Positive sign predeclared; not analyst expectations or EPS.",
      control: "Arithmetic mean of log1p(calendar days from each original actual 8-K New York acceptance day to this target session), over exactly the same issuer events.",
      rights: "Numerical facts derived from issuer-furnished public SEC filings, attributed to AMD/NVIDIA and SEC EDGAR. Retain original receipts privately for verification; no wholesale issuer-document redistribution or claim that SEC authored the releases.",
      terms: ["https://www.sec.gov/about/webmaster-frequently-asked-questions", "https://www.sec.gov/search-filings/edgar-application-programming-interfaces"],
    },
  },
};
export const EARNINGS_POLICY_SHA256 = "5036105a6c563d70a14d3ad39fef0cf1b5f1aab49a16868c7beabc95219ade72";
if (digest(EARNINGS_POLICY) !== EARNINGS_POLICY_SHA256) throw Error("Changed earnings definitions require a new study version");
const instant = (s: string) => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
type Proof = { file: string; sha256: string };
export type EarningsReason = "outside-earnings-release-target" | "release-predates-registration" | "earnings-confirmation-pending" |
  "native-proof-missing" | "native-proof-mismatch" | "short-earnings-target" | "guidance-not-pinned-before-results";
type Data = { candidate: number; control: number; eventId: string; observedThrough: string; availableAt: string; sourceHashes: string[]; proofs: Proof[] };
const latest = (s: string[]) => [...s].sort().at(-1)!;

/** Read only pinned originals; the existing collector reparses all three filings, including the exact statutory fact. */
export async function replayEarningsSource(root: string, signal: Signal, cutoff: string, pins?: Proof[]) {
  validateIssuerGuidance(signal, cutoff);
  const e = signal.issuerGuidance;
  if (!e || signal.status !== "available" || !instant(cutoff)) throw Error("Unconfirmed original earnings comparison");
  const sourceRoot = ".consensus/private-issuer-revenue";
  const files = [join(sourceRoot, "guidance-matches", `${e.ticker}-${e.end}.json`),
    join(sourceRoot, e.guidance.accession + ".json"), join(sourceRoot, e.results.accession + ".json"),
    join(sourceRoot, e.quarterly.accession + "-quarter.json")];
  const proofs: Proof[] = [];
  async function load<T>(file: string) {
    const value = await readResearchReceipt<T>(join(root, file));
    if (!value) throw Error("Missing original earnings receipt");
    const sha256 = digest(value);
    if (pins && !pins.some(p => p.file === file && p.sha256 === sha256)) throw Error("Changed pinned earnings receipt");
    proofs.push({ file, sha256 });
    return value;
  }
  type First = { catalog: SecDocument; evidence: Omit<IssuerGuidanceMatch, "firstEvidenceCompleteAt" | "publiclyKnownBy"> };
  const first = await load<First>(files[0]), prior = await load<ExhibitReceipt>(files[1]), actual = await load<ExhibitReceipt>(files[2]),
    quarter = await load<{ index: SecDocument; xml: SecDocument }>(files[3]);
  const { firstEvidenceCompleteAt, publiclyKnownBy: _publiclyKnownBy, ...comparison } = e;
  if (digest(first.evidence) !== digest(comparison)) throw Error("First issuer comparison changed");
  const documents = [first.catalog, prior.index, prior.original, actual.index, actual.original, quarter.index, quarter.xml];
  if (documents.some(d => !instant(d.retrievedAt) || d.retrievedAt > cutoff) || latest(documents.map(d => d.retrievedAt)) !== firstEvidenceCompleteAt)
    throw Error("Original earnings capture clock differs");
  const byUrl = new Map(documents.map(d => [d.url, d]));
  const reproduced = await collectIssuerGuidance(e.ticker, async url => {
    const original = byUrl.get(url);
    if (!original) throw Error("Unpinned original SEC URL");
    return original;
  }, () => signal.source.retrievedAt, undefined, signal);
  if (reproduced.status !== "available" || digest(reproduced.issuerGuidance) !== digest(e))
    throw Error("Original earnings filings do not reproduce the as-issued comparison");
  const lastDay = latest([e.guidance.filed, e.results.filed, e.quarterly.filed,
    newYorkDate(e.guidance.acceptedAt), newYorkDate(e.results.acceptedAt), newYorkDate(e.quarterly.acceptedAt),
    prior.filing.reportDate, actual.filing.reportDate, e.end]);
  return { evidence: e, lastDay, proofs, sourceHashes: documents.map(d => d.sha256),
    guidanceFrozenBeforeResults: [prior.index, prior.original].every(d => d.retrievedAt < e.results.acceptedAt) };
}

export async function earningsInput(root: string, signals: readonly Signal[], session: string, cutoff: string, registeredAt: string, pins?: Proof[]): Promise<{ data: Data } | { reason: EarningsReason }> {
  const rows: Data[] = [];
  let old = false;
  for (const ticker of ["AMD", "NVDA"] as const) {
    const s = signals.find(s => s.id === "sec-issuer-guidance-" + ticker.toLowerCase());
    if (!s?.issuerGuidance || s.status !== "available") continue;
    try {
      validateIssuerGuidance(s, cutoff);
      const e = s.issuerGuidance;
      if (e.results.acceptedAt <= registeredAt || e.quarterly.acceptedAt <= registeredAt ||
          e.publiclyKnownBy <= registeredAt || e.firstEvidenceCompleteAt <= registeredAt) { old = true; continue; }
      // Report dates cannot exceed their filing dates (rechecked below in the native collector).
      // Do not demand an unrelated issuer's unrecorded proof when replaying a pinned target.
      const lastDay = latest([e.guidance.filed, e.results.filed, e.quarterly.filed,
        newYorkDate(e.guidance.acceptedAt), newYorkDate(e.results.acceptedAt), newYorkDate(e.quarterly.acceptedAt)]);
      const next = new Date(Date.parse(lastDay) + 86_400_000).toISOString().slice(0, 10);
      const end = new Date(Date.parse(next) + 10 * 86_400_000).toISOString().slice(0, 10);
      const target = exchangeSessions(next, end)[0];
      if (!target) return { reason: "outside-earnings-release-target" };
      if (target !== session) continue;
      const clock = exchangeSession(target)!;
      if (Date.parse(clock.closeAt) - Date.parse(clock.openAt) !== 390 * 60_000) return { reason: "short-earnings-target" };
      const days = (Date.parse(session) - Date.parse(newYorkDate(e.results.acceptedAt))) / 86_400_000;
      if (!(days > 0) || e.firstEvidenceCompleteAt > cutoff) return { reason: "native-proof-mismatch" };
      const verified = await replayEarningsSource(root, s, cutoff, pins);
      if (verified.lastDay !== lastDay) return { reason: "native-proof-mismatch" };
      if (!verified.guidanceFrozenBeforeResults) return { reason: "guidance-not-pinned-before-results" };
      rows.push({ candidate: 100 * (e.actualMillions / e.midpointMillions - 1), control: Math.log1p(days),
        eventId: `${ticker}:${e.end}:${e.results.accession}:${e.quarterly.accession}`,
        observedThrough: latest([e.results.acceptedAt, e.quarterly.acceptedAt]), availableAt: e.firstEvidenceCompleteAt,
        sourceHashes: verified.sourceHashes, proofs: verified.proofs });
    } catch { return { reason: "native-proof-mismatch" }; }
  }
  if (!rows.length) return { reason: old ? "release-predates-registration" : signals.some(s => s.family === "earnings" && s.status === "not_formed") ?
    "earnings-confirmation-pending" : "outside-earnings-release-target" };
  return { data: { candidate: rows.reduce((s, r) => s + r.candidate, 0) / rows.length, control: rows.reduce((s, r) => s + r.control, 0) / rows.length,
    eventId: rows.map(r => r.eventId).join("|"), observedThrough: latest(rows.map(r => r.observedThrough)),
    availableAt: latest(rows.map(r => r.availableAt)), sourceHashes: rows.flatMap(r => r.sourceHashes), proofs: rows.flatMap(r => r.proofs) } };
}

/** The wall clock is deliberately not injectable through a CLI or production argument. */
export async function registerEarningsStudy(root: string) {
  const registeredAt = new Date().toISOString();
  if (registeredAt < EARNINGS_EARLIEST) throw Error("Earnings registration precedes the sealed design");
  const file = join(root, EARNINGS_REGISTRATION);
  const record = { version: 1, policySha256: EARNINGS_POLICY_SHA256, registeredAt, policy: EARNINGS_POLICY };
  let saved = await readResearchReceipt<typeof record>(file);
  if (!saved) {
    await durableDirectory(join(root, EARNINGS_ROOT), 0o700);
    try { await durableJSON(file, record, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    saved = await readResearchReceipt<typeof record>(file);
  }
  if (!saved || saved.version !== 1 || saved.policySha256 !== EARNINGS_POLICY_SHA256 || digest(saved.policy) !== EARNINGS_POLICY_SHA256 ||
      !instant(saved.registeredAt) || saved.registeredAt < EARNINGS_EARLIEST || saved.registeredAt > new Date().toISOString())
    throw Error("Earnings registration changed or has an invalid original clock");
  return saved;
}
