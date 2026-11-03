import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquirePublicationLock, finishPublicationLock } from '../lib/publication-lock.ts';
import { savedPublicData } from '../lib/saved-public-data.ts';
import type { ResearchResponse } from '../lib/contracts.ts';
import { validateResearch } from '../lib/research-schema.ts';
import { publicDate } from '../lib/public-normalization.ts';
import { instrumentReport } from '../lib/instrument-reports.ts';
import { assertPublicURL, PROJECT_ROOT, type EditorialEvidence } from './collect-editorial-evidence.ts';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid editorial text'); return value.trim(); };
function time(value: unknown, now: number): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !publicDate(value)) throw new Error('Invalid editorial timestamp');
  const parsed = Date.parse(value); if (!Number.isFinite(parsed) || parsed > now) throw new Error('Editorial timestamps must not be in the future'); return parsed;
}
function inspectEvidenceTree(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error('Evidence structure is too deep');
  if (Array.isArray(value)) { if (value.length > 1000) throw new Error('Evidence array is too large'); for (const item of value) inspectEvidenceTree(item, depth + 1); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:api[_-]?key|password|authorization|access[_-]?token|secret)$/i.test(key)) throw new Error('Evidence contains a credential field');
      if (/url$/i.test(key) && item !== null) assertPublicURL(item);
      inspectEvidenceTree(item, depth + 1);
    }
  } else if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Evidence contains a nonfinite number');
}

