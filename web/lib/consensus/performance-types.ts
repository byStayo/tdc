export interface PerformanceReport {
  engineVersion: string;
  generatedAt: string;
  status: "awaiting_price_evidence" | "tracking";
  resolved: number;
  calls: number;
  abstentions: number;
  accuracy: number | null;
  brier: number | null;
  scoringPolicy?: string;
  superseded?: number;
  pending?: { snapshotId: string; instrument: string; horizon: string; reason: string }[];
  cohorts: {
    engineVersion: string;
    instrument: string;
    horizon: string;
    resolved: number;
    calls: number;
    accuracy: number | null;
    meanSignedReturnPct: number | null;
    meanBuyHoldReturnPct: number | null;
    brier: number | null;
  }[];
  learning: {
    engineVersion: string;
    instrument: string;
    horizon: string;
    samples: number;
    minimum: number;
    status: string;
    promoted: boolean;
    activeModelId?: string | null;
    reason: string;
    artifact: string;
  }[];
  note: string;
}
