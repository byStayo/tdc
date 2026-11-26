import { latestPublicPositioning } from '../public-normalization.ts';
import { cftcTableClock } from './cftc-provenance.ts';

export const CFTC_RELEASE_STUDY = 'prelaunch-tff-recorded-publication-v1';
export const FIRST_PUBLIC_FORECAST = '2026-11-03T06:28:30.460Z';
export const REPORT_FROM = '2025-09-23';
export const REPORT_THROUGH = '2026-10-27';
export const STUDY_CONTRACTS = {
  SPY: '13874A',
  QQQ: '209742',
  IWM: '239742',
  DIA: '124603',
  TLT: '020601',
} as const;
export type StudyEtf = keyof typeof STUDY_CONTRACTS;
export const STUDY_ETFS = Object.keys(STUDY_CONTRACTS) as StudyEtf[];
const DAY = 86_400_000;

export interface ReleaseRow {
  date: string;
  contract: string;
  createdAt: string;
  updatedAt: string;
  interest: number;
  long: number;
  short: number;
  sharePercent: number;
}

/** The agency used Monday November 10 for Veterans Day week. Every other report in this frozen window is Tuesday. */
export function studyReportDates(): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(REPORT_FROM); ms <= Date.parse(REPORT_THROUGH); ms += 7 * DAY) {
    const date = new Date(ms).toISOString().slice(0, 10);
    dates.push(date === '2025-11-11' ? '2025-11-10' : date);
  }
  return dates;
}

export function releaseRow(value: unknown): ReleaseRow {
  if (!value || typeof value !== 'object') throw new Error('CFTC publication row is missing');
  const raw = value as Record<string, unknown>;
  const [position] = latestPublicPositioning([raw], Object.values(STUDY_CONTRACTS));
  const clock = position && cftcTableClock(raw, position.reportDate, position.contractCode);
  if (
    !position ||
    !clock ||
    raw.report_date_as_yyyy_mm_dd !== `${position.reportDate}T00:00:00.000` ||
    !position.openInterest ||
    position.assetManagerLong === null ||
    position.assetManagerShort === null ||
    position.assetManagerLong > position.openInterest ||
    position.assetManagerShort > position.openInterest
  )
    throw new Error('CFTC futures-only identity, position counts or system timestamps are invalid');
  return {
    date: position.reportDate,
    contract: position.contractCode,
    ...clock,
    interest: position.openInterest,
    long: position.assetManagerLong,
    short: position.assetManagerShort,
    sharePercent: ((position.assetManagerLong - position.assetManagerShort) / position.openInterest) * 100,
  };
}

export function releasePanel(raw: unknown) {
  const dates = studyReportDates();
  if (!Array.isArray(raw) || raw.length !== dates.length * STUDY_ETFS.length)
    throw new Error('Incomplete CFTC publication panel');
  const rows = raw.map(releaseRow);
  return Object.fromEntries(
    STUDY_ETFS.map((etf) => {
      const history = rows
        .filter((row) => row.contract === STUDY_CONTRACTS[etf])
        .sort((a, b) => a.date.localeCompare(b.date));
      if (history.length !== dates.length || history.some((row, i) => row.date !== dates[i]))
        throw new Error(`Missing, duplicate or unexpected ${etf} CFTC report`);
      return [etf, history];
    })
  ) as Record<StudyEtf, ReleaseRow[]>;
}

/** A report available at the open cannot underlie a call issued before the open. A later revision has no usable earlier value. */
export function publishedFeature(history: ReleaseRow[], openAt: string) {
  const i = history.findLastIndex((row) => row.createdAt < openAt);
  if (i < 1) return null;
  const current = history[i],
    prior = history[i - 1];
  if (current.updatedAt >= openAt || prior.updatedAt >= openAt) return null;
  return {
    date: current.date,
    priorDate: prior.date,
    value: (current.sharePercent - prior.sharePercent) / 100,
  };
}

export function originalReportUrl(day: string) {
  return `https://www.cftc.gov/sites/default/files/files/dea/cotarchives/${day.slice(0, 4)}/futures/financial_lf${day.slice(5, 7)}${day.slice(8)}${day.slice(2, 4)}.htm`;
}

/** The agency's static TFF Futures Only report prints positions in the dealer, asset-manager, leverage, other and nonreportable columns. */
export function verifyOriginalReport(html: string, day: string, expected: ReleaseRow[]) {
  const printedDate = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const blocks = html.split(/Traders in Financial Futures - Futures Only Positions as of /);
  if (
    !blocks.shift()?.includes('Financial Traders in Markets (Futures Only)') ||
    !blocks.length ||
    blocks.some((block) => block.split(/\r?\n/, 1)[0].trim() !== printedDate)
  )
    throw new Error(`Invalid original CFTC report date or product for ${day}`);
  const seen = new Set<string>();
  for (const block of blocks) {
    const match =
      /CFTC Code #([0-9A-Z]{6})[^\S\r\n]+Open Interest is[^\S\r\n]+([\d,]+)[^\S\r\n]*\r?\nPositions[^\S\r\n]*\r?\n([^\r\n]+)/.exec(
        block
      );
    const target = expected.find((row) => row.contract === match?.[1]);
    if (!target || !match) continue;
    const position = match[3].trim().split(/\s+/);
    const headers = block.slice(0, match.index).split(/\r?\n/);
    const groups = headers
      .find((line) => line.includes('Asset Manager/'))
      ?.split(':')
      .map((name) => name.trim())
      .filter(Boolean);
    const sides = headers
      .find((line) => line.includes('Spreading'))
      ?.split(':')
      .map((name) => name.trim())
      .filter(Boolean);
    if (
      target.date !== day ||
      seen.has(target.contract) ||
      groups?.join(',') !== 'Dealer,Asset Manager/,Leveraged,Other,Nonreportable' ||
      sides?.join(',') !==
        'Long,Short,Spreading,Long,Short,Spreading,Long,Short,Spreading,Long,Short,Spreading,Long,Short' ||
      position.length !== 14 ||
      ![match[2], ...position].every((n) => /^\d{1,3}(,\d{3})*$/.test(n)) ||
      Number(match[2].replaceAll(',', '')) !== target.interest ||
      Number(position[3].replaceAll(',', '')) !== target.long ||
      Number(position[4].replaceAll(',', '')) !== target.short
    )
      throw new Error(`Original CFTC positions disagree on ${day} for ${target.contract}`);
    seen.add(target.contract);
  }
  if (seen.size !== expected.length || !seen.size)
    throw new Error(`Incomplete original CFTC positions for ${day}`);
}