export function validateEditorialPublication(candidateInput: unknown, evidenceInput: unknown, now = Date.now()): { brief: ResearchResponse & { scope: 'market' | 'instrument'; createdAt: string }; evidence: EditorialEvidence } {
  const evidence = record(evidenceInput);
  if (Object.keys(evidence).some(key => !['schemaVersion', 'scope', 'collectedAt', 'sources', 'limitations'].includes(key))) throw new Error('Unknown evidence manifest fields');
  if (evidence.schemaVersion !== 1 || evidence.scope !== 'market' || !Array.isArray(evidence.sources) || !evidence.sources.length || evidence.sources.length > 30) throw new Error('Invalid public evidence manifest');
  const collectedAt = time(evidence.collectedAt, now), sources = new Map<string, { url: string; status: string; data: unknown }>();
  if (!Array.isArray(evidence.limitations) || !evidence.limitations.length || evidence.limitations.length > 20) throw new Error('Evidence limitations are required');
  evidence.limitations.forEach(value => text(value, 1000));
  inspectEvidenceTree(evidence);
  for (const entry of evidence.sources) {
    const source = record(entry), id = text(source.id, 64);
    if (Object.keys(source).some(key => !['id', 'kind', 'title', 'url', 'retrievalUrl', 'retrievedAt', 'observationDates', 'status', 'data', 'error'].includes(key))) throw new Error('Unknown evidence source fields');
    if (!/^[A-Z][A-Z0-9_]*$/.test(id) || sources.has(id) || !['cftc', 'fred', 'sec', 'methodology', 'bls'].includes(String(source.kind)) || !['ok', 'unavailable'].includes(String(source.status))) throw new Error('Invalid or duplicate evidence source');
    text(source.title, 400); const url = assertPublicURL(source.url); assertPublicURL(source.retrievalUrl);
    const retrievedAt = time(source.retrievedAt, now); if (retrievedAt > collectedAt) throw new Error('Source retrieval occurred after the manifest collection time');
    if (!Array.isArray(source.observationDates) || source.observationDates.length > 1000 || source.observationDates.some(date => !publicDate(date) || Date.parse(`${publicDate(date)}T00:00:00Z`) > retrievedAt)) throw new Error('Invalid evidence observation dates');
    if (source.status === 'ok' && (source.data === null || source.data === undefined)) throw new Error('Available evidence must contain data');
    if (source.status === 'unavailable' && source.data !== null) throw new Error('Unavailable evidence must not contain substitute data');
    if (source.kind === 'bls' && source.status === 'ok') {
      const data = record(source.data), release = time(data.publishedAt, now);
      if (new URL(url).hostname !== 'www.bls.gov' || new URL(String(source.retrievalUrl)).hostname !== 'www.bls.gov' ||
          !/^[a-f0-9]{64}$/.test(String(data.sha256)) || release > retrievedAt ||
          typeof data.periodEnd !== 'string' || data.periodEnd.length !== 10 || !publicDate(data.periodEnd) ||
          Date.parse(`${data.periodEnd}T00:00:00Z`) > release || !source.observationDates.includes(data.periodEnd))
        throw new Error('BLS evidence requires its original release, observation period and document hash');
    }
    sources.set(id, { url, status: String(source.status), data: source.data });
  }
  const candidate = record(candidateInput);
  if (!['market', 'instrument'].includes(String(candidate.scope)) || candidate.status !== 'ok') throw new Error('Only a completed market or supported instrument brief may be published');
  const instrument = candidate.scope === 'instrument' ? instrumentReport(candidate.symbol) : undefined;
  if (candidate.scope === 'instrument' && !instrument) throw new Error('Unsupported instrument report symbol');
  if (candidate.scope === 'market' && candidate.symbol !== undefined) throw new Error('Market-wide briefs must not be labelled as an instrument');
  const createdAt = time(candidate.createdAt, now); if (createdAt < collectedAt) throw new Error('The brief must be written after its evidence was collected');
  if (!Array.isArray(candidate.sources) || !candidate.sources.length || candidate.sources.length > 30) throw new Error('Citation sources are required');
  const citationIds = new Set<string>();
  const citations = candidate.sources.map(entry => {
    const source = record(entry), id = text(source.id, 64), evidenceSource = sources.get(id), url = assertPublicURL(source.url);
    if (!evidenceSource || evidenceSource.status !== 'ok' || citationIds.has(id) || evidenceSource.url !== url) throw new Error('Citation does not match available collected evidence');
    citationIds.add(id); return { id, title: text(source.title, 400), url };
  });
  const data = validateResearch(candidate.data, citationIds);
  if (!data.limitations.length || ![...data.bull, ...data.bear, ...data.watch].length) throw new Error('A published brief needs observations and limitations');
  if (instrument) {
    const primary = sources.get(instrument.sourceId);
    const citesPrimary = [...data.bull, ...data.bear, ...data.watch].some(claim => claim.sourceIds.includes(instrument.sourceId));
    if (!primary || primary.status !== 'ok' || record(primary.data).contractCode !== instrument.contractCode || !citesPrimary) throw new Error('Instrument research must cite its own verified related futures contract');
  }
  return { brief: { status: 'ok', scope: instrument ? 'instrument' : 'market', ...(instrument ? { symbol: instrument.symbol } : {}), createdAt: new Date(createdAt).toISOString(), model: 'Codex editorial workflow', message: text(candidate.message, 1000), data, sources: citations }, evidence: evidence as unknown as EditorialEvidence };
}

