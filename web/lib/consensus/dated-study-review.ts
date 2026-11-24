// Owner-only input verification for the three November 24 historical research studies.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { digest } from "./history.ts";
import { extendedResearchSession, extendedResearchSessions } from "./extended-research-calendar.ts";
import { KIBOT_PRICE_CITATION } from "./kibot.ts";
import { trainCandidate, type TrainingRow } from "./learning.ts";
import { readResearchReceipt, type ResearchPriceReceipt } from "./research-price-capture.ts";
import { parseTicRelease, type TicReleaseReading } from "./tic-release.ts";
import { newYorkDate } from "./time.ts";
import { ticTrainingRows } from "../../scripts/research-tic-treasury.ts";
import { SWVXX_FLOW_RESEARCH, TIC_TREASURY_RESEARCH, VX_CURVE_RESEARCH, type DatedStudyRow } from "./kibot-research.ts";

const sum = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const round = (n: number) => Number(n.toFixed(4));
const label = (n: number): DatedStudyRow["coefficientSign"] => n > 0 ? "positive" : n < 0 ? "negative" : "zero";
type Fit = Extract<ReturnType<typeof trainCandidate>, {status: "evaluated"}>;
type Native = { url: string; sha256: string; body: string };
function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error("Sealed research differs: " + detail);
}
async function receipt<T>(path: string, pin?: string): Promise<T> {
  const data = await readResearchReceipt<T>(path);
  check(data && (!pin || digest(data) === pin), basename(path));
  return data;
}
async function bytes(path: string) {
  const info = await lstat(path);
  check(info.isFile() && !(info.mode & 0o077) && info.size > 0 && info.size < 4_000_000, basename(path));
  return readFile(path);
}
async function checkedPrice(path: string, ticker: string, native: string, normalized?: string) {
  const p = await receipt<ResearchPriceReceipt>(path);
  check(p.instrument === ticker && p.sha256 === native && p.priceDigest === digest(p.sessions) &&
    (!normalized || p.priceDigest === normalized) && digest(extendedResearchSessions(p.from,p.through)) === digest(p.sessions.map(b => b.session)), "Kibot price history");
  for (const bar of p.sessions) {
    const c = extendedResearchSession(bar.session);
    check(c && c.openAt === bar.openAt && c.closeAt === bar.closeAt && [bar.open,bar.close].every(x => Number.isFinite(x) && x > 0), "Kibot session");
  }
  return p;
}
function priceMap(prices: ResearchPriceReceipt[]) {
  return new Map(prices.flatMap(p => p.sessions.map(b => [b.session,b] as const)));
}
function trainingRow(id: string, method: string, day: string, at: string, before: string, features: number[],
  raw: ReturnType<typeof priceMap>, splits: ReturnType<typeof priceMap>): TrainingRow {
  const q = raw.get(day), s = splits.get(day);
  check(q && s && s.openAt === q.openAt && s.closeAt === q.closeAt && at < q.openAt && q.closeAt < before &&
    Math.sign(s.close-s.open) === Math.sign(q.close-q.open), "matched, elapsed regular session");
  return {id,engineVersion:method,issuedAt:at,labelKnownAt:q.closeAt,features,up:q.close > q.open ? 1 : 0};
}
function compare(rows: TrainingRow[], before: string, full: Fit, reduced: Fit, sign: number, declared: boolean) {
  const actual = trainCandidate(rows,before);
  const control = trainCandidate(rows.map(row => ({...row,features:row.features.slice(0,-1)})),before);
  check(actual.status === "evaluated" && control.status === "evaluated" && digest(actual) === digest(full) &&
    digest(control) === digest(reduced) && digest(actual.split) === digest(control.split) && actual.split.testEnds < before &&
    rows.every((r,i) => r.issuedAt < r.labelKnownAt && r.labelKnownAt < before && (!i || rows[i-1].labelKnownAt < r.issuedAt)) &&
    rows.length === new Set(rows.map(r => r.id)).size && actual.samples === rows.length &&
    actual.baseRateBrier === control.baseRateBrier && actual.coinBrier === 0.25 && control.coinBrier === 0.25, "chronological held-out models and controls");
  const coefficient = actual.model.weights.at(-1)!;
  const margin = Math.min(control.candidateBrier,actual.baseRateBrier,actual.coinBrier)-actual.candidateBrier;
  check(Number.isFinite(coefficient) && (Math.sign(coefficient) === sign && margin > 0.01) === declared, "registered model decision");
  return {samples:rows.length,testSamples:actual.split.test,modelBrier:round(actual.candidateBrier),controlBrier:round(control.candidateBrier),
    baseRateBrier:round(actual.baseRateBrier),coinBrier:actual.coinBrier,coefficientSign:label(coefficient),clearedMargin:declared};
}

