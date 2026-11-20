import type { ResearchBrief } from './contracts.ts';

const claimSchema = {
  type: 'object', additionalProperties: false,
  properties: { text: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' } } },
  required: ['text', 'sourceIds'],
};

export const researchSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    headline: { type: 'string' }, summary: { type: 'string' },
    bull: { type: 'array', items: claimSchema },
    bear: { type: 'array', items: claimSchema },
    watch: { type: 'array', items: claimSchema },
    limitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'summary', 'bull', 'bear', 'watch', 'limitations'],
};

/** A schema-shaped answer is insufficient: every observation must cite supplied evidence. */
export function validateResearch(value: unknown, allowedIds: Set<string>): ResearchBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid research object');
  const data = value as Record<string, unknown>;
  const text = (input: unknown, limit: number) => {
    if (typeof input !== 'string' || !input.trim() || input.length > limit) throw new Error('Invalid research text');
    return input.trim();
  };
  const claims = (input: unknown) => {
    if (!Array.isArray(input) || input.length > 3) throw new Error('Invalid observation count');
    return input.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid observation');
      const claim = item as Record<string, unknown>;
      if (!Array.isArray(claim.sourceIds) || !claim.sourceIds.length || claim.sourceIds.length > 4 ||
          claim.sourceIds.some(id => typeof id !== 'string' || !allowedIds.has(id))) {
        throw new Error('Unknown or missing evidence citation');
      }
      return { text: text(claim.text, 600), sourceIds: [...new Set(claim.sourceIds as string[])] };
    });
  };
  if (!Array.isArray(data.limitations) || data.limitations.length > 8) throw new Error('Invalid limitations');
  return {
    headline: text(data.headline, 160), summary: text(data.summary, 1100),
    bull: claims(data.bull), bear: claims(data.bear), watch: claims(data.watch),
    limitations: data.limitations.map(item => text(item, 500)),
  };
}

export const RESEARCH_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META'] as const;
