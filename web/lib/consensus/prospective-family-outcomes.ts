import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { digest, verifyPublicationTree } from "./history.ts";
import { exchangeSession, exchangeSessions, EXCHANGE_CALENDAR, REVIEWED_EXCHANGE_THROUGH, exchangeCalendarVersion } from "./exchange-calendar.ts";
import { outcomeKey, outcomeWindowSessions, SCORING_POLICY, type PriceEvidence } from "./evaluation.ts";
import { firstRatePriceEvidence, loadFirstRatePrices, FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS } from "./firstrate.ts";
import { readQqqAuction } from "./firstrate-nasdaq-auction.ts";
import { licensedSettlementPrices, loadLicensedSettlement, type LicensedSettlement } from "./marketparquet-settlement.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { loadTltSettlement, MARKET_HISTORY_SOURCE } from "./market-history-settlement.ts";
import { PROSPECTIVE_MINIMUM, readReservations, type EvaluationReservation } from "./learning-audit.ts";
import { PUBLIC_OUTCOME_INDEX, PRIVATE_OUTCOME_LEDGER, COMPLETED_EVALUATIONS, EVALUATION_RELEASE_STATE, validateOutcomeIndex } from "./outcome-ledger.ts";
import { assertEvaluationReleaseState } from "./evaluation-transaction.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { PROSPECTIVE_FAMILY_DEFINITIONS, PROSPECTIVE_FAMILY_RULES, readProspectiveFamilyFeatures } from "./prospective-family-features.ts";
import { FAMILIES } from "./registry.ts";
import { HORIZONS, type Instrument, type Outcome, type Snapshot } from "./types.ts";

type Features = Awaited<ReturnType<typeof readProspectiveFamilyFeatures>>;
type Feature = Features["rows"][number];
type Identity = Pick<Outcome, "snapshotId" | "instrument" | "horizon" | "engineVersion">;
type Edition = Pick<Snapshot, "id" | "issuedAt" | "engineVersion" | "cutoff">;
type Superseded = Pick<Identity, "snapshotId" | "instrument" | "horizon"> & { entryAt: string; selectedSnapshotId: string };
type Selection = {policy: string; superseded: Superseded[]};
const fullSessionMs = 390 * 60_000;
const isInstant = (s: string) => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const pairedKey = (id: string, instrument: string) => id + ":" + instrument;
const checksum = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const selectionPath = "public/consensus/outcome-selection.json";
const calendar = exchangeSessions(EXCHANGE_CALENDAR.from, REVIEWED_EXCHANGE_THROUGH);

/** planCandidate needs at least 500 rows and begins validation at floor(n * .6).
 * Count every archive through the physical close, even superseded and model-ineligible
 * editions. Every forecast whose outcome overlaps this session must already have
 * been issued by then. Consequently this bounds each ETF/horizon separately, including
 * charts of older weekly/monthly intervals that extend past the date being examined.
 */
export function familyTrainingPrefix(issued: readonly Edition[], reservations: readonly EvaluationReservation[],
  instrument: Instrument, issuedAt: string, closeAt: string) {
  const priorEditions = issued.filter(entry => entry.issuedAt <= closeAt).length;
  const upperLimit = Math.floor(PROSPECTIVE_MINIMUM * 0.6);
  for (const record of reservations) {
    if (record.instrument !== instrument) continue;
    if (record.testWindows.some(w => w.issuedAt <= closeAt && w.labelKnownAt >= issuedAt)) return "reserved_window";
    if (issuedAt <= record.consumedThrough) return "consumed_window";
  }
  return priorEditions < upperLimit ? "training_prefix" : "possible_validation_or_test";
}

