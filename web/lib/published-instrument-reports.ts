import spy from './published-instruments/SPY.json' with { type: 'json' };
import qqq from './published-instruments/QQQ.json' with { type: 'json' };
import iwm from './published-instruments/IWM.json' with { type: 'json' };
import dia from './published-instruments/DIA.json' with { type: 'json' };
import tlt from './published-instruments/TLT.json' with { type: 'json' };
import type { ResearchResponse } from './contracts.ts';
import { instrumentReport } from './instrument-reports.ts';
import { validateResearch } from './research-schema.ts';

const PUBLICATIONS = { SPY: spy, QQQ: qqq, IWM: iwm, DIA: dia, TLT: tlt };

/** Static, reviewed publications only. No network or model call occurs on a read. */
export function getPublishedInstrumentBrief(symbol: string, now = Date.now()): ResearchResponse {
  const descriptor = instrumentReport(symbol);
  if (!descriptor) return {
    status: 'unconfigured', scope: 'instrument', symbol, data: null,
    message: `No published instrument report is available for ${symbol}. Choose SPY, QQQ, IWM, DIA or TLT. The market-wide edition is available in Daily Brief.`,
  };
  const publication = PUBLICATIONS[descriptor.symbol];
  if (publication.scope !== 'instrument' || publication.symbol !== symbol) throw new Error('Instrument publication identity mismatch');
  const data = validateResearch(publication.data, new Set(publication.sources.map(source => source.id)));
  const stale = now - Date.parse(publication.createdAt) > 72 * 60 * 60 * 1000;
  return {
    ...publication, data, scope: 'instrument', status: stale ? 'stale' : 'ok',
    message: stale
      ? `This published ${symbol} report is more than 72 hours old. Treat it as historical context and check each source for new observations.`
      : publication.message,
  };
}
