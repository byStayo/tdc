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
}
export interface HistoryEntry {
  id: string;
  issuedAt: string;
  sha256: string;
  engineVersion: string;
}
export interface Outcome {
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