/** Reproduce publication-time selection using identities, without accessing a single label. */
export function prospectiveSelection(editions: readonly Edition[], settled: Identity[], actual: Selection, asOf: string) {
  const byEdition = new Map(editions.map(e => [e.id, e]));
  if (byEdition.size !== editions.length || !isInstant(asOf) ||
      editions.some((e,i) => !isInstant(e.issuedAt) || e.issuedAt > asOf || (i > 0 && editions[i-1].issuedAt >= e.issuedAt)))
    throw new Error("Unordered or future prospective publication history");
  const bySession = new Map<string, Edition>(), windows = new Map<string, { entry: string; exit: string }>();
  for (const e of editions) for (const h of HORIZONS) {
    const dates = outcomeWindowSessions(e.issuedAt, h, calendar);
    if (!dates.length) continue;
    const entry = exchangeSession(dates[0])!.openAt, exit = exchangeSession(dates.at(-1)!)!.closeAt;
    windows.set(pairedKey(e.id,h), {entry,exit});
    if (h === "daily") bySession.set(dates[0], e);
  }
  validateOutcomeIndex(settled);
  const selected = new Map<string, Identity>(), slots = new Map<string, number>();
  function group(identity: Identity) {
    const window = windows.get(pairedKey(identity.snapshotId,identity.horizon));
    const e = byEdition.get(identity.snapshotId);
    if (!window || !e || identity.engineVersion !== e.engineVersion || window.exit > asOf)
      throw new Error("Production settlement identity differs from the reviewed exchange window or edition");
    return { key: [identity.instrument, identity.horizon, window.entry].join(":"), entryAt: window.entry, e };
  }
  for (const [i,id] of settled.entries()) {
    const { key,e } = group(id), prev = selected.get(key);
    if (!prev || byEdition.get(prev.snapshotId)!.issuedAt < e.issuedAt) selected.set(key,id);
    slots.set(outcomeKey(id),i);
  }
  const superseded: Superseded[] = [];
  for (const id of settled) {
    const { key,entryAt } = group(id), final = selected.get(key)!;
    if (id.snapshotId !== final.snapshotId) superseded.push({snapshotId:id.snapshotId, instrument:id.instrument,
      horizon:id.horizon, entryAt, selectedSnapshotId:final.snapshotId});
  }
  if (actual.policy !== SCORING_POLICY || !Array.isArray(actual.superseded) || digest(superseded) !== digest(actual.superseded))
    throw new Error("Production outcome selection differs from the independently reconstructed identity ledger");
  return { byEdition, bySession, slots };
}

type Request = { slot: number; identity: Identity; issuedAt: string; session: string; openAt: string; closeAt: string };
type Join = "paired" | "price_use_not_verified" | "approved_price_unavailable";
type Pair = { status: "paired"; up: 0 | 1 } | { status: Exclude<Join,"paired"> };
type LabelReader = (requests: Request[]) => Promise<Map<number, Pair>>;
type Reason = "awaiting_close" | "short_session" | "superseded_edition" | "repeated_source_event" | "waiting_for_settlement" |
  "reserved_window" | "consumed_window" | "possible_validation_or_test" | "price_use_not_verified" | "approved_price_unavailable";
type RuleCount = { witnessed: number; mature: number; prefixEligible: number; settled: number; paired: number; missingFeatures: number;
  missingReasons: Record<string, number>; reasons: Partial<Record<Reason,number>> };
const counts = (): RuleCount => ({ witnessed:0, mature:0, prefixEligible:0, settled:0, paired:0, missingFeatures:0, missingReasons:{}, reasons:{} });
const increment = (values: Record<string,number>, key: string) => { values[key] = (values[key] ?? 0) + 1; };

