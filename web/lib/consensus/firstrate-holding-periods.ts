import { resolve } from "node:path";
import type { CashDistribution } from "./corporate-adjustment.ts";
import type { SessionPrice } from "./evaluation.ts";
import { exchangeSessions } from "./exchange-calendar.ts";
import type { FIRST_RATE_SYMBOLS } from "./firstrate-technicals.ts";
import { digest } from "./history.ts";
import { firstRateIssuerActionProof, type MarketHistoryActionProof } from "./market-history-actions.ts";
import { collectMarketHistoryPriceControls, type HourlyControlProof } from "./market-history-price-controls.ts";
import { collectResearchPrices } from "./research-price-capture.ts";

type Symbol = (typeof FIRST_RATE_SYMBOLS)[number];
type SubscriberProof = { from: string; through: string; sha256: string };
type ComparisonProof = { comparison: string[]; splitComparison: string[]; marketHistory?: HourlyControlProof; subscriber?: SubscriberProof; actions?: MarketHistoryActionProof };
export type FirstRateHoldingSource = {
  provider: "market-history" | "kibot-subscriber"; from: string; through: string; approvedAt: string;
  raw: string[]; splits: string[]; subscriberDigest?: string; actions?: MarketHistoryActionProof;
};

export function firstRateHoldingSource(proof: ComparisonProof, approvedAt: string): FirstRateHoldingSource | undefined {
  if (proof.marketHistory && proof.subscriber) throw new Error("FirstRate approval names conflicting independent providers");
  const range = proof.marketHistory ?? proof.subscriber;
  if (!range) return;
  if (proof.marketHistory && (proof.marketHistory.provider !== "market-history" ||
      digest(proof.comparison) !== digest([proof.marketHistory.raw]) ||
      digest(proof.splitComparison) !== digest([proof.marketHistory.splits])))
    throw new Error("FirstRate hourly comparison differs from its pinned sources");
  return { provider: proof.marketHistory ? "market-history" : "kibot-subscriber", from: range.from, through: range.through,
    raw: proof.comparison, splits: proof.splitComparison, approvedAt,
    ...(proof.subscriber ? { subscriberDigest: proof.subscriber.sha256 } : {}), ...(proof.actions ? { actions: proof.actions } : {}) };
}

/** A larger rolling file can revise an earlier day. Only identical receipts can supersede one another. */
export function priorFirstRateHoldingSources(previous: FirstRateHoldingSource[], current: FirstRateHoldingSource) {
  const fingerprint = ({ approvedAt, ...receipt }: FirstRateHoldingSource) => digest(receipt);
  const currentId = fingerprint(current);
  const earlier = new Map<string, FirstRateHoldingSource>();
  for (const range of previous) {
    const key = fingerprint(range), prior = earlier.get(key);
    if (key !== currentId && (!prior || range.approvedAt < prior.approvedAt)) earlier.set(key, range);
  }
  return [...earlier.values()];
}

export async function readFirstRateHoldingSource(root: string, symbol: Symbol, source: FirstRateHoldingSource, asOf: string, cash: CashDistribution[]) {
  if (!Number.isFinite(Date.parse(source.approvedAt)) || new Date(source.approvedAt).toISOString() !== source.approvedAt ||
      source.approvedAt > asOf) throw new Error("Invalid FirstRate holding-period approval clock");
  const dates = exchangeSessions(source.from, source.through);
  let raw, splits;
  if (source.provider === "market-history") {
    if (!source.actions) throw new Error("FirstRate hourly control is missing its issuer action check");
    const evidence = await collectMarketHistoryPriceControls(root, symbol, dates, true, { asOf: source.approvedAt });
    const actions = await firstRateIssuerActionProof(root, symbol, source.from, source.through, cash, true, { asOf: source.approvedAt });
    if (digest(actions) !== digest(source.actions)) throw new Error("FirstRate issuer action proof changed");
    raw = evidence.raw; splits = evidence.splits;
  } else if (source.provider === "kibot-subscriber") {
    const directory = resolve(root, ".consensus/private-firstrate");
    const opts = { reviewedExchangeCalendar: true, productionRoot: root, cachedOnly: true };
    raw = await collectResearchPrices(directory, symbol, dates, opts);
    splits = await collectResearchPrices(directory, symbol, dates, { ...opts, splitAdjusted: true });
    if (source.subscriberDigest !== digest({ raw, splits }) || [...raw, ...splits].some(r => !r.paid || r.paid.capturedAt > source.approvedAt))
      throw new Error("FirstRate subscriber control changed");
  } else throw new Error("Unknown FirstRate independent provider");
  const rows = raw.flatMap(r => r.sessions);
  if (digest(source.raw) !== digest(raw.map(r => r.sha256)) || digest(source.splits) !== digest(splits.map(r => r.sha256)) ||
      digest(rows) !== digest(splits.flatMap(r => r.sessions))) throw new Error("FirstRate independent raw or split comparison changed");
  return rows;
}

/** Conflicting vintages invalidate their shared day. Different providers never supply opposite ends of a window. */
export function firstRateControlSeries(ranges: { provider: FirstRateHoldingSource["provider"]; rows: SessionPrice[] }[]) {
  const series = new Map<string, Map<string, SessionPrice | null>>();
  const disputed = new Set<string>();
  for (const { provider, rows } of ranges) {
    const dates = series.get(provider) ?? new Map<string, SessionPrice | null>();
    series.set(provider, dates);
    for (const row of rows) {
      const earlier = dates.get(row.session);
      if (earlier === undefined) dates.set(row.session, row);
      else if (earlier && (earlier.open !== row.open || earlier.close !== row.close)) {
        dates.set(row.session, null);
        disputed.add(row.session);
      }
    }
  }
  return { references: [...series.values()].map(dates => [...dates.values()].filter((row): row is SessionPrice => row !== null)), disputed };
}