async function tic(base: string, before: string): Promise<DatedStudyRow> {
  const folder = join(base,"private-tic-treasury-demand");
  const s = await receipt<{before:string;method:string;priceCitation:string;policyHash:string;sourceHash:string;rowHash:string;
    prices:{from:string;through:string;native:string;rows:string}[];fitted:Fit;control:Fit;metrics:{clearsResearchMargin:boolean}}>(
    join(folder,"study.json"),"c13261938ddec7294ecd67872540c17db8036967bb2004fd019b85789714ebed");
  check(s.method === TIC_TREASURY_RESEARCH.id && s.before === before && s.priceCitation === KIBOT_PRICE_CITATION,"TIC scope");
  const policy = await receipt<{sha256:string}>(join(folder,"registration.json"),"f4f6bf492a4b9fb492a4e18cfcb1ba34648e6973044867883a4002dc7cd2914d");
  type Source = {day:string;key:string;originalSHA256:string};
  const cohort = await receipt<{policyHash:string;targets:(Source & {reading:TicReleaseReading})[];excluded:Source[]}>(join(folder,"source-cohort.json"),s.sourceHash);
  check(cohort.policyHash === policy.sha256 && s.policyHash === policy.sha256 && cohort.targets.length === 126 && cohort.excluded.length === 3,"TIC census");
  for (const source of [...cohort.targets,...cohort.excluded]) {
    const original = join(folder,"sources",source.key);
    const body = await bytes(original+".html");
    const meta = await receipt<{url:string;sha256:string}>(original+".receipt.json");
    const route = source.key === "sm0146" ? "press-release" : "press-releases";
    check(meta.url === "https://home.treasury.gov/news/"+route+"/"+source.key && sum(body) === source.originalSHA256 && meta.sha256 === source.originalSHA256,"Treasury original");
    if ("reading" in source) check(digest(parseTicRelease(body.toString("utf8"))) === digest(source.reading), "original TIC release table");
  }
  const prices: ResearchPriceReceipt[] = [];
  for (const [i,p] of s.prices.entries()) {
    const name = ["TLT",p.from.slice(0,4),p.from,p.through,i<s.prices.length/2?"raw":"splits"].join("-") + ".json";
    const primary = join(folder,name);
    const present = await lstat(primary).then(() => true,(e:NodeJS.ErrnoException) => {if(e.code === "ENOENT")return false;throw e;});
    prices.push(await checkedPrice(present ? primary : join(base,"private-technical-momentum",name),"TLT",p.native,p.rows));
  }
  const rows = ticTrainingRows(cohort.targets,prices.slice(0,prices.length/2),prices.slice(prices.length/2));
  check(digest(rows) === s.rowHash,"TIC paired observations");
  return {studyId:TIC_TREASURY_RESEARCH.id,family:"capital",instrument:"TLT",timingBasis:"dated-release",
    ...compare(rows,before,s.fitted,s.control,1,s.metrics.clearsResearchMargin)};
}