/** The caller supplies the already replayed feature archive. Prices are requested only after all authorization clocks and production windows pass. */
export async function prospectiveFamilyPairCounts(features: Features, editions: readonly Edition[], settled: Identity[],
  selection: Selection, reservations: readonly EvaluationReservation[], asOf: string,
  labelSource: LabelReader | { root: string; transaction: string }) {
  const { byEdition, bySession, slots } = prospectiveSelection(editions,settled,selection,asOf);
  const rules = PROSPECTIVE_FAMILY_RULES.map(rule => ({
    id: rule.id, instrument: rule.instrument, family: rule.family, expectedSign: rule.expectedSign,
    candidate: PROSPECTIVE_FAMILY_DEFINITIONS[rule.id].candidate,
    control: PROSPECTIVE_FAMILY_DEFINITIONS[rule.id].control,
    ...counts(),
  }));
  const tracking = new Map(rules.map(rule => [pairedKey(rule.id, rule.instrument),rule]));
  const events = new Set<string>(), matches = new Map<number,{ request: Request; rows: Feature[] }>();
  if (features.registeredAt && (!isInstant(features.registeredAt) || features.registeredAt > asOf)) throw Error("Invalid prospective feature registration clock");
  for (const m of features.missing) {
    const track = tracking.get(pairedKey(m.id,m.instrument));
    if (!track) throw Error("Unknown prospective missing-feature rule");
    track.missingFeatures++; increment(track.missingReasons,m.reason);
  }
  for (const row of [...features.rows].sort((a,b) => a.session.localeCompare(b.session) || a.issuedAt.localeCompare(b.issuedAt))) {
    const track = tracking.get(pairedKey(row.id,row.instrument)), e = byEdition.get(row.edition);
    const clock = exchangeSession(row.session);
    if (!track || row.family !== track.family || row.horizon !== "daily" || !clock || !e ||
        !features.sessions.some(s => s.status === "recorded" && s.session === row.session && s.edition === row.edition &&
          s.recordedAt === row.recordedAt && s.witnessedAt === row.witnessedAt) ||
        !features.registeredAt || features.registeredAt > row.recordedAt || row.policySha256 !== features.policySha256 ||
        !checksum(features.policySha256) || ![row.observedThrough,row.availableAt,row.cutoff,row.issuedAt,row.witnessedAt,row.recordedAt].every(isInstant) ||
        row.observedThrough > row.availableAt || row.availableAt > row.cutoff ||
        row.issuedAt !== e.issuedAt || row.cutoff !== e.cutoff || row.cutoff > row.issuedAt || row.issuedAt > row.witnessedAt ||
        row.witnessedAt > row.recordedAt || row.recordedAt >= clock.openAt || row.recordedAt > asOf ||
        !row.sourceHashes.length || !row.sourceHashes.every(checksum) || !row.eventId || ![row.candidate,row.control].every(Number.isFinite))
      throw Error("Feature differs from its registered pre-open evidence, original publication or paired predictor");
    track.witnessed++;
    if (asOf <= clock.closeAt) { increment(track.reasons,"awaiting_close"); continue; }
    track.mature++;
    if (Date.parse(clock.closeAt)-Date.parse(clock.openAt) !== fullSessionMs) { increment(track.reasons,"short_session"); continue; }
    if (bySession.get(row.session)?.id !== row.edition) { increment(track.reasons,"superseded_edition"); continue; }
    const event = JSON.stringify([row.id,row.instrument,row.eventId]);
    if (events.has(event)) { increment(track.reasons,"repeated_source_event"); continue; }
    events.add(event);
    const proof = familyTrainingPrefix(editions,reservations,row.instrument,row.issuedAt,clock.closeAt);
    if (proof !== "training_prefix") { increment(track.reasons,proof); continue; }
    track.prefixEligible++;
    const slot = slots.get(outcomeKey({snapshotId:row.edition,instrument:row.instrument,horizon:"daily"}));
    if (slot === undefined) { increment(track.reasons,"waiting_for_settlement"); continue; }
    track.settled++;
    const match = matches.get(slot) ?? {request:{slot,identity:settled[slot],issuedAt:e.issuedAt,...clock},rows:[]};
    match.rows.push(row);
    matches.set(slot,match);
  }
  if (matches.size) {
    const requests = [...matches.values()].map(m=>m.request);
    const values = typeof labelSource === "function" ? await labelSource(requests) :
      await readApprovedLabels(labelSource.root,requests,settled,labelSource.transaction,asOf);
    if (values.size !== matches.size) throw Error("Incomplete verified settlement response");
    for (const [slot, match] of matches) {
      const value = values.get(slot);
      if (!value) throw Error("Missing verified settlement decision");
      for (const row of match.rows) {
        const track = tracking.get(pairedKey(row.id,row.instrument))!;
        if (value.status !== "paired") increment(track.reasons,value.status);
        else {
          if (value.up !== 0 && value.up !== 1) throw Error("Invalid verified directional outcome");
          track.paired++;
        }
      }
    }
  }
  return { asOf, policySha256:features.policySha256, registeredAt:features.registeredAt, sessions:features.sessions.length,
    witnessed:rules.reduce((n,r)=>n+r.witnessed,0), mature:rules.reduce((n,r)=>n+r.mature,0),
    prefixEligible:rules.reduce((n,r)=>n+r.prefixEligible,0), paired:rules.reduce((n,r)=>n+r.paired,0),
    rules, families:FAMILIES.map(family=>{
      const rows=rules.filter(rule=>rule.family===family.id);
      return {family:family.id, comparisons:rows.length, witnessed:rows.reduce((n,r)=>n+r.witnessed,0),
        mature:rows.reduce((n,r)=>n+r.mature,0),paired:rows.reduce((n,r)=>n+r.paired,0),
        status:!rows.length?"no_registered_comparison":!features.registeredAt?"awaiting_registration":rows.some(r=>r.paired)?"paired_training_prefix":
          rows.some(r=>r.witnessed)?"pending_or_excluded":"awaiting_preopen_evidence"};
    }), training:"collection_only" as const };
}

