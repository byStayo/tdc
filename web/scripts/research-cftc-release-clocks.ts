import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { durableJSON } from '../lib/publication-storage.ts';
import {
  CFTC_RELEASE_STUDY,
  FIRST_PUBLIC_FORECAST,
  REPORT_FROM,
  REPORT_THROUGH,
  STUDY_CONTRACTS,
  STUDY_ETFS,
  originalReportUrl,
  publishedFeature,
  releasePanel,
  studyReportDates,
  verifyOriginalReport,
} from '../lib/consensus/cftc-release-clocks.ts';
import { sourceResponse, sourceChunk } from '../lib/consensus/source-failure.ts';
import { exchangeSessions } from '../lib/consensus/exchange-calendar.ts';
import { digest } from '../lib/consensus/history.ts';
import { planCandidate, trainCandidate, type TrainingRow } from '../lib/consensus/learning.ts';
import { collectResearchPrices, readResearchReceipt } from '../lib/consensus/research-price-capture.ts';
import { newYorkDate } from '../lib/consensus/time.ts';

const base = fileURLToPath(new URL('../.consensus/', import.meta.url));
const dir = resolve(base, 'private-cftc-release-clocks');
const capture = process.argv[2] === '--capture';
if (process.argv.length !== (capture ? 3 : 2))
  throw new Error('Only the fixed historical replay or --capture is supported');
const source = new URL('https://publicreporting.cftc.gov/resource/gpe5-46if.json');
source.searchParams.set(
  '$select',
  'id,cftc_contract_market_code,report_date_as_yyyy_mm_dd,market_and_exchange_names,contract_units,futonly_or_combined,open_interest_all,asset_mgr_positions_long,asset_mgr_positions_short,:created_at,:updated_at'
);
const codes = Object.values(STUDY_CONTRACTS)
  .map((code) => `'${code}'`)
  .join(',');
source.searchParams.set(
  '$where',
  `cftc_contract_market_code in (${codes}) AND report_date_as_yyyy_mm_dd between '${REPORT_FROM}T00:00:00' and '${REPORT_THROUGH}T00:00:00'`
);
source.searchParams.set('$order', 'report_date_as_yyyy_mm_dd,cftc_contract_market_code');
source.searchParams.set('$limit', '350');
const frozenPositionSha = '01e114e99dc092e0efc01d79a4247f7345f97ef66c2de333a24502abc9f50a34';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type SourceFile = {
  source: string;
  sha256: string;
  retrievedAt: string;
  lastModifiedAt: string | null;
  gzip: string;
};
async function sourceFile(name: string, url: string, limit: number, verify: (bytes: Buffer) => void) {
  const path = resolve(dir, name + '.json');
  let stored = await readResearchReceipt<SourceFile>(path);
  if (!stored) {
    if (!capture) throw new Error(`Missing private CFTC capture ${name}`);
    const response = await sourceResponse(fetch, url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Daily Consensus CFTC historical report verification' },
    });
    const reader = response.body!.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await sourceChunk(reader);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error(`CFTC ${name} exceeds its size limit`);
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const bytes = Buffer.concat(chunks);
    verify(bytes);
    const modified = response.headers.get('last-modified');
    stored = {
      source: url,
      sha256: hash(bytes),
      retrievedAt: new Date().toISOString(),
      lastModifiedAt: modified ? new Date(modified).toISOString() : null,
      gzip: gzipSync(bytes).toString('base64'),
    };
    await durableJSON(path, stored, true);
  }
  const bytes = gunzipSync(Buffer.from(stored.gzip, 'base64'), { maxOutputLength: limit });
  const canonicalClock = (clock: string) =>
    Number.isFinite(Date.parse(clock)) && new Date(clock).toISOString() === clock;
  if (
    stored.source !== url ||
    hash(bytes) !== stored.sha256 ||
    !canonicalClock(stored.retrievedAt) ||
    stored.retrievedAt > new Date().toISOString() ||
    (stored.lastModifiedAt !== null &&
      (!canonicalClock(stored.lastModifiedAt) || stored.lastModifiedAt > stored.retrievedAt))
  )
    throw new Error(`CFTC evidence failed provenance validation for ${name}`);
  verify(bytes);
  return { bytes, sha256: stored.sha256, lastModifiedAt: stored.lastModifiedAt };
}

