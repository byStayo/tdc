export interface PerformanceReport {
  generatedAt: string;
  status: "awaiting_price_evidence" | "tracking";
  resolved: number;
  calls: number;
  abstentions: number;
  accuracy: number | null;
  brier: number | null;
  cohorts: {
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
    instrument: string;
    horizon: string;
    samples: number;
    minimum: number;
    status: string;
    promoted: boolean;
    reason: string;
    artifact: string;
  }[];
  note: string;
}
