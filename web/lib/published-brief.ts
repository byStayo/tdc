import published from './published-brief.json' with { type: 'json' };
import type { ResearchResponse } from './contracts.ts';
import { validateResearch } from './research-schema.ts';

export function getPublishedBrief(now = Date.now()): ResearchResponse {
  const data = validateResearch(published.data, new Set(published.sources.map(source => source.id)));
  const stale = now - Date.parse(published.createdAt) > 72 * 60 * 60 * 1000;
  return {
    ...published,
    data,
    scope: 'market',
    status: stale ? 'stale' : 'ok',
    message: stale
      ? 'This published brief is more than 72 hours old. Treat it as historical context and check each source for new observations.'
      : published.message,
  };
}
