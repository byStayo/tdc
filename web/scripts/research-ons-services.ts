import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectResearchPrices, readResearchReceipt, type ResearchPriceReceipt } from "../lib/consensus/research-price-capture.ts";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { parseKibotDaily } from "../lib/consensus/kibot.ts";
import { verifyPublicationTree, digest } from "../lib/consensus/history.ts";
import { ONS_SERVICES_RESEARCH, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { technicalMomentumRows } from "./research-technical-momentum.ts";
import { before, directory, registration, sealedOnsFeatures, sha, web } from "./research-ons-originals.ts";

const expectedFeatures = "f00c43849811c2f61c229a7434ff217ec449ca9a6586e43f57a6e1ecf95a62b2";
const study = ONS_SERVICES_RESEARCH.id;
const privateDir = resolve(web, ".consensus");
const technicalDir = resolve(privateDir, "private-technical-momentum");
const prices = resolve(directory, "prices");
const payrollDir = resolve(privateDir,"private-bls-payroll-news/prices");
const sourceDirs = [technicalDir, resolve(privateDir,"private-tic-treasury-demand"), payrollDir];

async function payrollReceipt(file: string, from: string, through: string, basis: string): Promise<ResearchPriceReceipt> {
  const path = resolve(payrollDir,file);
  const m = await readResearchReceipt<{ticker:string;basis:string;from:string;through:string;sourceSHA256:string}>(path);
  const csv = await readFile(path.slice(0,-5)+".csv");
  if (!m || m.ticker!=="TLT" || m.basis!==basis || m.from!==from || m.through!==through || sha(csv)!==m.sourceSHA256)
    throw Error("TLT comparison differs from the original payroll price receipt");
  const sessions = parseKibotDaily(csv.toString("utf8"),extendedResearchSessions(from,through),extendedResearchSession);
  return {instrument:"TLT",from,through,sha256:m.sourceSHA256,priceDigest:digest(sessions),sessions};
}

async function getPrices(targets: string[], splitAdjusted: boolean, cachedOnly: boolean) {
  const pending = new Set(targets), receipts: ResearchPriceReceipt[] = [];
  for (const folder of sourceDirs) {
    const basis = splitAdjusted ? "splits" : "raw";
    const pattern = new RegExp("^TLT-(20[0-9]{2})-([0-9-]{10})-([0-9-]{10})-" + basis + "\\.json$");
    for (const file of (await readdir(folder)).sort()) {
      const m = pattern.exec(file);
      if (!m || m[2] < "2016-01-01" || m[3] >= before.slice(0,10)) continue;
      const needed = [...pending].filter(day => m[2] <= day && day <= m[3]);
      if (!needed.length) continue;
      const r = folder===payrollDir ? await payrollReceipt(file,m[2],m[3],basis) :
        (await collectResearchPrices(folder, "TLT", [m[2],m[3]], {cachedOnly:true, splitAdjusted}))[0];
      receipts.push(r);
      for (const day of needed) pending.delete(day);
    }
  }
  if (pending.size) {
    await durableDirectory(prices, 0o700);
    receipts.push(...await collectResearchPrices(prices, "TLT", [...pending], {cachedOnly,splitAdjusted}));
  }
  const bars = new Map<string,ResearchPriceReceipt["sessions"][number]>();
  const wanted = new Set(targets);
  for (const r of receipts) for (const bar of r.sessions) {
    if (!wanted.has(bar.session)) continue;
    const earlier = bars.get(bar.session);
    if (earlier && (earlier.open !== bar.open || earlier.close !== bar.close || earlier.closeAt !== bar.closeAt))
      throw Error("Overlapping TLT research captures disagree on " + bar.session);
    bars.set(bar.session,bar);
  }
  return { bars, receipts };
}

type DateRow = { labelKnownAt: string };
async function priorExposures(technicalReceipts: ResearchPriceReceipt[]) {
  const load = async (name: string) => JSON.parse(await readFile(resolve(privateDir,name),"utf8"));
  const targetSet = (rows: DateRow[]) => new Set(rows.map(r => r.labelKnownAt.slice(0,10)));
  const technical = await load("private-technical-momentum/prelaunch-technical-momentum-volatility-v1.json");
  const prior = technical.cohorts.find((c: {instrument:string}) => c.instrument === "TLT");
  const retained = technicalReceipts.filter(r => prior.raw.includes(r.sha256)).sort((a,b) => a.from.localeCompare(b.from));
  const technicalRows = technicalMomentumRows("TLT",retained.flatMap(r => r.sessions),before);
  if (retained.length !== prior.raw.length || technicalRows.length !== prior.candidate.samples)
    throw Error("Previous TLT technical exposure differs from its recorded sample");
  const payroll = await load("private-bls-payroll-news/sealed-study.json");
  const cpi = await load("private-november-price-repair/nov19/bls-cpi-tlt/result.json");
  const tic = await load("private-tic-treasury-demand/source-cohort.json");
  const cftc = await load("private-cftc-options/prelaunch-tff-option-positioning-v1.json");
  const nyfed = await load("private-nyfed-nowcast/prelaunch-nyfed-nowcast-revisions-2023-2026-v1.json");
  const fund = (c: {instrument:string}) => c.instrument === "TLT";
  return { technical:targetSet(technicalRows), payroll:targetSet(payroll.rows), usCpi:targetSet(cpi.rows),
    treasuryCapital:new Set<string>(tic.targets.map((t: {day:string}) => t.day)),
    futuresOptions:targetSet(cftc.cohorts.find(fund).training),
    nowcast:targetSet(nyfed.cohorts.find(fund).pairs.map((p: {training:DateRow}) => p.training)) };
}

function blockInterval(differences: number[]) {
  let seed = parseInt(registration.slice(0,8),16);
  const means: number[] = [];
  for (let sample = 0; sample < 10000; sample++) {
    let total = 0, count = 0;
    while (count < differences.length) {
      seed = (Math.imul(1664525,seed) + 1013904223) >>> 0;
      const first = Math.floor(seed / 4294967296 * (differences.length - 2));
      for (let j = 0; j < 3 && count < differences.length; j++, count++) total += differences[first+j];
    }
    means.push(total/count);
  }
  means.sort((a,b) => a-b);
  return [means[249],means[9749]];
}

export async function replayOnsStudy(collect = false) {
  const {result:features,featureSeal} = await sealedOnsFeatures();
  if (featureSeal !== expectedFeatures || features.eligible.length < 120)
    throw Error("ONS research must reproduce the independently sealed pre-price feature cohort");
  const {history} = await verifyPublicationTree(web);
  if (history[0]?.issuedAt !== before) throw Error("First public issue differs from the registered study cutoff");
  const targets = features.eligible.map(r => r.target);
  const raw = await getPrices(targets,false,!collect), splits = await getPrices(targets,true,!collect);
  const rows: TrainingRow[] = [], excluded: {target:string;reason:string}[] = [];
  for (const f of features.eligible) {
    const bar = raw.bars.get(f.target), control = splits.bars.get(f.target);
    if (!bar || !control || Math.sign(bar.close-bar.open) !== Math.sign(control.close-control.open)) {
      excluded.push({target:f.target,reason:"Missing or conflicting outcome on raw and split-only series"}); continue;
    }
    if (bar.openAt !== control.openAt || bar.closeAt !== control.closeAt || bar.openAt !== f.openAt || bar.closeAt !== f.closeAt ||
        !(f.current.availableAt < f.decision && f.decision < bar.openAt && bar.closeAt < before))
      throw Error("ONS publication and TLT session clocks disagree");
    rows.push({id:"TLT:"+f.target,engineVersion:study,issuedAt:f.decision,labelKnownAt:bar.closeAt,
      features:[f.headlineChange,f.servicesChange],up:bar.close > bar.open ? 1 : 0});
  }
  const split = chronologicalSplit(rows);
  if (rows.length < 120 || split.train.length < 50 || split.validation.length < 20 || split.test.length < 20 ||
      Object.values(split).some(fold => new Set(fold.map(r => r.up)).size < 2))
    throw Error("TLT research pairs do not meet the preregistered sample and variation gates");
  const candidate = trainCandidate(rows,before), control = trainCandidate(rows.map(r => ({...r,features:r.features.slice(0,1)})),before);
  if (candidate.status !== "evaluated" || control.status !== "evaluated" || digest(candidate.split) !== digest(control.split))
    throw Error("The candidate and its headline-only control require identical chronological folds");
  const predictions = split.test.map(r => ({id:r.id,observed:r.up,headline:predict(control.model,r.features.slice(0,1)),
    combined:predict(candidate.model,r.features)}));
  const paired = predictions.map(p => (p.headline-p.observed)**2 - (p.combined-p.observed)**2);
  const exposures = await priorExposures(raw.receipts);
  function overlap(fold: TrainingRow[]) {
    const dates = fold.map(r => r.labelKnownAt.slice(0,10));
    return { ...Object.fromEntries(Object.entries(exposures).map(([k,v]) => [k,dates.filter(d => v.has(d)).length])),
      anyOfSix:dates.filter(d => Object.values(exposures).some(v => v.has(d))).length };
  }
  const summary = {verifiedDates:targets.length,paired:rows.length,split:candidate.split,candidate:candidate.candidateBrier,
    headline:control.candidateBrier,trainingRate:candidate.baseRateBrier,coin:candidate.coinBrier,
    servicesCoefficient:candidate.model.weights[1],controlImprovement95:blockInterval(paired),
    clearsRegisteredScreen:candidate.model.weights[1]<0 && Math.min(control.candidateBrier,candidate.baseRateBrier,candidate.coinBrier)-candidate.candidateBrier>.01,
    previousStudies:{all:overlap(rows),test:overlap(split.test)}};
  const witness = (r: ResearchPriceReceipt) => ({from:r.from,through:r.through,sha256:r.sha256,priceDigest:r.priceDigest});
  const result = {study,before,registration,featureSeal,summary,excluded,rows,predictions,candidateModel:candidate.model,controlModel:control.model,
    candidateDataset:candidate.datasetHash,controlDataset:control.datasetHash,raw:raw.receipts.map(witness),splitOnly:splits.receipts.map(witness)};
  const file = resolve(directory,"tlt-result.json");
  const saved = await readResearchReceipt<typeof result>(file);
  if (saved) {
    if (digest(saved) !== digest(result)) throw Error("ONS replay differs from its sealed result");
  } else if (collect) await durableJSON(file,result,true);
  else throw Error("No sealed ONS outcome study exists");
  return {summary,digest:digest(result)};
}

export async function readOnsServicesStudy(firstIssue: string): Promise<DatedStudyRow> {
  if (firstIssue !== before) throw Error("Unexpected first issue for the ONS historical research boundary");
  const {summary:s,digest:resultHash} = await replayOnsStudy();
  if (resultHash !== "b067be9a82ede9dc1792b79e42c0beb5fd30acc75e07b54b184bc115827fcf20" ||
      s.verifiedDates!==s.paired || s.split.testEnds>=firstIssue)
    throw Error("ONS private aggregate differs from the reviewed historical result");
  const round = (x:number) => Number(x.toFixed(4));
  return {studyId:study,family:ONS_SERVICES_RESEARCH.family,instrument:"TLT",timingBasis:"dated-release",
    samples:s.paired,testSamples:s.split.test,modelBrier:round(s.candidate),controlBrier:round(s.headline),coinBrier:s.coin,
    baseRateBrier:round(s.trainingRate),coefficientSign:s.servicesCoefficient<0?"negative":s.servicesCoefficient>0?"positive":"zero",
    controlImprovement95:[round(s.controlImprovement95[0]),round(s.controlImprovement95[1])],
    priorStudySessions:s.previousStudies.all.anyOfSix,priorStudyTestSessions:s.previousStudies.test.anyOfSix,clearedMargin:s.clearsRegisteredScreen};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--collect")) throw Error("Use --collect only for the first private study");
  console.log(JSON.stringify(await replayOnsStudy(args[0] === "--collect")));
}
