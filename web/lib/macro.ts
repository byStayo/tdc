import 'server-only';
import type { Envelope, MacroSeries } from './contracts';

const SERIES: Omit<MacroSeries, 'observations'>[] = [
  { id: 'FEDFUNDS', name: 'Effective federal funds rate', unit: 'percent', frequency: 'monthly', url: 'https://fred.stlouisfed.org/series/FEDFUNDS' },
  { id: 'DPRIME', name: 'Bank prime loan rate', unit: 'percent', frequency: 'daily', url: 'https://fred.stlouisfed.org/series/DPRIME' },
  { id: 'TNWBSHNO', name: 'Household & nonprofit net worth', unit: 'millions USD', frequency: 'quarterly', url: 'https://fred.stlouisfed.org/series/TNWBSHNO' },
];

export async function getMacro(): Promise<Envelope<MacroSeries[]>> {
  const results = await Promise.allSettled(SERIES.map(async series => {
    // Public FRED download for exactly one known series; no user-controlled URL.
    const response = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series.id}`, {
      next: { revalidate: 21600 }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('FRED unavailable');
    const lines = (await response.text()).trim().split(/\r?\n/);
    if (lines[0] !== `observation_date,${series.id}` && lines[0] !== `DATE,${series.id}`) throw new Error('Unexpected FRED download');
    const observations = lines.slice(1).flatMap(line => {
      const [date, raw] = line.split(',');
      const value = raw?.trim() ? Number(raw) : NaN;
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) ? [{ date, value }] : [];
    }).slice(-60);
    if (!observations.length) throw new Error('No FRED observations');
    return { ...series, observations };
  }));
  const data = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const missing = SERIES.filter(series => !data.some(item => item.id === series.id)).map(series => series.id);
  return {
    status: data.length === SERIES.length ? 'ok' : data.length ? 'partial' : 'unavailable',
    source: 'Board of Governors of the Federal Reserve System, via FRED, Federal Reserve Bank of St. Louis',
    asOf: null, fetchedAt: new Date().toISOString(), data,
    coverage: 'Monthly FEDFUNDS, daily DPRIME, quarterly TNWBSHNO. Each series has its own observation period; values are subject to revision.',
    message: missing.length ? `FRED did not return usable data for ${missing.join(', ')}.` : 'Latest published observations, not real-time estimates. These series were cited in the original Daily Consensus research.',
  };
}