async function retail(base: string, before: string): Promise<DatedStudyRow> {
  const folder = join(base,"private-retail-nmfp");
  type Pricing = {raw:string;splits:string;rawNormalized:string;splitsNormalized:string;rawRef:string;splitsRef:string};
  const s = await receipt<{before:string;method:string;policySHA256:string;sourceSHA256:string;prices:Pricing[];combined:Fit;control:Fit;
    summary:{pairedBlockInterval95:[number,number];clearsGate:boolean}}>(join(folder,"sealed-result.json"),
    "420c91b2ea6f9fdde05128fcd9acd3d6236c235bdc7f88865007adce407db049");
  const reg = await receipt<{method:string;policySHA256:string;policy:{dependencies:Record<string,string>}}>(join(folder,"registered.json"),
    "31cf8e9e512e4af654ce7bedcd8ea3399159cd08c368d9800b3512f9e86dfada");
  check(s.before === before && s.method === SWVXX_FLOW_RESEARCH.id && reg.method === s.method && reg.policySHA256 === s.policySHA256,"SWVXX policy");
  const inputs = await bytes(join(folder,"source-candidates.json")), weeksFile = await bytes(join(folder,"verified-weeks.json"));
  check(sum(inputs) === s.sourceSHA256 && sum(weeksFile) === reg.policy.dependencies["verified-weeks.json"],"SWVXX source cohort");
  type Member = {day:string;asOfCutoff:string;accession:string;sha256:string;control:number;feature:number};
  type Week = {accession:string;sha256:string;periodEnd:string;filingDate:string;acceptedAt:string;feature:number;control:number;weekFriday:string};
  const members: Member[] = JSON.parse(inputs.toString("utf8"));
  const weeks: Week[] = JSON.parse(weeksFile.toString("utf8")).periods;
  check(members.length === 120 && weeks.length === 120,"SWVXX cohort dates");
  const prices = await Promise.all(s.prices.map(async p => {
    const pair = await Promise.all([checkedPrice(join(base,p.rawRef),"SPY",p.raw,p.rawNormalized),checkedPrice(join(base,p.splitsRef),"SPY",p.splits,p.splitsNormalized)]);
    for (const [i,ref] of [p.rawRef,p.splitsRef].entries()) {
      if (ref.startsWith("private-retail-nmfp/prices/")) check(sum(await bytes(join(base,ref.replace(/\.json$/,".csv")))) === pair[i].sha256, "original SWVXX research price source");
    }
    return pair;
  }));
  const raw = priceMap(prices.map(p => p[0])), splits = priceMap(prices.map(p => p[1]));
  const rows: TrainingRow[] = [];
  for (const [i,m] of members.entries()) {
    const w = weeks[i], folderPath = join(folder,"originals");
    check(w.accession === m.accession && w.sha256 === m.sha256 && w.control === m.control && w.feature === m.feature &&
      w.weekFriday <= w.periodEnd && w.periodEnd <= w.filingDate && w.filingDate < m.day && newYorkDate(w.acceptedAt) < m.day,"SEC first filing and target");
    const meta = await receipt<{url:string;sha256:string;bytes:number}>(join(folderPath,m.accession+".json"));
    check(Number.isSafeInteger(meta.bytes) && meta.bytes > 0 && meta.bytes <= 24_000_000,"bounded original SEC filing");
    const native = gunzipSync(await bytes(join(folderPath,m.sha256+".gz")),{maxOutputLength:meta.bytes});
    check(meta.sha256 === m.sha256 && meta.bytes === native.length && sum(native) === m.sha256 &&
      meta.url === "https://www.sec.gov/Archives/edgar/data/857156/"+m.accession.replaceAll("-","")+"/primary_doc.xml","SEC original XML");
    // Preserve the field order included in this study's registered dataset hash.
    const {features,...identityAndOutcome} = trainingRow(s.method+":"+m.day,s.method,m.day,m.asOfCutoff,before,[m.control,m.feature],raw,splits);
    rows.push({...identityAndOutcome,features});
  }
  const [low,high] = s.summary.pairedBlockInterval95;
  check(low <= high && Number.isFinite(low) && Number.isFinite(high),"SWVXX paired interval");
  return {studyId:SWVXX_FLOW_RESEARCH.id,family:"retail",instrument:"SPY",timingBasis:"dated-release",controlImprovement95:[round(low),round(high)],
    ...compare(rows,before,s.combined,s.control,-1,s.summary.clearsGate)};
}

