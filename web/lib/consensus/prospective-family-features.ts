import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { BLS_PAYROLL_NEWS_ID, parsePayrollRelease, validateBlsPayrollNews } from "./bls-payroll-news.ts";
import { ETF_CASH_SOURCES } from "./corporate-adjustment.ts";
import { effectiveStatus } from "./engines/v2.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { firstRateTechnicalSignals } from "./firstrate.ts";
import { FIRST_RATE_SYMBOLS, validateFirstRateTechnical } from "./firstrate-technicals.ts";
import { digest, validateSnapshot } from "./history.ts";
import { volatilityWindow, validateMarketHistoryVolatility } from "./market-history-volatility.ts";
import { verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";
import { RETAIL_ID, RETAIL_POLICY, RETAIL_REGISTRATION, RETAIL_ROOT, retailInput } from "./prospective-retail.ts";
import { NYFED_STOCK_OUTLOOK_ID } from "./nyfed-stock-outlook.ts";
import type { Signal, Snapshot } from "./types.ts";

const directory = ".consensus/private-prospective-family-features/v1";
export const FAMILY_FEATURE_REGISTRATION = directory + "/registration.json";
const technical = "firstrate-five-session-momentum-v1", options = "spx-iv-term-band-v1", news = "bls-payroll-revision-v1";
export const PROSPECTIVE_FAMILY_RULES = [
  ...FIRST_RATE_SYMBOLS.map(instrument => ({ id: technical, family: "technicals", instrument, horizon: "daily", expectedSign: 1 } as const)),
  { id: options, family: "options", instrument: "SPY", horizon: "daily", expectedSign: 1 },
  { id: news, family: "news", instrument: "TLT", horizon: "daily", expectedSign: -1 },
] as const;

const policy = {
  version: 1, rules: PROSPECTIVE_FAMILY_RULES,
  selection: "Same-day NY pre-open public witness and registration. Latest witnessed issue for each target. Distinct native event per rule/instrument. Daily only.",
  priceAccess: "The recorder reads pre-existing, prior-session feature evidence only. Future outcomes, reservations, training and fitting are separate.",
  definitions: {
    [technical]: {
      event: "Fund and immediately preceding completed exchange session. Six contiguous reviewed issuer-cash-adjusted FirstRate closes.",
      candidate: "Signed five-session adjusted close change in percentage points, as issued to one decimal.",
      control: "Signed one-session adjusted close change in percentage points, as issued to one decimal.",
      rights: "Both features use FirstRate licensed internal modelling and attributed research. Raw bars stay private.",
      terms: ["https://firstratedata.com/about/license", "https://firstratedata.com/about/FAQ"],
    },
    [options]: {
      event: "S&P 500 implied-volatility indices for the immediately preceding completed exchange session.",
      candidate: "Negative of the as-issued VIX9D/VIX3M band. Lower than 0.95 is +1, above 1.05 is -1, otherwise zero; four machine epsilons at each boundary.",
      control: "As-issued 30-day VIX closing rank versus its prior 60 closes, counting half of ties; 1 + floor(rank / 12), capped at 5.",
      rights: "Both features use Market History API data under section 5 for retained internal model inputs. Public reporting is derived and non-reconstructible. Cboe CSVs are independent checks only.",
      terms: ["https://getmarkethistory.com/docs/terms/", "https://getmarkethistory.com/docs/partners/", "https://getmarkethistory.com/docs/guides/vix-historical-data/"],
    },
    [news]: {
      event: "BLS payroll month and original release. First exchange session strictly after its release date. January benchmark and corrected releases excluded.",
      candidate: "Signed combined two-month payroll revision, in thousands of jobs. Both revisions must reconcile with the preceding original release.",
      control: "Current originally announced headline total nonfarm payroll change, in thousands of jobs.",
      rights: "Both features use public-domain BLS Employment Situation numerical releases with BLS attribution.",
      terms: ["https://www.bls.gov/opub/copyright-information.htm"],
    },
  },
};
export const PROSPECTIVE_FAMILY_DEFINITIONS = policy.definitions;
export const PROSPECTIVE_FAMILY_POLICY_SHA256 = "0d1ba17adb95bc2f45f36d1fd5e9bfcf022db78d3e9900594b39a3d077fe3a79";
if (digest(policy) !== PROSPECTIVE_FAMILY_POLICY_SHA256) throw new Error("Prospective feature definitions changed without a new version");
const earliestRegistration = "2026-11-24T06:01:52.000Z";
export type FeatureLane = "core" | "retail";
export const RETAIL_POLICY_SHA256 = "54329a527bbb38998b4c8e31c901c96c83afb3a257aa8e182071204a4a3213b0";
if (digest(RETAIL_POLICY) !== RETAIL_POLICY_SHA256) throw new Error("SCE feature definitions changed without a new version");
const lanes = {
  core: {
    directory, file: FAMILY_FEATURE_REGISTRATION, hash: PROSPECTIVE_FAMILY_POLICY_SHA256,
    policy, earliest: earliestRegistration,
  },
  retail: {
    directory: RETAIL_ROOT, file: RETAIL_REGISTRATION, hash: RETAIL_POLICY_SHA256,
    policy: RETAIL_POLICY, earliest: "2026-11-24T08:22:32.897Z",
  },
};
type Lane = typeof lanes[FeatureLane];
type Rule = Lane["policy"]["rules"][number];
type Scope = Pick<Rule, "id" | "instrument">;
const inScope = (row: Scope, scope?: Scope) => !scope || (row.id === scope.id && row.instrument === scope.instrument);
type Proof = { file: string; sha256: string };
type Data = { candidate: number; control: number; eventId: string; observedThrough: string; availableAt: string; sourceHashes: string[]; proofs: Proof[] };
type Reason = "as-issued-input-unavailable" | "not-immediately-prior-session" | "outside-payroll-release-target" | "outside-survey-release-target" | "release-predates-registration" | "insufficient-prior-closes" |
  "source-stale-at-entry" | "native-proof-missing" | "native-proof-mismatch" | "superseding-edition-unregistered" | "source-event-already-used";
type Reading = { data: Data } | { reason: Reason };
type Observation = { id: Rule["id"]; instrument: Rule["instrument"] } & Reading;
type Registration = { version: 1; policySha256: string; registeredAt: string; policy: Lane["policy"] };
type Draft = {
  version: 1; policySha256: string; registeredAt: string; session: string; edition: string; cutoff: string;
  issuedAt: string; witnessedAt: string; archiveSha256: string; preparedAt: string; observations: Observation[]
};
type Seal = { version: 1; preparedSha256: string; recordedAt: string };
type Session = {
  session: string; edition: string; status: "recorded" | "missing-latest-registration"; witnessedAt: string;
  recordedAt: string | null; receipts: number
};
type Row = Pick<Rule, "id" | "instrument" | "horizon" | "family"> & Data & Pick<Draft, "session" | "edition" | "cutoff" | "issuedAt" | "witnessedAt" | "policySha256"> & { recordedAt: string };
type Missing = Pick<Rule, "id" | "instrument"> & { session: string; edition: string; reason: Reason };
type Archive = { snapshot: Snapshot; observedAt: string; archiveSha256: string };
const editionPattern = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
const checksum = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const instant = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const wall = () => new Date().toISOString();
const latest = (stamps: string[]) => [...stamps].sort().at(-1)!;
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const bad = (message: string): never => { throw new Error(message); };
const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function files(path: string) {
  try { return (await readdir(path)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function sameDayPreopen(session: string, at: string) {
  const clock = exchangeSession(session);
  return Boolean(clock && instant(at) && newYorkDate(at) === session && at < clock.openAt);
}
function priorSession(session: string) {
  const start = new Date(Date.parse(session) - 10 * 86400000).toISOString().slice(0, 10);
  return exchangeSessions(start, session).at(-2)!;
}
async function publicArchive(root: string, session: string, edition: string, asOf: string): Promise<Archive> {
  if (!editionPattern.test(edition) || !exchangeSession(session)) bad("Invalid prospective session or edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  const proof = await verifyPreopenWithMorningConfirmation(root, session, edition, bytes, asOf);
  validateSnapshot(snapshot, "archive");
  if (snapshot.id !== snapshot.issuedAt.replace(/[:.]/g, "-")) bad("Invalid as-issued feature archive identity");
  return { snapshot, observedAt: proof.observedAt, archiveSha256: proof.archiveSha256 };
}
async function sourceFile<T>(root: string, file: string) {
  const raw = await readResearchReceipt<T>(join(root, file));
  if (!raw) return null;
  return { raw, proof: { file, sha256: digest(raw) } };
}
async function technicalInput(root: string, s: Signal, rule: Rule, day: string, cutoff: string, pins?: Proof[]): Promise<Reading> {
  validateFirstRateTechnical(s);
  if (s.source.observedAt?.slice(0, 10) !== day) return { reason: "not-immediately-prior-session" };
  const metric = (label: string) => s.metrics.find(m => m.label === label)?.value;
  const candidate = metric("Five-session close change"), control = metric("One-session close change");
  if (candidate === undefined || control === undefined) return { reason: "insufficient-prior-closes" };
  const folder = ".consensus/private-firstrate/approvals";
  const matches = (await files(join(root, folder))).filter(name => name.startsWith(day + "-") && /^\d{4}-\d\d-\d\d-[0-9a-f]{64}\.json$/.test(name) &&
    (!pins || pins.some(p => p.file === join(folder, name))));
  type Approval = Parameters<typeof firstRateTechnicalSignals>[0];
  for (const filename of matches) {
    try {
      const stored = await sourceFile<{ approval: Approval; sha256: string }>(root, join(folder, filename));
      if (!stored) continue;
      const { approval, sha256 } = stored.raw;
      if (approval.schemaVersion !== 1 || !instant(approval.approvedAt) || approval.approvedAt > cutoff || approval.through !== day ||
        approval.issuers.some(i => i.source !== ETF_CASH_SOURCES[i.symbol]) ||
        sha256 !== digest(approval) || filename !== day + "-" + digest({ ...approval, approvedAt: null }) + ".json") continue;
      const orig = firstRateTechnicalSignals(approval, cutoff).find(o => o.id === s.id);
      if (!orig || !equal(orig.source, s.source) || !equal(orig.metrics, s.metrics) || !equal(orig.series, s.series)) continue;
      const component = approval.symbols.find(a => a.symbol === rule.instrument)!;
      const issuer = approval.issuers.find(a => a.symbol === rule.instrument)!;
      if ([component.proof.comparison, component.proof.splitComparison].some(values => !values.length || !values.every(checksum))) continue;
      return {
        data: {
          candidate, control, eventId: "firstrate:" + rule.instrument + ":" + day, observedThrough: s.source.observedAt!,
          availableAt: latest([s.source.retrievedAt, approval.approvedAt]), sourceHashes: [s.source.sha256!, component.proof.source.sha256, issuer.sha256,
          ...component.proof.comparison, ...component.proof.splitComparison],
          proofs: [stored.proof]
        }
      };
    } catch { continue; }
  }
  return { reason: matches.length ? "native-proof-mismatch" : "native-proof-missing" };
}
type IndexSymbol = "VIX" | "VIX9D" | "VIX3M";
type IndexReceipt = {
  retrievedAt: string; capture: Parameters<typeof volatilityWindow>[1];
  comparison: { through: string; sourceHash: string; rowsHash: string; verifiedAt: string; rows: [string, number][] }
};
async function indexProofs(root: string, symbol: IndexSymbol, day: string, cutoff: string, pins?: Proof[]) {
  const folder = ".consensus/private-volatility-indices/" + day;
  const names = (await files(join(root, folder))).filter(name => name.startsWith(symbol + "-checked-") && /^[A-Z0-9]+-checked-[a-f0-9]{64}\.json$/.test(name) &&
    (!pins || pins.some(p => p.file === join(folder, name))));
  const result = [];
  for (const name of names) {
    try {
      const stored = await sourceFile<IndexReceipt>(root, join(folder, name));
      if (!stored) continue;
      const { capture, retrievedAt, comparison: c } = stored.raw;
      const r = volatilityWindow(symbol, capture, retrievedAt);
      if (name !== symbol + "-checked-" + r.sha256 + ".json" || r.day !== day || c.through !== day ||
        !instant(c.verifiedAt) || c.verifiedAt < r.retrievedAt || c.verifiedAt > cutoff || !checksum(c.sourceHash) ||
        !Array.isArray(c.rows) || c.rows.length !== 61 || c.rowsHash !== digest(c.rows) ||
        c.rows.some(([date, n], i) => date !== r.dates[i] || !Number.isFinite(n) || Math.abs(n - r.closes[i]) > 1e-8)) continue;
      result.push({ ...r, retrievedAt: c.verifiedAt, proof: stored.proof, qaSha256: c.sourceHash });
    } catch { continue; }
  }
  return { names, result };
}
async function optionsInput(root: string, term: Signal, rank: Signal, day: string, cutoff: string, pins?: Proof[]): Promise<Reading> {
  validateMarketHistoryVolatility(term); validateMarketHistoryVolatility(rank);
  if ([term, rank].some(s => s.source.observedAt !== day)) return { reason: "not-immediately-prior-session" };
  const [vix, nine, three] = await Promise.all((["VIX", "VIX9D", "VIX3M"] as const).map(symbol => indexProofs(root, symbol, day, cutoff, pins)));
  const c = vix.result.find(r => r.sha256 === rank.source.sha256 && r.vintageAt === rank.source.vintageAt && r.retrievedAt === rank.source.retrievedAt);
  if (c) for (const a of nine.result) for (const b of three.result) {
    if (digest([a.sha256, b.sha256]) !== term.source.sha256 || latest([a.retrievedAt, b.retrievedAt]) !== term.source.retrievedAt ||
      latest([a.vintageAt, b.vintageAt]) !== term.source.vintageAt) continue;
    const ratio = a.closes[60] / b.closes[60], tolerance = 4 * Number.EPSILON;
    const band = ratio < 0.95 - tolerance ? -1 : ratio > 1.05 + tolerance ? 1 : 0;
    const below = c.closes.slice(0, 60).reduce((n, x) => n + (x < c.closes[60] ? 1 : x === c.closes[60] ? 0.5 : 0), 0);
    const control = Math.min(5, 1 + Math.floor(below / 12));
    if (band !== term.series[0].value || control !== rank.series[0].value) continue;
    return {
      data: {
        candidate: -band || 0, control, eventId: "market-history:spx-iv:" + day, observedThrough: exchangeSession(day)!.closeAt,
        availableAt: latest([term.source.retrievedAt, rank.source.retrievedAt]),
        sourceHashes: [a.sha256, b.sha256, c.sha256, a.qaSha256, b.qaSha256, c.qaSha256], proofs: [a.proof, b.proof, c.proof]
      }
    };
  }
  return { reason: [vix, nine, three].some(x => !x.names.length) ? "native-proof-missing" : "native-proof-mismatch" };
}
type Original = { url: string; sha256: string; retrievedAt: string; gzip: string };
async function payrollInput(root: string, s: Signal, session: string, cutoff: string): Promise<Reading> {
  validateBlsPayrollNews(s, cutoff);
  const e = s.blsPayrollNews!;
  const released = newYorkDate(e.releasedAt);
  if (released >= session || exchangeSessions(released, session).filter(d => d > released)[0] !== session)
    return { reason: "outside-payroll-release-target" };
  const folder = ".consensus/private-bls-payroll-news/current-collector";
  const stored = await sourceFile<{ current: Original; previous: Original; firstVerifiedAt: string }>(root, join(folder, "bls-payroll-" + e.period + ".json"));
  if (!stored) return { reason: "native-proof-missing" };
  const { current, previous, firstVerifiedAt } = stored.raw;
  if (firstVerifiedAt !== e.firstVerifiedAt) return { reason: "native-proof-mismatch" };
  const originals = [
    { doc: current, url: s.source.url, sha256: s.source.sha256, period: e.period, releasedAt: e.releasedAt },
    { doc: previous, ...e.previous },
  ];
  const [a, b] = originals.map(({ doc, url, sha256, period, releasedAt }) => {
    if (doc.url !== url || !checksum(sha256) || doc.sha256 !== sha256 || !instant(doc.retrievedAt) ||
      doc.retrievedAt < releasedAt || doc.retrievedAt > firstVerifiedAt) bad("Invalid payroll source clock or identity");
    const bytes = gunzipSync(Buffer.from(doc.gzip, "base64"), { maxOutputLength: 3 * 1024 * 1024 });
    if (shaBytes(bytes) !== sha256) bad("Invalid original payroll document hash");
    let html: string;
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { html = new TextDecoder("windows-1252").decode(bytes); }
    return parsePayrollRelease(html, { url, period, day: newYorkDate(releasedAt) });
  });
  if (a.period !== e.period || a.releasedAt !== e.releasedAt || a.combined !== e.combined || a.headline !== e.headline || !equal(a.revisions, e.revisions) ||
    b.period !== e.previous.period || b.releasedAt !== e.previous.releasedAt || b.headline !== e.previous.headline ||
    b.revisions[1].after !== e.previous.olderRevised || a.revisions[0].period !== b.revisions[1].period ||
    a.revisions[0].before !== b.revisions[1].after || a.revisions[1].before !== b.headline) return { reason: "native-proof-mismatch" };
  return {
    data: {
      candidate: e.combined / 1000, control: e.headline / 1000, eventId: "bls:payroll:" + e.period,
      observedThrough: e.releasedAt, availableAt: latest([e.firstVerifiedAt, s.source.retrievedAt]), sourceHashes: [current.sha256, previous.sha256], proofs: [stored.proof]
    }
  };
}
async function reading(root: string, snapshot: Snapshot, rule: Rule, session: string, registeredAt: string, pins?: Proof[]): Promise<Reading> {
  const ids = rule.id === technical ? ["firstrate-technical-" + rule.instrument] :
    rule.id === options ? ["market-history-iv-spx-term", "market-history-iv-vix"] : rule.id === RETAIL_ID ? [NYFED_STOCK_OUTLOOK_ID] : [BLS_PAYROLL_NEWS_ID];
  const signals = ids.map(id => snapshot.signals.find(s => s.id === id));
  if (signals.some(s => !s || s.status !== "available")) return { reason: "as-issued-input-unavailable" };
  try {
    for (const s of signals as Signal[]) {
      if (s.family !== rule.family || !s.instruments.includes(rule.instrument) || !instant(s.source.retrievedAt) ||
        s.source.retrievedAt > snapshot.cutoff || !checksum(s.source.sha256)) return { reason: "native-proof-mismatch" };
    }
    const day = priorSession(session);
    let result: Reading;
    if (rule.id === technical) result = await technicalInput(root, signals[0]!, rule, day, snapshot.cutoff, pins);
    else if (rule.id === options) result = await optionsInput(root, signals[0]!, signals[1]!, day, snapshot.cutoff, pins);
    else if (rule.id === RETAIL_ID) result = await retailInput(root, signals[0]!, session, snapshot.cutoff, registeredAt);
    else result = await payrollInput(root, signals[0]!, session, snapshot.cutoff);
    if ("data" in result) {
      const value = result.data;
      if (![value.candidate, value.control].every(Number.isFinite) || !value.sourceHashes.every(checksum) ||
        !instant(value.observedThrough) || !instant(value.availableAt) || value.observedThrough > value.availableAt || value.availableAt > snapshot.cutoff)
        return { reason: "native-proof-mismatch" };
      const target = exchangeSession(session)!;
      if (signals.some(s => effectiveStatus(s!, snapshot.cutoff) !== "available" || effectiveStatus(s!, target.openAt) !== "available"))
        return { reason: "source-stale-at-entry" };
    }
    return result;
  } catch { return { reason: "native-proof-mismatch" }; }
}

async function firstWrite<T>(file: string, value: T) {
  await durableDirectory(dirname(file), 0o700);
  try { await durableJSON(file, value, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return await readResearchReceipt<T>(file) ?? bad("Immutable feature receipt disappeared");
}
function verifyRegistration(r: Registration, now: string, lane: Lane) {
  if (!r || r.version !== 1 || r.policySha256 !== lane.hash || !equal(r.policy, lane.policy) ||
    !instant(r.registeredAt) || r.registeredAt < lane.earliest || r.registeredAt > now || !sameDayPreopen(newYorkDate(r.registeredAt), r.registeredAt))
    bad("Prospective feature registration differs from its original policy or pre-open clock");
  return r;
}
const draftFile = (root: string, session: string, edition: string, lane: Lane) => join(root, lane.directory, "sessions", session, edition + ".json");
const sealFile = (root: string, session: string, edition: string, lane: Lane) => join(root, lane.directory, "sessions", session, edition + ".seal.json");
async function assertLedgerClock(root: string, session: string, now: string, lane: Lane) {
  const path = join(root, lane.directory, "sessions");
  if ((await files(path)).some(name => /^\d{4}-\d\d-\d\d$/.test(name) && name > session))
    bad("A later prospective session is already present on the feature ledger");
  for (const name of await files(join(path, session))) {
    if (!name.endsWith(".seal.json")) continue;
    const seal = await readResearchReceipt<Seal>(join(path, session, name));
    const observedAt = wall();
    if (!seal || !instant(seal.recordedAt) || observedAt < now || seal.recordedAt > observedAt)
      bad("The feature ledger was observed after the registration clock");
  }
}
async function replay(root: string, archive: Archive, registration: Registration, session: string, asOf: string, lane: Lane, scope?: Scope) {
  const { snapshot, observedAt, archiveSha256 } = archive, edition = snapshot.id;
  const seal = await readResearchReceipt<Seal>(sealFile(root, session, edition, lane));
  if (!seal) return null;
  const draft = await readResearchReceipt<Draft>(draftFile(root, session, edition, lane));
  if (!draft || seal.version !== 1 || seal.preparedSha256 !== digest(draft) || draft.version !== 1 ||
    draft.policySha256 !== registration.policySha256 || draft.registeredAt !== registration.registeredAt ||
    draft.session !== session || draft.edition !== edition || draft.cutoff !== snapshot.cutoff || draft.issuedAt !== snapshot.issuedAt ||
    draft.witnessedAt !== observedAt || draft.archiveSha256 !== archiveSha256 || !sameDayPreopen(session, observedAt) ||
    !sameDayPreopen(session, draft.preparedAt) || !sameDayPreopen(session, seal.recordedAt) || draft.preparedAt < registration.registeredAt ||
    draft.preparedAt < observedAt || seal.recordedAt < draft.preparedAt || seal.recordedAt > asOf ||
    !Array.isArray(draft.observations) || draft.observations.length !== lane.policy.rules.length)
    return bad("Prospective record differs from the sealed public witness, registration or market clock");
  for (const [i, o] of draft.observations.entries()) {
    const rule = lane.policy.rules[i];
    if (o.id !== rule.id || o.instrument !== rule.instrument || ("reason" in o) === ("data" in o))
      bad("Invalid prospective feature identity");
    // A missing source at registration can never become a historical feature after recovery.
    if ("data" in o && inScope(o, scope)) {
      const fresh = await reading(root, snapshot, rule, session, registration.registeredAt, o.data.proofs);
      if (!("data" in fresh) || !equal(fresh.data, o.data)) bad("Sealed native input no longer reproduces its registered feature");
    }
  }
  return { draft, seal };
}

/** The caller has just verified the live edition. No parameter can override the registration or sealing clock. */
export async function recordProspectiveFamilyFeatures(root: string, session: string, edition: string, which: FeatureLane = "core") {
  const lane = lanes[which];
  const start = wall();
  if (start < lane.earliest || !sameDayPreopen(session, start)) bad("Registration requires a real same-day wall clock strictly before the NY open");
  const archive = await publicArchive(root, session, edition, start), { snapshot, observedAt, archiveSha256 } = archive;
  if (!sameDayPreopen(session, observedAt)) bad("Feature registration needs a same-day public pre-open witness");
  const registeredAt = wall();
  if (!sameDayPreopen(session, registeredAt) || registeredAt < start) bad("Feature registration crossed its clock boundary");
  const regFile = join(root, lane.file);
  const saved = await readResearchReceipt<Registration>(regFile);
  const registration = verifyRegistration(saved ?? await firstWrite<Registration>(regFile,
    { version: 1, policySha256: lane.hash, registeredAt, policy:lane.policy }), wall(), lane);
  await assertLedgerClock(root, session, wall(), lane);
  let completed = await replay(root, archive, registration, session, wall(), lane);
  if (!completed) {
    const observations = await Promise.all(lane.policy.rules.map(async rule => ({
      id: rule.id, instrument: rule.instrument, ...await reading(root, snapshot, rule, session, registration.registeredAt),
    })));
    const preparedAt = wall();
    if (!sameDayPreopen(session, preparedAt) || preparedAt < latest([registeredAt, observedAt, registration.registeredAt]))
      bad("Feature preparation crossed its pre-open registration boundary");
    const draft = await firstWrite<Draft>(draftFile(root, session, edition, lane), {
      version: 1, policySha256: registration.policySha256,
      registeredAt: registration.registeredAt, session, edition, cutoff: snapshot.cutoff, issuedAt: snapshot.issuedAt, witnessedAt: observedAt,
      archiveSha256, preparedAt, observations
    });
    const recordedAt = wall();
    if (!sameDayPreopen(session, recordedAt) || recordedAt < preparedAt || draft.preparedAt > recordedAt ||
      draft.registeredAt !== registration.registeredAt || draft.archiveSha256 !== archiveSha256 ||
      draft.witnessedAt !== observedAt || draft.policySha256 !== registration.policySha256 || !equal(draft.observations, observations))
      bad("A concurrent feature capture differs or the pre-open sealing window closed");
    await firstWrite<Seal>(sealFile(root, session, edition, lane), { version: 1, preparedSha256: digest(draft), recordedAt });
    completed = await replay(root, archive, registration, session, wall(), lane);
  }
  if (!completed) return bad("Prospective feature receipt did not become durable");
  const missing = completed.draft.observations.flatMap(o => "reason" in o ? [{ id: o.id, instrument: o.instrument, reason: o.reason }] : []);
  return {
    session, edition, policySha256: registration.policySha256, registeredAt: registration.registeredAt,
    witnessedAt: observedAt, recordedAt: completed.seal.recordedAt, available: completed.draft.observations.length - missing.length, missing
  };
}

/** Verify the entire as-issued draft and seal, and replay the native sources for the requested original comparisons. */
export async function readSealedFamilySession(root: string, session: string, edition: string, which: FeatureLane, scope?: Scope) {
  const lane = lanes[which];
  if (scope && !lane.policy.rules.some(rule => inScope(rule, scope))) return [];
  const now = wall(), raw = await readResearchReceipt<Registration>(join(root, lane.file));
  if (!raw) return [];
  const registration = verifyRegistration(raw, now, lane);
  const archive = await publicArchive(root, session, edition, now);
  const saved = await replay(root, archive, registration, session, now, lane, scope);
  if (!saved) return [];
  return saved.draft.observations.flatMap(o => "data" in o && inScope(o, scope) ? [{
    id: o.id, instrument: o.instrument, session, edition, issuedAt: saved.draft.issuedAt,
    witnessedAt: saved.draft.witnessedAt, recordedAt: saved.seal.recordedAt,
    sourceSeal: digest({ draft: saved.seal.preparedSha256, data: o.data }), ...o.data,
  }] : []);
}

/** Preserve the original SCE row shape, data and seal. */
export function readSealedRetailSession(root: string, session: string, edition: string) {
  return readSealedFamilySession(root, session, edition, "retail");
}

/** Replay exact public witnesses and bounded provider receipts without consulting outcomes or promoting any signal. */
export async function readProspectiveFamilyFeatures(root: string, through?: string, which: FeatureLane = "core") {
  const lane = lanes[which];
  const now = wall(), last = through ?? newYorkDate(now);
  if (!/^\d{4}-\d\d-\d\d$/.test(last) || !Number.isFinite(Date.parse(last)) ||
    new Date(last).toISOString().slice(0, 10) !== last || last > newYorkDate(now)) bad("Invalid prospective replay date");
  const registration = await readResearchReceipt<Registration>(join(root, lane.file));
  const sessions: Session[] = [], rows: Row[] = [], missing: Missing[] = [];
  const summary = { registeredAt: registration?.registeredAt ?? null, policySha256: lane.hash, sessions, rows, missing };
  if (!registration) return summary;
  verifyRegistration(registration, now, lane);
  const witnesses = join(root, ".consensus/private-preopen"), records = join(root, lane.directory, "sessions");
  const days = [...new Set([...(await files(witnesses)), ...(await files(records))])].sort();
  const events = new Set<string>();
  for (const session of days.filter(s => /^\d{4}-\d\d-\d\d$/.test(s) && s >= newYorkDate(registration.registeredAt) && s <= last)) {
    const names = (await files(join(witnesses, session))).filter(n => n.endsWith(".json") && editionPattern.test(n.slice(0, -5)));
    const seals = (await files(join(records, session))).filter(n => n.endsWith(".seal.json"));
    if (seals.some(n => !names.includes(n.slice(0, -10) + ".json"))) bad("A sealed prospective feature lost its public witness");
    const sameDay: { archive: Archive; entry: Awaited<ReturnType<typeof replay>> }[] = [];
    for (const name of names) {
      const archive = await publicArchive(root, session, name.slice(0, -5), now);
      if (!sameDayPreopen(session, archive.observedAt)) {
        if (seals.includes(name.slice(0, -5) + ".seal.json")) bad("A sealed feature lost its same-day public witness");
        continue;
      }
      const entry = await replay(root, archive, registration, session, now, lane);
      sameDay.push({ archive, entry });
    }
    const selected = sameDay.sort((a, b) => a.archive.snapshot.issuedAt.localeCompare(b.archive.snapshot.issuedAt)).at(-1);
    if (!selected) continue;
    const edition = selected.archive.snapshot.id, entry = selected.entry;
    sessions.push({
      session, edition, status: entry ? "recorded" : "missing-latest-registration", witnessedAt: selected.archive.observedAt,
      recordedAt: entry?.seal.recordedAt ?? null, receipts: sameDay.filter(s => s.entry).length
    });
    for (const [i, rule] of lane.policy.rules.entries()) {
      const key = { id: rule.id, instrument: rule.instrument, session, edition };
      const observation = entry?.draft.observations[i];
      if (!entry || !observation) { missing.push({ ...key, reason: "superseding-edition-unregistered" }); continue; }
      if ("reason" in observation) { missing.push({ ...key, reason: observation.reason }); continue; }
      const event = JSON.stringify([rule.id, rule.instrument, observation.data.eventId]);
      if (events.has(event)) { missing.push({ ...key, reason: "source-event-already-used" }); continue; }
      events.add(event);
      rows.push({
        ...key, family: rule.family, horizon: rule.horizon, ...observation.data, cutoff: entry.draft.cutoff,
        issuedAt: entry.draft.issuedAt, witnessedAt: entry.draft.witnessedAt, recordedAt: entry.seal.recordedAt, policySha256: entry.draft.policySha256
      });
    }
  }
  return summary;
}
