import {
  INSTRUMENTS,
  type Instrument,
  type Signal,
  type Snapshot,
  type Catalyst,
} from "./types.ts";
import { eventUpcoming, newYorkDate } from "./time.ts";
import { publicDate } from "../public-normalization.ts";
import { clamp, effectiveStatus } from "./engine.ts";
import { missingSignals } from "./registry.ts";
import { REVIEWED_ISSUERS, type ReviewedTicker } from "./issuer-context.ts";

export interface ReviewedSource {
  id: string;
  name: string;
  url: string;
  publishedAt: string;
  retrievedAt: string;
  sha256: string;
  format?: "document" | "retrieved_text";
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
  ticker: ReviewedTicker;
  sourceId: string;
  periodEnd: string;
  priorPeriodEnd: string;
  revenueBillions: number;
  priorRevenueBillions: number;
  dilutedEPS: number;
  priorDilutedEPS: number;
}
export interface ReviewedGuidance {
  ticker: ReviewedTicker;
  sourceId: string;
  fiscalPeriod: string;
  revenue:
    | { kind: "range"; low: number; high: number }
    | { kind: "midpoint_tolerance"; midpoint: number; tolerancePercent: number };
  assumptions: string;
}
export interface ReviewPacket {
  schemaVersion: 1;
  reviewedAt: string;
  reviewer: string;
  sources: ReviewedSource[];
  developments: ReviewedDevelopment[];
  earnings: ReviewedEarnings[];
  guidance?: ReviewedGuidance[];
  earningsSchedule?: {
    ticker: "AAPL" | "MSFT" | "NVDA" | "AMD" | "QCOM";
    sourceId: string;
    fiscalPeriod: string;
    reportDate: string;
    releaseTiming: "before_open" | "after_close" | "date_only" | "approximate";
    approximateReleaseAt?: string;
    webcastAt?: string;
  }[];
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
  "ir.amd.com",
  "investor.qualcomm.com",
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
const ISSUER_HOSTS: Record<string, string[]> = {
  AAPL: ["www.apple.com"],
  MSFT: ["www.microsoft.com"],
  NVDA: ["investor.nvidia.com", "nvidianews.nvidia.com"],
  AMD: ["ir.amd.com"],
  QCOM: ["investor.qualcomm.com"],
};

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
    packet.earnings.length > Object.keys(REVIEWED_ISSUERS).length
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
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      (source.format !== undefined &&
        !["document", "retrieved_text"].includes(source.format))
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
    if (
      !Object.hasOwn(REVIEWED_ISSUERS, item.ticker) ||
      tickers.has(item.ticker) ||
      !source ||
      !ISSUER_HOSTS[item.ticker]?.includes(new URL(source.url).hostname) ||
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
  if (packet.guidance !== undefined) {
    if (!Array.isArray(packet.guidance) || packet.guidance.length > Object.keys(REVIEWED_ISSUERS).length)
      throw new Error("Invalid reviewed guidance");
    const guided = new Set<string>();
    for (const item of packet.guidance) {
      const source = packet.sources.find((s) => s.id === item.sourceId);
      const url = source && new URL(source.url);
      const issuerSource = url && (
        ISSUER_HOSTS[item.ticker]?.includes(url.hostname) ||
        (url.hostname === "www.sec.gov" && Object.hasOwn(REVIEWED_ISSUERS, item.ticker) &&
          url.pathname.startsWith(`/Archives/edgar/data/${REVIEWED_ISSUERS[item.ticker].cik}/`))
      );
      const range = item.revenue;
      const validRange = range && (
        (range.kind === "range" &&
          [range.low, range.high].every((n) => Number.isFinite(n) && n > 0) &&
          range.low <= range.high) ||
        (range.kind === "midpoint_tolerance" &&
          Number.isFinite(range.midpoint) && range.midpoint > 0 &&
          Number.isFinite(range.tolerancePercent) &&
          range.tolerancePercent >= 0 && range.tolerancePercent < 100 &&
          Number.isFinite(range.midpoint * (1 + range.tolerancePercent / 100)) &&
          range.midpoint * (1 - range.tolerancePercent / 100) > 0)
      );
      if (!Object.hasOwn(REVIEWED_ISSUERS, item.ticker) || guided.has(item.ticker) ||
        !issuerSource || !/^FY20\d{2} Q[1-4]$/.test(item.fiscalPeriod) ||
        !validRange || !prose(item.assumptions, 500))
        throw new Error("Invalid reviewed company guidance");
      guided.add(item.ticker);
    }
  }
  if (packet.earningsSchedule !== undefined) {
    if (
      !Array.isArray(packet.earningsSchedule) ||
      packet.earningsSchedule.length > 5
    )
      throw new Error("Invalid issuer calendar");
    const scheduled = new Set<string>();
    for (const item of packet.earningsSchedule) {
      const source = packet.sources.find((s) => s.id === item.sourceId);
      if (
        !Object.hasOwn(ISSUER_HOSTS, item.ticker) ||
        scheduled.has(item.ticker) ||
        !source ||
        !ISSUER_HOSTS[item.ticker].includes(new URL(source.url).hostname) ||
        !/^FY20\d{2} Q[1-4]$/.test(item.fiscalPeriod) ||
        !date(item.reportDate) ||
        item.reportDate.length !== 10 ||
        item.reportDate < source.publishedAt.slice(0, 10) ||
        Date.parse(item.reportDate) - Date.parse(source.publishedAt) >
          180 * 86400000 ||
        !["before_open", "after_close", "date_only", "approximate"].includes(
          item.releaseTiming,
        ) ||
        (item.releaseTiming === "approximate") !==
          (item.approximateReleaseAt !== undefined) ||
        (item.approximateReleaseAt !== undefined &&
          (!instant(item.approximateReleaseAt) ||
            newYorkDate(item.approximateReleaseAt) !== item.reportDate)) ||
        (item.webcastAt !== undefined &&
          (!instant(item.webcastAt) ||
            newYorkDate(item.webcastAt) !== item.reportDate ||
            (item.approximateReleaseAt !== undefined &&
              item.webcastAt < item.approximateReleaseAt)))
      )
        throw new Error("Invalid reviewed issuer schedule");
      scheduled.add(item.ticker);
    }
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

/** One issuer event keeps result timing distinct from the call; no invented exact release timestamp. */
export function reviewedEarningsCalendar(
  packet: ReviewPacket,
  cutoff: string,
): { signals: Signal[]; catalysts: Catalyst[] } {
  validateReview(packet, cutoff);
  const signals: Signal[] = [],
    catalysts: Catalyst[] = [];
  const clock = (at: string) =>
    new Date(at).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
  for (const item of packet.earningsSchedule ?? []) {
    if (!eventUpcoming(item.reportDate, cutoff)) continue;
    const source = packet.sources.find((s) => s.id === item.sourceId)!;
    const timing =
      item.releaseTiming === "approximate"
        ? `about ${clock(item.approximateReleaseAt!)} ET`
        : item.releaseTiming === "after_close"
          ? "after US close"
          : item.releaseTiming === "before_open"
            ? "before US open"
            : "time not supplied";
    const title = `${item.ticker} ${item.fiscalPeriod} results · ${timing}${item.webcastAt ? ` · call ${clock(item.webcastAt)} ET` : ""}`;
    catalysts.push({
      id: `issuer-earnings-${item.ticker.toLowerCase()}-${item.reportDate}`,
      at: item.reportDate,
      dateZone: "America/New_York",
      title,
      source: source.name,
      url: source.url,
      kind: "scheduled",
      importance: "major",
    });
    signals.push({
      id: `issuer-calendar-${item.ticker.toLowerCase()}`,
      family: "events",
      title: `${item.ticker} · confirmed earnings schedule`,
      shortLabel: `${item.ticker} earnings`,
      instruments: [...INSTRUMENTS],
      status: "available",
      summary: `${item.reportDate}: ${title}. The issuer's announcement was published ${source.publishedAt.slice(0, 10)}.`,
      source: {
        name: source.name,
        url: source.url,
        observedAt: source.retrievedAt,
        releasedAt: source.publishedAt,
        retrievedAt: source.retrievedAt,
        sha256: source.sha256,
        frequency: "scheduled events",
        attribution: source.name,
        usage: `Selected issuer schedule facts with attribution and direct source link. Evidence hash covers ${source.format === "retrieved_text" ? "the retrieved primary-page text extract" : "the retrieved source document"}.`,
      },
      methodology:
        "Saved subscription review of an actual issuer announcement. One date-only earnings event preserves the announced release window or approximate time, separately from a confirmed webcast time. No estimates, result, price response or directional vote is inferred.",
      limitation:
        "Selected issuers only, not a comprehensive earnings calendar. Dates may change; consult the linked issuer. A conference call time is not the results release time.",
      series: [],
      metrics: [],
      unit: "scheduled result",
      staleAfterDays: 3,
      scores: { daily: null, weekly: null, monthly: null },
    });
  }
  return { signals, catalysts };
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
  const result = signals.map((signal) => {
    const item = packet.earnings.find(
      (e) => signal.id === `earnings-${e.ticker}`,
    );
    return item ? reviewedEarningsSignal(item, packet, signal) : signal;
  });
  // A verified issuer release is sufficient evidence even when the SEC collector
  // has not created a signal for this company. This also survives full recollection.
  for (const item of packet.earnings) {
    if (!result.some((s) => s.id === `earnings-${item.ticker}`))
      result.push(reviewedEarningsSignal(item, packet));
  }
  return result;
}

function reviewedEarningsSignal(
  item: ReviewedEarnings,
  packet: ReviewPacket,
  signal?: Signal,
): Signal {
  if (
    signal?.source.observedAt &&
      signal.source.observedAt.slice(0, 10) > item.periodEnd)
    return signal;
  const source = packet.sources.find((s) => s.id === item.sourceId)!;
  const currentRevenue = signal?.metrics.find(
    (m) => m.label === "Quarter revenue",
  );
  // A newer release may supersede an older quarter, but conflicting same-period numbers need review.
  if (
    signal?.source.observedAt?.slice(0, 10) === item.periodEnd &&
    currentRevenue &&
    Math.abs(currentRevenue.value - item.revenueBillions) > 0.001
  )
    throw new Error("Conflicting same-period earnings evidence");
  const growth = (item.revenueBillions / item.priorRevenueBillions - 1) * 100,
    score = clamp(growth / 20);
  const comparison = growth === 0
    ? "unchanged from"
    : `${Math.abs(growth).toFixed(1)}% ${growth < 0 ? "below" : "above"}`;
  const issuer = REVIEWED_ISSUERS[item.ticker];
  return {
    id: `earnings-${item.ticker}`,
    family: "earnings",
    title: `${issuer.name} · reported revenue`,
    shortLabel: `${item.ticker} revenue`,
    instruments: [...issuer.instruments],
    unit: "$bn",
    staleAfterDays: 150,
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
    summary: `${item.ticker} released $${item.revenueBillions.toFixed(3)}bn quarterly revenue, ${comparison} the comparable year-earlier quarter; GAAP diluted EPS $${item.dilutedEPS.toFixed(2)}. Released ${source.publishedAt.slice(0, 10)}.`,
    methodology:
      "Reviewed company financial statement for the named quarter. Chart compares only the current and same quarter a year earlier; it is not a continuous quarterly series. YoY revenue growth /20 percentage points is the same capped context prior used for SEC results. A later-period SEC filing supersedes this saved review; conflicting same-period values require review.",
    limitation:
      "Selected company, not an index-wide earnings result. GAAP EPS is distinct from adjusted EPS and analyst expectations. Positive revenue growth does not establish an earnings surprise or market price response.",
    scores: { daily: score, weekly: score, monthly: score },
  };
}

/** Applied only when publishing; historical snapshots are never enriched retroactively. */
export function attachReview(
  snapshot: Snapshot,
  packet: ReviewPacket,
): Snapshot {
  const evidence = reviewedSignals(packet, snapshot.cutoff);
  const issuerCalendar = reviewedEarningsCalendar(packet, snapshot.cutoff);
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
          !s.id.startsWith("issuer-calendar-") &&
          s.id !== "global-news",
      ),
      packet,
      snapshot.cutoff,
    ),
    ...evidence,
    ...reviewedPolicySignals(packet, snapshot.cutoff),
    ...issuerCalendar.signals,
    ...(missing.instruments.length ? [missing] : []),
  ];
  return {
    ...snapshot,
    signals,
    review: packet,
    catalysts: [
      ...snapshot.catalysts.filter((c) => !c.id.startsWith("issuer-earnings-")),
      ...issuerCalendar.catalysts,
    ],
    collectionErrors: snapshot.collectionErrors.filter(
      (e) => !e.startsWith("global-news:"),
    ),
  };
}
