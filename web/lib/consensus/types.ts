export const HORIZONS = ["daily", "weekly", "monthly"] as const;
export type Horizon = (typeof HORIZONS)[number];
export const INSTRUMENTS = [
  "MARKET",
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "TLT",
] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export type Family =
  | "social"
  | "retail"
  | "institutions"
  | "options"
  | "technicals"
  | "premarket"
  | "events"
  | "analysts"
  | "news"
  | "earnings"
  | "liquidity"
  | "rates"
  | "fx"
  | "international"
  | "capital";
export type SignalStatus = "available" | "stale" | "unavailable" | "not_formed";
export interface Point {
  date: string;
  value: number;
}
export interface Metric {
  label: string;
  value: number;
  unit: string;
  date: string;
}
export interface Provenance {
  name: string;
  url: string;
  retrievedAt: string;
  observedAt: string | null;
  releasedAt: string | null;
  /** Provider page or archive revision, separate from the observation and original release. */
  vintageAt?: string;
  /** Time the publisher approved the captured source for use. */
  approvedAt?: string;
  frequency: string;
  attribution: string;
  usage: string;
  sha256: string | null;
}
export interface Signal {
  id: string;
  family: Family;
  title: string;
  shortLabel: string;
  instruments: Instrument[];
  /** When present, other instruments retain context but cannot receive its vote. */
  directionalInstruments?: Instrument[];
  status: SignalStatus;
  summary: string;
  source: Provenance;
  methodology: string;
  limitation: string;
  collectionNote?: string;
  failureKind?: "transport" | "validation";
  series: Point[];
  metrics: Metric[];
  scores: Record<Horizon, number | null>;
  staleAfterDays: number;
  unit: string;
  /** Original management range and a separately filed consolidated quarterly result. */
  issuerGuidance?: import("./issuer-guidance-match.ts").IssuerGuidanceMatch;
  /** First-release Treasury components with their own observation and publication clock. */
  ticRelease?: import("./tic-release.ts").TicReleaseEvidence;
  schwabRetailFlows?: import("./schwab-retail-flows.ts").SchwabRetailFlowsEvidence;
  etfFlowPeers?: import("./etf-flow-peers.ts").FlowPeers;
  blsPayrollNews?: import("./bls-payroll-news.ts").BlsPayrollNewsEvidence;
  /** Aggregate coverage for two adjacent Oregon public pension schedules. */
  operfCapital?: import("./operf-capital.ts").OperfEvidence;
  /** Reviewed Fed release metadata; stored with the edition, never inferred from today's release. */
  privateCredit?: {
    reviewVersion: "fed-private-credit-v1";
    inputThrough: string;
    documentation: { url: string; sha256: string };
  };
  householdEquity?: {
    seriesId: "FA153064105.Q";
    publicationClock: "date-only";
    /** v2: actual first product collection of this native vintage, never the quarter end. */
    firstObservedAt: string;
    firstObservedSHA256: string;
    methodBreakRelease: "2026-09-11";
    revisedDefinitionFrom: "2012-10-01";
  } & ({ reviewVersion: "fed-household-equity-v1"; quarter: "2026:Q2" } | {
    reviewVersion: "fed-household-equity-v2";
    quarter: string;
    /** Native row and definition identity, independent of incidental page HTML. */
    seriesRowSHA256: string;
    nativeSHA256: string;
    firstEvidenceRetrievedAt: string;
    publicationEvidence: { url: string; sha256: string; retrievedAt: string };
    unitEvidence: { url: string; sha256: string; retrievedAt: string };
  });
  /** Validation guard through outages/rejected revisions; never an available observation. */
  householdEquityCheckpoint?: {
    source: Provenance;
    point: Point;
    receipt: NonNullable<Signal["householdEquity"]>;
  };
}
export interface Catalyst {
  id: string;
  title: string;
  at: string;
  url: string;
  source: string;
  kind: "release" | "scheduled" | "expiry";
  importance: "context" | "major";
  /** Local calendar date only. Timestamped events carry their offset in `at`. */
  dateZone?: import("./time.ts").CalendarZone;
}
export interface FamilyDefinition {
  id: Family;
  label: string;
  detail: string;
  weight: number;
}
export interface FamilyReading {
  id: Family;
  label: string;
  score: number | null;
  weight: number;
  available: number;
  expected: number;
  status: SignalStatus;
}
export interface Consensus {
  instrument: Instrument;
  horizon: Horizon;
  score: number | null;
  label: string;
  coverage: number;
  /** Weighted share of families with a vote; absent on legacy rule versions. */
  directionalCoverage?: number;
  agreement: number | null;
  bullish: number;
  bearish: number;
  neutral: number;
  abstain: boolean;
  reasons: string[];
  families: FamilyReading[];
}
export interface Snapshot {
  schemaVersion: 1;
  id: string;
  issuedAt: string;
  cutoff: string;
  engineVersion: string;
  origin: "prospective";
  signals: Signal[];
  catalysts: Catalyst[];
  sourcesAttempted: number;
  collectionErrors: string[];
  /** Complete frozen results for new publications; legacy editions use a pinned engine. */
  consensus?: Consensus[];
  evaluationAnchors?: import("./learning-audit").EvaluationAnchor[];
  forecasts?: import("./model").Forecast[];
  news?: import("./news").NewsPulse;
  review?: import("./reviewed").ReviewPacket;
  holdings?: import("./holdings").InstitutionalHoldings[];
  /** Scoped trade-volume observation, outside the scored options-risk input. */
  optionActivity?: import("./option-activity").OptionActivity;
  /** Dated daily technical context, separate from the scored family inputs. */
  regularSessionRanges?: import("./regular-session-range").SessionRanges;
}
export interface HistoryEntry {
  id: string;
  issuedAt: string;
  sha256: string;
  engineVersion: string;
}
export interface Outcome {
  calendarVersion?: string;
  engineVersion: string;
  snapshotId: string;
  instrument: Instrument;
  horizon: Horizon;
  issuedAt: string;
  entryAt: string;
  exitAt: string;
  entry: number;
  exit: number;
  predictedScore: number | null;
  predictedProbability: number | null;
  abstained: boolean;
  returnPct: number;
  directionCorrect: boolean | null;
  source: string;
  adjustment: string;
}
