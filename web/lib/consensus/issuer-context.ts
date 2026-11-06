import type { Instrument } from "./types.ts";

/** Editorial context scopes, not index weights or a constituent-level return model. */
export const REVIEWED_ISSUERS = {
  AAPL: { name: "Apple", cik: "320193", instruments: ["MARKET", "SPY", "QQQ", "DIA"] },
  MSFT: { name: "Microsoft", cik: "789019", instruments: ["MARKET", "SPY", "QQQ", "DIA"] },
  NVDA: { name: "NVIDIA", cik: "1045810", instruments: ["MARKET", "SPY", "QQQ", "DIA"] },
  AMD: { name: "AMD", cik: "2488", instruments: ["MARKET", "SPY", "QQQ"] },
  QCOM: { name: "Qualcomm", cik: "804328", instruments: ["MARKET", "SPY", "QQQ"] },
} satisfies Record<string, { name: string; cik: string; instruments: Instrument[] }>;

export type ReviewedTicker = keyof typeof REVIEWED_ISSUERS;
