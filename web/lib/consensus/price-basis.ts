/** Predeclared ETF target: next-session adjusted open to horizon adjusted close. */
export const OUTCOME_PRICE_BASIS = "total-return-adjusted" as const;
export function requireOutcomePriceBasis(value: unknown): void {
  if (value !== OUTCOME_PRICE_BASIS)
    throw new Error("ETF outcomes require total-return-adjusted prices including splits and distributions");
}
