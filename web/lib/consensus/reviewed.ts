import {
  INSTRUMENTS,
  type Instrument,
  type Signal,
  type Snapshot,
} from "./types.ts";
import { publicDate } from "../public-normalization.ts";
import { clamp, effectiveStatus } from "./engine.ts";
import { missingSignals } from "./registry.ts";

export interface ReviewedSource {
  id: string;
  name: string;
  url: string;
  publishedAt: string;
  retrievedAt: string;
  sha256: string;
}
export interface ReviewedDevelopment {
  id: string;
  title: string;
  facts: string;
  sourceIds: string[];
  impacts: {
    instrument: Instrument;
    channel: string;
    interpretation: string;
  }[];
  limitation: string;
}
export interface ReviewedEarnings {
  ticker: "AAPL" | "MSFT" | "NVDA";
  sourceId: string;
  periodEnd: string;
  priorPeriodEnd: string;
  revenueBillions: number;
  priorRevenueBillions: number;
  dilutedEPS: number;
  priorDilutedEPS: number;
}
export interface ReviewPacket {
  schemaVersion: 1;
  reviewedAt: string;
  reviewer: string;
  sources: ReviewedSource[];
  developments: ReviewedDevelopment[];
  earnings: ReviewedEarnings[];
  policies?: {
    bank: "BOJ";
    sourceId: string;
    rate: number;
    qualification: "approximate";
  }[];
}
const HOSTS = new Set([
  "www.apple.com",
  "www.microsoft.com",
  "investor.nvidia.com",
  "nvidianews.nvidia.com",
  "www.federalreserve.gov",
  "www.ecb.europa.eu",
  "www.boj.or.jp",
  "www.bankofengland.co.uk",
  "www.bls.gov",
  "www.bea.gov",
  "home.treasury.gov",
  "www.sec.gov",
]);
const instant = (s: string) =>
  typeof s === "string" &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;
const date = (s: string) =>
  typeof s === "string" && !!publicDate(s) && (s.length === 10 || instant(s));
const prose = (s: string, max: number) =>
  typeof s === "string" && s.trim().length >= 8 && s.length <= max;

/** Structural/provenance checks do not replace the publisher's factual review. */
export function validateReview(packet: ReviewPacket, cutoff: string): void {
  if (
    !instant(cutoff) ||
    packet.schemaVersion !== 1 ||
    !instant(packet.reviewedAt) ||
    packet.reviewedAt > cutoff ||
    !prose(packet.reviewer, 100) ||
    !Array.isArray(packet.sources) ||
    !packet.sources.length ||
    packet.sources.length > 20 ||
    !Array.isArray(packet.developments) ||
    packet.developments.length > 12 ||
    !Array.isArray(packet.earnings) ||
    packet.earnings.length > 3
  )
    throw new Error("Invalid reviewed evidence packet");
  const ids = new Set<string>();
  for (const source of packet.sources) {
    const u = new URL(source.url);
    if (
      !/^[a-z0-9-]{3,80}$/.test(source.id) ||
      ids.has(source.id) ||
      !prose(source.name, 120) ||
      u.protocol !== "https:" ||
      !HOSTS.has(u.hostname) ||
      u.username ||
      u.password ||
      u.port ||
      /(?:token|secret|api[_-]?key|password)=/i.test(u.search) ||
      !date(source.publishedAt) ||
      !instant(source.retrievedAt) ||
      source.retrievedAt > packet.reviewedAt ||
      Date.parse(source.publishedAt) > Date.parse(source.retrievedAt) ||
      !/^[a-f0-9]{64}$/.test(source.sha256)
    )
      throw new Error("Invalid reviewed source provenance");
    ids.add(source.id);
  }
  const records = new Set<string>();
  for (const item of packet.developments) {
    if (
      !/^[a-z0-9-]{3,80}$/.test(item.id) ||
      records.has(item.id) ||
      !prose(item.title, 150) ||
      !prose(item.facts, 700) ||
      !prose(item.limitation, 500) ||
      !Array.isArray(item.sourceIds) ||
      !item.sourceIds.length ||
      new Set(item.sourceIds).size !== item.sourceIds.length ||
      item.sourceIds.some((id) => !ids.has(id)) ||
      !Array.isArray(item.impacts) ||
      !item.impacts.length ||
      new Set(item.impacts.map((i) => i.instrument)).size !==
        item.impacts.length ||
      item.impacts.some(
        (i) =>
          !INSTRUMENTS.includes(i.instrument) ||
          !prose(i.channel, 80) ||
          !prose(i.interpretation, 500),
      )
    )
      throw new Error("Invalid reviewed development");
    records.add(item.id);
  }
  const tickers = new Set<string>();
  for (const item of packet.earnings) {
    const source = packet.sources.find((s) => s.id === item.sourceId);
    const lag = Date.parse(item.periodEnd) - Date.parse(item.priorPeriodEnd);
    const companyHosts: Record<string, string[]> = {
      AAPL: ["www.apple.com"],
      MSFT: ["www.microsoft.com"],
      NVDA: ["investor.nvidia.com", "nvidianews.nvidia.com"],
    };
    if (
      !["AAPL", "MSFT", "NVDA"].includes(item.ticker) ||
      tickers.has(item.ticker) ||
      !source ||
      !companyHosts[item.ticker]?.includes(new URL(source.url).hostname) ||
      !date(item.periodEnd) ||
      item.periodEnd.length !== 10 ||
      !date(item.priorPeriodEnd) ||
      item.priorPeriodEnd.length !== 10 ||
      item.periodEnd > source.publishedAt.slice(0, 10) ||
      lag < 350 * 86400000 ||
      lag > 380 * 86400000 ||
      ![item.revenueBillions, item.priorRevenueBillions].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      ![item.dilutedEPS, item.priorDilutedEPS].every(Number.isFinite)
    )
      throw new Error("Invalid reviewed earnings facts");
    tickers.add(item.ticker);
  }
  if (packet.policies !== undefined) {
    if (!Array.isArray(packet.policies) || packet.policies.length > 1)
      throw new Error("Invalid policy review");
    for (const item of packet.policies) {
      const source = packet.sources.find((s) => s.id === item.sourceId);
      if (
        item.bank !== "BOJ" ||
        item.qualification !== "approximate" ||
        !source ||
        new URL(source.url).hostname !== "www.boj.or.jp" ||
        !Number.isFinite(item.rate) ||
        item.rate < -20 ||
        item.rate > 100
      )
        throw new Error("Invalid reviewed policy decision");
    }
  }
}

