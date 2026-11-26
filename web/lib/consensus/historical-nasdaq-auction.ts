import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MarketHistoryETF } from "./market-history-boundaries.ts";
import { readResearchReceipt } from "./research-price-capture.ts";

/** Exact executed crosses from the complete, independently reviewed November 2025 Nasdaq ITCH session. */
export async function historicalNasdaqAuction(root: string, symbol: MarketHistoryETF, day: string) {
  if (day !== "2025-11-28" || (symbol !== "QQQ" && symbol !== "TLT")) return undefined;
  const file = resolve(root, ".consensus/private-nasdaq-crosses/2025-11-28-e965ea6f9779.json");
  const record = await readResearchReceipt<{ comparison: { symbol: string; open: { price: number }; close: { price: number } }[] }>(file);
  if (!record) return undefined;
  if (createHash("sha256").update(await readFile(file)).digest("hex") !== "2cc16cfd6ff2b5f8051384488352a7c6df2350e6f47acb23dca79ae8d0f0d485")
    throw new Error("Reviewed 2025 shortened-session auction evidence changed");
  const cross = record.comparison.find(row => row.symbol === symbol);
  if (!cross) throw new Error("Reviewed auction omitted the requested listing");
  return { session: day, open: cross.open.price, close: cross.close.price };
}