async function ownerFile(path: string) {
  const [file,dir] = await Promise.all([lstat(path),lstat(dirname(path))]);
  if (!file.isFile() || file.mode & 0o077 || !dir.isDirectory() || dir.mode & 0o077)
    throw Error("Owner-only regular settlement evidence required");
  return createInterface({input:createReadStream(path,{ encoding:"utf8" }),crlfDelay:Infinity});
}

/** The completed transaction can contain other outcomes. Read only its path, identity and digest fields. */
async function ledgerSeal(root: string, transaction: string, indexHash: string) {
  if (!/^[a-f0-9-]{36}$/.test(transaction)) throw Error("No completed production outcome transaction");
  const stream = await ownerFile(resolve(root, COMPLETED_EVALUATIONS, transaction + ".json"));
  let id: string | undefined, path: string | undefined;
  const seals = new Map<string,string>();
  for await (const line of stream) {
    if (line.startsWith('  "id": ')) id = JSON.parse(line.trim().slice(6).replace(/,$/,""));
    if (line === "    {" || line === "    }," || line === "    }") path = undefined;
    const dest = /^      "path": "([^"]+)",$/.exec(line);
    if (dest) path = dest[1];
    const after = /^      "after": "([a-f0-9]{64})",?$/.exec(line);
    if (path && after) {
      if (seals.has(path)) throw Error("Duplicate path in completed settlement transaction");
      seals.set(path,after[1]);
    }
  }
  const seal = seals.get(PRIVATE_OUTCOME_LEDGER);
  if (id !== transaction || !checksum(seal) || seals.get(PUBLIC_OUTCOME_INDEX) !== indexHash)
    throw Error("Private price ledger and public identities lack a matching completed transaction");
  return seal;
}

/** durableJSON writes an ordered array with one field per line. Hash every record as
 * opaque canonical JSON; retain and decode only the authorized public-index slots.
 * No protected outcome object is parsed, returned or logged, including on failure.
 */