async function vx(base: string, before: string): Promise<DatedStudyRow> {
  const folder = join(base,"private-vx-curve");
  type Pair = {day:string;from:string;front:string;next:string;frontSettle:number;secondSettle:number;cutoff:string};
  type Lock = {policy:string;checkedPairs:number;comparisons:number;mismatches:unknown[];pairs:Pair[];sources:{symbol:string;hashes:string[]}[]};
  const s = await receipt<{first:string;policy:string;sourceLock:string;labels:string[][];combined:Fit;control:Fit;rows:TrainingRow[];
    summary:{passed:boolean}}>(join(folder,"study.json"),"2be75c7a9b78d8bfc13440f6a20acea7da5b6a2cae0a47648ac2888c047e9a13");
  const policy = await bytes(join(folder,"protocol.json")), file = await bytes(join(folder,"paired-lock.json"));
  const lock: Lock = JSON.parse(file.toString("utf8"));
  check(s.first === before && sum(policy) === s.policy && JSON.parse(policy.toString("utf8")).id === VX_CURVE_RESEARCH.id && sum(file) === s.sourceLock &&
    lock.policy === s.policy && lock.checkedPairs === 247 && lock.pairs.length === 247 && lock.comparisons === 494 && !lock.mismatches.length,"VX dates and source seal");
  const contracts = new Map<string,{vendor:Map<string,number>;exchange:Map<string,number>}>();
  for (const src of lock.sources) {
    const {symbol,hashes} = src, api = "https://getmarkethistory.com/api/v1/";
    const urls = [api+"futures/us/"+symbol,api+"bars/futures/us/"+symbol+"/1d",
      "https://cdn.cboe.com/data/us/futures/market_statistics/historical_data/VX/VX_"+symbol.slice(3)+".csv"];
    const docs = await Promise.all(["spec","bars","cfe"].map(async (kind,i) => {
      const d = await receipt<Native>(join(folder,symbol+"-"+kind+".json"));
      check(d.sha256 === hashes[i] && sum(d.body) === d.sha256 && d.url === urls[i],"native monthly VX contract");
      return d.body;
    }));
    const spec = JSON.parse(docs[0]);
    check(spec.ticker === symbol && spec.dataset === "futures/us" && spec.contract.exchange === "CFE","CFE monthly contract");
    const bars = docs[1].trim().split(/\r?\n/).map(line => JSON.parse(line));
    const [header,...prices] = docs[2].trim().split(/\r?\n/);
    check(header.split(",")[6] === "Settle" && header.startsWith("Trade Date,Futures,") &&
      bars.every(b => b.symbol === symbol && b.is_gap === false && b.gap_fill_method === 0 && Number.isFinite(b.close)),"CFE daily settlement fields");
    const vendor = new Map<string,number>(bars.map(b => [b.timestamp.slice(0,10),b.close]));
    const exchange = new Map<string,number>(prices.map(line => {const c = line.split(",");return [c[0],Number(c[6])];}));
    check(vendor.size === bars.length && exchange.size === prices.length,"unique native VX dates");
    contracts.set(symbol,{vendor,exchange});
  }
  const calendar = extendedResearchSessions("2025-01-01","2025-12-31");
  const stem = "SPY-2025-"+calendar[0]+"-"+calendar.at(-1)+"-";
  const [raw,splits] = await Promise.all(["raw","splits"].map(async (basis,i) => {
    check(s.labels[i]?.length === 1,"SPY price source identity");
    return priceMap([await checkedPrice(join(base,"private-technical-momentum",stem+basis+".json"),"SPY",s.labels[i][0])]);
  }));
  const rows = lock.pairs.map(p => {
    for (const [symbol,amount] of [[p.front,p.frontSettle],[p.next,p.secondSettle]] as const) {
      const c = contracts.get(symbol);
      check(c && c.vendor.get(p.from) === amount && c.exchange.get(p.from) === amount,"direct CFE and Market History settlement");
    }
    const active = [...contracts.keys()].filter(symbol => symbol.slice(3)>p.from).sort();
    check(active[0] === p.front && active[1] === p.next && p.from < p.day,"two still-live monthly expiries");
    return trainingRow("SPY:"+p.day,VX_CURVE_RESEARCH.id,p.day,new Date(p.cutoff).toISOString(),before,
      [Math.log(p.secondSettle),Math.log(p.frontSettle/p.secondSettle)],raw,splits);
  });
  check(digest(rows) === digest(s.rows),"VX features, price direction and cutoff");
  type Witness = {sourceDay:string;target:string;capturedAt:string;cutoff:string;sourceURL:string;sourceSHA256:string;contracts:string[];bothMatched:boolean};
  const known = await receipt<{historicMatches:number;rows:Witness[]}>(join(folder,"as-known.json"),
    "0b14f210658c33d115745c881a1ae593de4b1c43ba6a33276cf4df767d35d2e9");
  check(known.historicMatches === 4 && known.rows.length === 4 && new Set(known.rows.map(w=>w.target)).size===4,"contemporaneous VX witness count");
  for (const w of known.rows) {
    const p = lock.pairs.find(r => r.day === w.target);
    const path = join(folder,"clock-original-"+sum(w.sourceURL).slice(0,12));
    type Archive = {url:string;final:string;sha256:string;headers:Record<string,string>;text:string;encoding?:string;contentSha256?:string};
    const original = await receipt<Archive>(path+".json"), sourceClock = Date.parse(w.capturedAt);
    check(p && w.sourceDay === p.from && w.bothMatched && w.cutoff === p.cutoff && digest(w.contracts) === digest([p.front.slice(3),p.next.slice(3)]) &&
      original.url === w.sourceURL && original.final === w.sourceURL && original.sha256 === w.sourceSHA256 &&
      Date.parse(original.headers["memento-datetime"]) === sourceClock && sourceClock > Date.parse(extendedResearchSession(w.sourceDay)!.closeAt) &&
      sourceClock < Date.parse(w.cutoff),"archived original CFE publication clock");
    // Some Wayback responses retained the original gzip wire bytes as well as the decoded settlement page.
    if (sum(original.text) !== w.sourceSHA256) {
      const compressed = await bytes(path+"-wire.gz");
      const decoded = await receipt<Archive>(path+"-decoded.json");
      check(sum(compressed) === w.sourceSHA256 && decoded.encoding === "gzip" && sum(decoded.text) === decoded.contentSha256 &&
        gunzipSync(compressed,{maxOutputLength:4_000_000}).toString("utf8") === decoded.text,"archived CFE wire and decoded settlement table");
    }
  }
  return {studyId:VX_CURVE_RESEARCH.id,family:"options",instrument:"SPY",timingBasis:"historical-reconstruction",strictBeforeCutoff:known.historicMatches,
    ...compare(rows,before,s.combined,s.control,-1,s.summary.passed)};
}

/** Reproduce all three historical studies from their owner-only frozen inputs. Never fetch or write. */
export async function readDatedStudyRows(webRoot: string, before: string): Promise<DatedStudyRow[]> {
  const base = join(webRoot,".consensus");
  return Promise.all([tic(base,before),retail(base,before),vx(base,before)]);
}