export function reviewedPolicySignals(
  packet: ReviewPacket,
  cutoff: string,
): Signal[] {
  validateReview(packet, cutoff);
  return (packet.policies ?? []).map((item) => {
    const source = packet.sources.find((s) => s.id === item.sourceId)!;
    return {
      id: "policy-reviewed-boj",
      title: "Bank of Japan · overnight target",
      shortLabel: "Bank of Japan target",
      family: "international",
      instruments: [...INSTRUMENTS],
      status: "available",
      summary: `The Bank of Japan's ${source.publishedAt.slice(0, 10)} decision sets an approximate ${item.rate.toFixed(2)}% overnight call-rate target.`,
      source: {
        name: source.name,
        url: source.url,
        observedAt: source.publishedAt,
        releasedAt: source.publishedAt,
        retrievedAt: source.retrievedAt,
        sha256: source.sha256,
        frequency: "reviewed policy decision",
        attribution: "Bank of Japan",
        usage:
          "Selected policy fact with original-source attribution for this free noncommercial publication",
      },
      methodology:
        "Saved subscription review of the official policy decision. The target is approximate, not a measured overnight market rate. It is dated to the decision and carries no directional vote.",
      limitation:
        "A decision can be superseded before the next review. This is a dated target, not a live rate quote, forward curve or currency trade signal.",
      series: [{ date: source.publishedAt.slice(0, 10), value: item.rate }],
      metrics: [
        {
          label: "Approximate overnight target",
          value: item.rate,
          unit: "%",
          date: source.publishedAt.slice(0, 10),
        },
      ],
      unit: "%",
      staleAfterDays: 60,
      scores: { daily: null, weekly: null, monthly: null },
    };
  });
}

export function reviewedSignals(
  packet: ReviewPacket,
  cutoff: string,
): Signal[] {
  validateReview(packet, cutoff);
  return packet.developments.map((item) => {
    const first = packet.sources.find((s) => s.id === item.sourceIds[0])!;
    const published = first.publishedAt;
    return {
      id: `review-${item.id}`,
      family: "news",
      title: item.title,
      shortLabel: item.title,
      instruments: item.impacts.map((i) => i.instrument),
      status: "available",
      summary: item.facts,
      source: {
        name: first.name,
        url: first.url,
        retrievedAt: first.retrievedAt,
        observedAt: published,
        releasedAt: published,
        frequency: "reviewed primary-source development",
        attribution: first.name,
        usage:
          "Cited factual summary and separately labelled editorial interpretation; original text stays with the publisher",
        sha256: first.sha256,
      },
      methodology:
        "Source-checked facts saved by the subscription publisher. Instrument-specific transmission channels are editorial interpretation, not measured price reactions or calibrated forecasts. No directional vote; the related earnings or rates family contains its separately defined quantitative inputs. The full review packet retains all supporting citations and its review timestamp.",
      limitation: item.limitation,
      series: [],
      metrics: [],
      unit: "",
      staleAfterDays: 7,
      scores: { daily: null, weekly: null, monthly: null },
    };
  });
}

