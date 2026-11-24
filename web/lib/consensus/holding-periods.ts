import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { SESSION_HORIZONS, type SessionPrice } from "./evaluation.ts";
import { hasReviewedCalendarRange, verifyExpectedSessions } from "./exchange-calendar.ts";

type Direction = "up" | "flat" | "down";
const direction = (open: number, close: number): Direction => close > open ? "up" : close < open ? "down" : "flat";
export type HoldingPeriodComparison = {
  horizon: "weekly" | "monthly"; from: string; through: string;
  vendorDirection: Direction; referenceDirection: Direction; cashBasisVerified: boolean;
};

/** Compare exactly the dates and cash events owned by each holding period, using each source's own prior close. */
export function compareHoldingPeriods(calendar: string[], primary: SessionPrice[], independent: SessionPrice[], cash: CashDistribution[]) {
  const dates = verifyExpectedSessions(calendar, { separateIntervals: true });
  const vendor = new Map(primary.map(row => [row.session, row])), control = new Map(independent.map(row => [row.session, row]));
  if (vendor.size !== primary.length || control.size !== independent.length) throw new Error("Duplicate holding-period reference session");
  const comparisons: HoldingPeriodComparison[] = [];
  for (const horizon of ["weekly", "monthly"] as const) {
    const length = SESSION_HORIZONS[horizon];
    for (let end = length; end <= dates.length; end++) {
      const window = dates.slice(end - length, end);
      const from = window[0], through = window.at(-1)!;
      if (!hasReviewedCalendarRange(from, through) || window.some(day => !vendor.has(day) || !control.has(day))) continue;
      const actions = cash.filter(action => action.session > from && action.session <= through);
      const left = window.map(day => vendor.get(day)!), right = window.map(day => control.get(day)!);
      const adjustedDirection = (rows: SessionPrice[]) => {
        const adjusted = actions.length ? adjustETFPrices(rows, actions, []) : rows;
        return direction(adjusted[0].open, adjusted.at(-1)!.close);
      };
      const cashBasisVerified = actions.every(action => {
        const prior = window.indexOf(action.session) - 1;
        return prior >= 0 && Math.abs(left[prior].close - right[prior].close) < action.amount / 2;
      });
      comparisons.push({ horizon, from, through, vendorDirection: adjustedDirection(left),
        referenceDirection: adjustedDirection(right), cashBasisVerified });
    }
  }
  return comparisons;
}

export function confirmedHoldingPeriods(calendar: string[], primary: SessionPrice[], references: SessionPrice[][], cash: CashDistribution[],
  published: SessionPrice[]) {
  const normalized = new Map(published.map(row => [row.session, row]));
  const accepted = { weekly: new Map<string, boolean>(), monthly: new Map<string, boolean>() };
  // A single control series must span the entire target. Every complete series must agree.
  for (const reference of references) for (const row of compareHoldingPeriods(calendar, primary, reference, cash)) {
    const exits = accepted[row.horizon];
    const entry = normalized.get(row.from), exit = normalized.get(row.through);
    exits.set(row.through, exits.get(row.through) !== false && row.cashBasisVerified && row.vendorDirection === row.referenceDirection &&
      !!entry && !!exit && direction(entry.open, exit.close) === row.vendorDirection);
  }
  const verified = (days: Map<string, boolean>) => [...days.keys()].filter(day => days.get(day)).sort();
  return { weekly: verified(accepted.weekly), monthly: verified(accepted.monthly) };
}