async function readJSON(path: string): Promise<unknown> {
  const content = await readFile(path); if (content.length > 2 * 1024 * 1024) throw new Error('Editorial input exceeds two megabytes');
  return JSON.parse(content.toString('utf8'));
}
async function stage(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o644);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function sameFile(path: string, content: string): Promise<boolean> {
  try { if (await readFile(path, 'utf8') !== content) throw new Error('An immutable report already exists with different content'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function publishEditorialBrief(candidatePath: string, evidencePath: string, options: { root?: string; now?: number; checkOnly?: boolean } = {}): Promise<{ checked: true; published: boolean; latest: string; briefArchive: string; evidenceArchive: string }> {
  const root = options.root ?? PROJECT_ROOT;
  const [candidate, evidenceInput] = await Promise.all([readJSON(candidatePath), readJSON(evidencePath)]);
  // Complete validation before creating directories, locks, archive files or a replacement publication.
  const { brief, evidence } = validateEditorialPublication(candidate, evidenceInput, options.now ?? Date.now());
  const workspaceData = savedPublicData(evidence);
  const briefText = `${JSON.stringify(brief, null, 2)}\n`, evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  const digest = createHash('sha256').update(briefText).update(evidenceText).digest('hex').slice(0, 12);
  const stem = `${brief.createdAt.slice(0, 10)}-${brief.createdAt.slice(11, 19).replaceAll(':', '')}Z-${brief.symbol ? `${brief.symbol}-` : ''}${digest}`;
  const reports = resolve(root, 'public/reports'), latest = brief.scope === 'instrument'
    ? resolve(root, `lib/published-instruments/${brief.symbol}.json`) : resolve(root, 'lib/published-brief.json');
  const briefArchive = resolve(reports, `${stem}-brief.json`), evidenceArchive = resolve(reports, `${stem}-evidence.json`);
  const result = { checked: true as const, published: false, latest, briefArchive, evidenceArchive };
  if (options.checkOnly) return result;
  const release = await acquirePublicationLock(root, 'editorial');
  let failure: {error: unknown} | undefined;
  const staged: string[] = [], createdArchives: string[] = []; let replaced = false;
  try {
    try {
      const previous = JSON.parse(await readFile(latest, 'utf8')) as { createdAt?: string };
      if (previous.createdAt && Date.parse(previous.createdAt) > Date.parse(brief.createdAt)) throw new Error('Candidate predates the current publication');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(reports, { recursive: true }); await mkdir(dirname(latest), { recursive: true });
    const alreadyBrief = await sameFile(briefArchive, briefText), alreadyEvidence = await sameFile(evidenceArchive, evidenceText);
    const token = randomUUID(), temporaryBrief = resolve(reports, `.editorial-${token}-brief.tmp`), temporaryEvidence = resolve(reports, `.editorial-${token}-evidence.tmp`), temporaryLatest = resolve(dirname(latest), `.published-brief-${token}.tmp`);
    for (const [path, content] of [[temporaryBrief, briefText], [temporaryEvidence, evidenceText], [temporaryLatest, briefText]]) { staged.push(path); await stage(path, content); }
    if (!alreadyBrief) { await link(temporaryBrief, briefArchive); createdArchives.push(briefArchive); }
    if (!alreadyEvidence) { await link(temporaryEvidence, evidenceArchive); createdArchives.push(evidenceArchive); }
    // Readers see either the complete previous brief or the complete validated replacement.
    await rename(temporaryLatest, latest); replaced = true;
    const workspacePath = resolve(root, 'lib/saved-public-data.json');
    let previousCollection: string | undefined;
    try { previousCollection = JSON.parse(await readFile(workspacePath, 'utf8')).collectedAt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!previousCollection || evidence.collectedAt >= previousCollection) {
      const workspaceTemp = `${workspacePath}.${token}.tmp`; staged.push(workspaceTemp);
      await stage(workspaceTemp, `${JSON.stringify(workspaceData, null, 2)}\n`);
      await rename(workspaceTemp, workspacePath);
    }
    return { ...result, published: true };
  } catch (error) {
    failure = {error};
    if (!replaced) for (const path of createdArchives) await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    for (const path of staged) await unlink(path).catch(() => undefined);
    await finishPublicationLock(release, failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), checkOnly = args.includes('--check'), paths = args.filter(value => value !== '--check');
    if (paths.length !== 2 || args.some(value => value.startsWith('--') && value !== '--check')) throw new Error('Usage: node --experimental-strip-types scripts/publish-editorial-brief.ts CANDIDATE.json EVIDENCE.json [--check]');
    console.log(JSON.stringify(await publishEditorialBrief(paths[0], paths[1], { checkOnly }), null, 2));
  } catch (error) { console.error(`Publication failed: ${error instanceof Error ? error.message : 'Unknown failure'}`); process.exitCode = 1; }
}