export function applyReviewedEarnings(
  signals: Signal[],
  packet: ReviewPacket,
  cutoff: string,
): Signal[] {
  validateReview(packet, cutoff);
  return signals.map((signal) => {
    const item = packet.earnings.find(
      (e) => signal.id === `earnings-${e.ticker}`,
    );
    if (
      !item ||
      (signal.source.observedAt &&
        signal.source.observedAt.slice(0, 10) > item.periodEnd)
    )
      return signal;
    const source = packet.sources.find((s) => s.id === item.sourceId)!;
    const currentRevenue = signal.metrics.find(
      (m) => m.label === "Quarter revenue",
    );
    // A newer release may supersede an older quarter, but conflicting same-period numbers need review.
    if (
      signal.source.observedAt?.slice(0, 10) === item.periodEnd &&
      currentRevenue &&
      Math.abs(currentRevenue.value - item.revenueBillions) > 0.001
    )
      throw new Error("Conflicting same-period earnings evidence");
    const growth = (item.revenueBillions / item.priorRevenueBillions - 1) * 100,
      score = clamp(growth / 20);
    return {
      ...signal,
      status: "available",
      collectionNote: undefined,
      source: {
        name: source.name,
        url: source.url,
        retrievedAt: source.retrievedAt,
        observedAt: item.periodEnd,
        releasedAt: source.publishedAt,
        frequency: "quarterly company release",
        attribution: source.name,
        usage:
          "Selected factual financial figures with original-source attribution",
        sha256: source.sha256,
      },
      series: [
        { date: item.priorPeriodEnd, value: item.priorRevenueBillions },
        { date: item.periodEnd, value: item.revenueBillions },
      ],
      metrics: [
        {
          label: "Quarter revenue",
          value: item.revenueBillions,
          unit: "$bn",
          date: item.periodEnd,
        },
        {
          label: "Year-over-year revenue change",
          value: growth,
          unit: "%",
          date: item.periodEnd,
        },
        {
          label: "GAAP diluted EPS",
          value: item.dilutedEPS,
          unit: "$ / share",
          date: item.periodEnd,
        },
        {
          label: "Prior-year GAAP diluted EPS",
          value: item.priorDilutedEPS,
          unit: "$ / share",
          date: item.priorPeriodEnd,
        },
      ],
      summary: `${item.ticker} released $${item.revenueBillions.toFixed(3)}bn quarterly revenue, ${growth.toFixed(1)}% above the comparable year-earlier quarter; GAAP diluted EPS $${item.dilutedEPS.toFixed(2)}. Released ${source.publishedAt.slice(0, 10)}.`,
      methodology:
        "Reviewed company financial statement for the named quarter. Chart compares only the current and same quarter a year earlier; it is not a continuous quarterly series. YoY revenue growth /20 percentage points is the same capped context prior used for SEC results. A later-period SEC filing supersedes this saved review; conflicting same-period values require review.",
      limitation:
        "Selected company, not an index-wide earnings result. GAAP EPS is distinct from adjusted EPS and analyst expectations. Positive revenue growth does not establish an earnings surprise or market price response.",
      scores: { daily: score, weekly: score, monthly: score },
    };
  });
}

/** Applied only when publishing; historical snapshots are never enriched retroactively. */
export function attachReview(
  snapshot: Snapshot,
  packet: ReviewPacket,
): Snapshot {
  const evidence = reviewedSignals(packet, snapshot.cutoff);
  const covered = new Set(
    evidence
      .filter((s) => effectiveStatus(s, snapshot.cutoff) === "available")
      .flatMap((s) => s.instruments),
  );
  const missing = missingSignals(snapshot.cutoff).find(
    (s) => s.id === "global-news",
  )!;
  missing.instruments = missing.instruments.filter(
    (instrument) => !covered.has(instrument),
  );
  const signals = [
    ...applyReviewedEarnings(
      snapshot.signals.filter(
        (s) =>
          !s.id.startsWith("review-") &&
          !s.id.startsWith("policy-reviewed-") &&
          s.id !== "global-news",
      ),
      packet,
      snapshot.cutoff,
    ),
    ...evidence,
    ...reviewedPolicySignals(packet, snapshot.cutoff),
    ...(missing.instruments.length ? [missing] : []),
  ];
  return {
    ...snapshot,
    signals,
    review: packet,
    collectionErrors: snapshot.collectionErrors.filter(
      (e) => !e.startsWith("global-news:"),
    ),
  };
}