const observed = await sourceFile('source-rows-v1', source.href, 400_000, (bytes) => {
  if (hash(bytes) !== frozenPositionSha)
    throw new Error('CFTC row response differs from the frozen study capture');
});
const history = releasePanel(JSON.parse(observed.bytes.toString('utf8')));
const weeks = [];
for (const [index, date] of studyReportDates().entries()) {
  const rows = STUDY_ETFS.map((etf) => history[etf][index]);
  const record = await sourceFile('week-' + date, originalReportUrl(date), 800_000, (bytes) =>
    verifyOriginalReport(bytes.toString('latin1'), date, rows)
  );
  const creation = rows.map((row) => row.createdAt).sort();
  const changedRows = rows.filter((row) => row.updatedAt !== row.createdAt).length;
  weeks.push({
    date,
    source: originalReportUrl(date),
    sourceSha256: record.sha256,
    lastModifiedAt: record.lastModifiedAt,
    firstCreatedAt: creation[0],
    lastCreatedAt: creation.at(-1)!,
    changedRows,
  });
}
const evidence = {
  rows: weeks.length * STUDY_ETFS.length,
  weeks: weeks.length,
  changedRows: weeks.reduce((n, week) => n + week.changedRows, 0),
  sourceSha256: observed.sha256,
  weeklySourceSha256: digest(weeks),
  samePublicationDay: weeks.filter(
    (week) => week.lastModifiedAt && newYorkDate(week.lastModifiedAt) === newYorkDate(week.lastCreatedAt)
  ).length,
};
if (capture) {
  console.log(JSON.stringify({ status: 'verified-original-cftc-sources', ...evidence }));
} else {
  const oldMethod = 'prelaunch-family-screen-v1';
  type Original = {
    method: string;
    beforeFirstPublicForecast: string;
    through: string;
    experiments: {
      instrument: string;
      family: string;
      result: { datasetHash: string };
    }[];
  };
  const original = await readResearchReceipt<Original>(
    resolve(base, 'private-family-research', oldMethod + '.json')
  );
  if (
    original?.method !== oldMethod ||
    original.beforeFirstPublicForecast !== FIRST_PUBLIC_FORECAST ||
    original.through !== '2026-11-02'
  )
    throw new Error('The original frozen prelaunch experiment is required for comparison');
  const sessions = exchangeSessions('2026-01-02', original.through);
  const experiments = [];
  for (const etf of STUDY_ETFS) {
    // Same-session signs cancel a common price adjustment. Verify every legacy row, including its actual label, before testing this join.
    const [prices] = await collectResearchPrices(resolve(base, 'private-technical-momentum'), etf, sessions, {
      cachedOnly: true,
      reviewedExchangeCalendar: true,
    });
    const recorded: TrainingRow[] = [],
      previous: TrainingRow[] = [];
    const capturedReports = new Set<string>();
    const reports = history[etf];
    let changedSelection = 0,
      staleLegacy = 0,
      prematureLegacy = 0;
    for (const session of prices.sessions.slice(1)) {
      if (session.closeAt >= FIRST_PUBLIC_FORECAST)
        throw new Error('Unexpected price outside prelaunch period');
      const sevenDaysEarlier = new Date(Date.parse(session.session) - 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const i = reports.findLastIndex((row) => row.date <= sevenDaysEarlier);
      if (i < 1) throw new Error('Missing previous report for frozen legacy comparison');
      const row = {
        id: `${etf}:${session.session}:${reports[i].date}`,
        engineVersion: oldMethod,
        issuedAt: session.openAt,
        labelKnownAt: session.closeAt,
        up: (session.close > session.open ? 1 : 0) as 0 | 1,
      };
      previous.push({ ...row, features: [(reports[i].sharePercent - reports[i - 1].sharePercent) / 100] });
      const feature = publishedFeature(reports, session.openAt);
      if (!feature) continue;
      if (feature.date !== reports[i].date) {
        changedSelection++;
        if (reports[i].updatedAt >= session.openAt) prematureLegacy++;
        else staleLegacy++;
      }
      capturedReports.add(feature.date);
      recorded.push({
        ...row,
        id: `${etf}:${session.session}:${feature.date}`,
        engineVersion: CFTC_RELEASE_STUDY,
        features: [feature.value],
      });
    }
    const previousHash = planCandidate(previous, FIRST_PUBLIC_FORECAST).datasetHash;
    const previousExperiment = original.experiments.find(
      (row) => row.instrument === etf && row.family === 'institutions'
    );
    if (previousHash !== previousExperiment?.result.datasetHash)
      throw new Error(`The original features, price labels or chronology did not reproduce for ${etf}`);
    experiments.push({
      instrument: etf,
      previousHash,
      priceSourceSha256: prices.sha256,
      distinctFeatureDates: capturedReports.size,
      changedSelection,
      staleLegacy,
      prematureLegacy,
      rows: recorded,
    });
  }
  const expectedInputs = digest(
    experiments.map(({ rows, ...metadata }) => ({ ...metadata, datasetHash: digest(rows) }))
  );
  const path = resolve(dir, CFTC_RELEASE_STUDY + '.json');
  type Saved = {
    method: string;
    inputsSha256: string;
    sourceEvidence: typeof evidence;
    weeks: typeof weeks;
    results: unknown;
    resultsSha256: string;
  };
  const saved = await readResearchReceipt<Saved>(path);
  if (saved) {
    if (
      saved.method !== CFTC_RELEASE_STUDY ||
      saved.inputsSha256 !== expectedInputs ||
      digest(saved.sourceEvidence) !== digest(evidence) ||
      digest(saved.weeks) !== evidence.weeklySourceSha256 ||
      digest(saved.results) !== saved.resultsSha256
    )
      throw new Error('Saved historical release-clock study differs from the verified evidence');
    console.log(JSON.stringify({ status: 'reused-private-study', ...evidence }));
  } else {
    const results = experiments.map(({ rows, ...metadata }) => ({
      ...metadata,
      result: trainCandidate(rows, FIRST_PUBLIC_FORECAST),
    }));
    await durableJSON(
      path,
      {
        method: CFTC_RELEASE_STUDY,
        beforeFirstPublicForecast: FIRST_PUBLIC_FORECAST,
        through: original.through,
        source: source.href,
        checkedAt: new Date().toISOString(),
        inputsSha256: expectedInputs,
        sourceEvidence: evidence,
        weeks,
        results,
        resultsSha256: digest(results),
      },
      true
    );
    console.log(
      JSON.stringify({
        status: 'completed-private-study',
        ...evidence,
        results: results.map(({ instrument, result }) => ({
          instrument,
          samples: result.samples,
          promoted: result.promoted,
        })),
      })
    );
  }
}