async function verifiedOutcomeSlots(path: string, seal: string, count: number, slots: Set<number>) {
  const stream = await ownerFile(path);
  const hash = createHash("sha256"), picked = new Map<number,string[]>();
  let index = -1;
  for await (const line of stream) {
    const trimmed = line.trim();
    // Match only the property separator. Whitespace within strings remains significant.
    hash.update(trimmed.replace(/^("(?:[^"\\]|\\.)*"): /,"$1:"));
    if (line === "  {") index++;
    if (slots.has(index) && (line === "  {" || line.startsWith("    ") || line === "  }" || line === "  },")) {
      const lines = picked.get(index) ?? [];
      lines.push(trimmed);
      picked.set(index,lines);
    }
  }
  if (hash.digest("hex") !== seal || index+1 !== count || picked.size !== slots.size) throw Error("Verified outcome ledger changed");
  return picked;
}

const grants = {
  [FIRST_RATE_SOURCE]: "https://firstratedata.com/about/license",
  [MARKET_HISTORY_SOURCE]: "https://getmarkethistory.com/docs/terms/",
  [MARKETPARQUET_SOURCE]: "https://marketparquet.com/license",
} as const;

/** A later cash distribution may rescale an old day. Recover an original, immutable
 * approval with the actual frozen prices; an equal return alone is insufficient.
 */
async function archivedPriceMatch(root: string, source: string, r: Request, asOf: string, exact: (prices:PriceEvidence[])=>boolean) {
  const firstRate = source === FIRST_RATE_SOURCE;
  if (!firstRate && source !== MARKETPARQUET_SOURCE) return false;
  const base = resolve(root,firstRate?".consensus/private-firstrate":".consensus/private-marketparquet");
  const archive = resolve(base,firstRate?"approvals":"settlements");
  let names: string[];
  try { names=await readdir(archive); } catch(error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return false; throw error; }
  for (const name of names.sort()) {
    if (firstRate) {
      if (!/^\d{4}-\d\d-\d\d-[a-f0-9]{64}\.json$/.test(name) || name.slice(0,10)<r.session) continue;
      type Approval=Parameters<typeof firstRatePriceEvidence>[0];
      const original=await readResearchReceipt<{approval:Approval;sha256:string}>(resolve(archive,name));
      if (!original || original.sha256!==digest(original.approval) || name!==original.approval.through+"-"+digest({...original.approval,approvedAt:null})+".json")
        throw Error("Archived FirstRate assessment changed");
      const a=original.approval;
      if (a.approvedAt>asOf || a.from>r.session || a.through<r.session) continue;
      for (const repair of a.symbols.find(s=>s.symbol===r.identity.instrument)?.proof.minuteRepairs ?? []) {
        if (repair.session===r.session && repair.auction && digest(await readQqqAuction(base,r.session,true))!==digest(repair.auction))
          throw Error("Archived FirstRate auction differs from its original");
      }
      if (exact(firstRatePriceEvidence(a))) return true;
    } else {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const review=await readResearchReceipt<LicensedSettlement>(resolve(archive,name));
      if (!review || name!==digest(review)+".json") throw Error("Archived licensed price assessment changed");
      if (review.through>=r.session && review.reconciledAt<=asOf && exact(licensedSettlementPrices(review,asOf))) return true;
    }
  }
  return false;
}

async function readApprovedLabels(root: string, requests: Request[], index: Identity[], transaction: string, asOf: string) {
  const seal = await ledgerSeal(root,transaction,digest(index));
  const captured = await verifiedOutcomeSlots(resolve(root,PRIVATE_OUTCOME_LEDGER),seal,index.length,new Set(requests.map(r=>r.slot)));
  const result = new Map<number, Pair>(), providers = new Map<string, Promise<PriceEvidence[]>>();
  function sourcePrices(source: string) {
    let prices = providers.get(source);
    if (!prices) {
      if (source === FIRST_RATE_SOURCE) prices = (async()=>{
        const path=resolve(root,".consensus/private-firstrate/approved.json");
        const first=await readResearchReceipt<{approval:{approvedAt:string};sha256:string}>(path);
        if (!first || !isInstant(first.approval.approvedAt) || first.approval.approvedAt>asOf) return [];
        const rows=await loadFirstRatePrices(root);
        const last=await readResearchReceipt<{sha256:string}>(path);
        if (last?.sha256!==first.sha256) throw Error("FirstRate approval changed during prospective evaluation");
        return rows;
      })();
      else if (source === MARKETPARQUET_SOURCE) prices = loadLicensedSettlement(root,asOf);
      else prices = loadTltSettlement(root,asOf,()=>{});
      providers.set(source,prices);
    }
    return prices;
  }
  for (const r of requests) {
    const lines = captured.get(r.slot)!;
    const sourceFields = lines.filter(line => line.startsWith('"source": '));
    if (sourceFields.length !== 1) throw Error("Invalid provider identity in authorized settlement");
    const source = JSON.parse(sourceFields[0].slice(10).replace(/,$/,""));
    if (typeof source !== "string" || !Object.hasOwn(grants,source) ||
        (source === FIRST_RATE_SOURCE && !FIRST_RATE_SYMBOLS.some(s=>s===r.identity.instrument)) ||
        (source === MARKET_HISTORY_SOURCE && r.identity.instrument !== "TLT")) {
      result.set(r.slot,{status:"price_use_not_verified"}); continue;
    }
    // These are the production offline readers. The paid archive reader verifies owner
    // entitlement, authorized captures, issuer actions and independent comparisons.
    const official = await sourcePrices(source);
    const targetBars = (prices: PriceEvidence[]) => prices.filter(p=>p.instrument===r.identity.instrument &&
      p.source===source && p.adjustment===OUTCOME_PRICE_BASIS && p.expectedSessions.includes(r.session))
      .flatMap(p=>p.sessions.filter(b=>b.session===r.session && b.openAt===r.openAt && b.closeAt===r.closeAt));
    const bars = targetBars(official);
    // With no qualified source settlement, especially no licensed paid archive, do not decode the price fields.
    if (!bars.length && !await archivedPriceMatch(root,source,r,asOf,prices=>targetBars(prices).length>0)) {
      result.set(r.slot,{status:"approved_price_unavailable"}); continue;
    }
    const row = JSON.parse(lines.join("").replace(/,$/,"")) as Outcome;
    if (outcomeKey(row) !== outcomeKey(r.identity) || row.engineVersion !== r.identity.engineVersion || row.issuedAt !== r.issuedAt ||
        ![row.entry,row.exit].every(n=>Number.isFinite(n) && n>0) || row.entryAt !== r.openAt || row.exitAt !== r.closeAt ||
        row.calendarVersion !== exchangeCalendarVersion(r.session,r.session) || row.adjustment !== OUTCOME_PRICE_BASIS ||
        row.source !== source || !Number.isFinite(row.returnPct) || Math.abs((row.exit/row.entry-1)*100-row.returnPct)>1e-10)
      throw Error("Selected settlement differs from its immutable production identity, basis or regular hours");
    const agrees = (bar: PriceEvidence["sessions"][number]) => bar.open===row.entry && bar.close===row.exit;
    if (!bars.some(agrees) && !await archivedPriceMatch(root,source,r,asOf,prices=>targetBars(prices).some(agrees)))
      throw Error("Approved source disagrees with the selected settlement");
    result.set(r.slot,{status:"paired",up:row.returnPct>0?1:0});
  }
  return result;
}

/** Read-only post-evaluation hook. The current clock cannot be overridden to inspect future or backdated observations. */
export async function auditProspectiveFamilyOutcomes(root: string) {
  await assertEvaluationReleaseState(root);
  const statePath = resolve(root,EVALUATION_RELEASE_STATE);
  const state = JSON.parse(await readFile(statePath,"utf8")) as {
    transactionId:string; outcomeLedgerTransactionId:string; hashes:Record<string,string> };
  const [features,publication,reservations,indexText,selectionText] = await Promise.all([
    readProspectiveFamilyFeatures(root),verifyPublicationTree(root),readReservations(root),
    readFile(resolve(root,PUBLIC_OUTCOME_INDEX),"utf8"),readFile(resolve(root,selectionPath),"utf8"),
  ]);
  const observed = new Date().toISOString(), index: unknown = JSON.parse(indexText), selection = JSON.parse(selectionText) as Selection;
  validateOutcomeIndex(index);
  if (state.hashes[PUBLIC_OUTCOME_INDEX] !== digest(index) || state.hashes[selectionPath] !== digest(selection))
    throw Error("Settlement metadata differs from the completed release");
  const report = await prospectiveFamilyPairCounts(features,publication.snapshots,index,selection,reservations,observed,
    {root,transaction:state.outcomeLedgerTransactionId});
  if (digest(JSON.parse(await readFile(statePath,"utf8"))) !== digest(state) ||
      digest(await readReservations(root)) !== digest(reservations) ||
      digest(JSON.parse(await readFile(resolve(root,"public/consensus/index.json"),"utf8"))) !== digest(publication.history))
    throw Error("A publication, settlement or holdout changed during the prospective audit");
  return { ...report, settlementTransaction:state.transactionId, modelReservations:reservations.length, priceGrants:grants };
}
