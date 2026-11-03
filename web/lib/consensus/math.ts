import type { Bar } from "../contracts.ts";

function validBars(bars: Bar[], cutoff: string): Bar[] {
  if (!Number.isFinite(Date.parse(cutoff)))
    throw new Error("Invalid observation cutoff");
  const unique = new Map<string, Bar>();
  for (const bar of bars) {
    if (
      !Number.isFinite(Date.parse(bar.time)) ||
      Date.parse(bar.time) > Date.parse(cutoff)
    )
      continue;
    if (
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        Number.isFinite,
      ) ||
      bar.low <= 0 ||
      bar.high < bar.low ||
      bar.open < bar.low ||
      bar.open > bar.high ||
      bar.close < bar.low ||
      bar.close > bar.high ||
      bar.volume < 0
    )
      continue;
    const time = new Date(bar.time).toISOString();
    if (unique.has(time)) throw new Error("Duplicate bar timestamp");
    unique.set(time, { ...bar, time });
  }
  return [...unique.values()].sort((a, b) => a.time.localeCompare(b.time));
}
export function fibonacci(bars: Bar[], cutoff: string, lookback = 20) {
  if (!Number.isInteger(lookback) || lookback < 2 || lookback > 10000)
    throw new Error("Invalid Fibonacci lookback");
  const input = validBars(bars, cutoff).slice(-lookback);
  if (input.length !== lookback) return null;
  const high = Math.max(...input.map((bar) => bar.high)),
    low = Math.min(...input.map((bar) => bar.low));
  if (high === low) return null;
  const highIndex = input.findLastIndex((bar) => bar.high === high),
    lowIndex = input.findLastIndex((bar) => bar.low === low);
  const upward = highIndex > lowIndex;
  return {
    high,
    low,
    direction: upward ? "up" : "down",
    start: input[0].time,
    end: input.at(-1)!.time,
    levels: [0.236, 0.382, 0.5, 0.618, 0.786].map((ratio) => ({
      ratio,
      value: upward ? high - (high - low) * ratio : low + (high - low) * ratio,
    })),
  };
}
export function pivotLevels(previousSession: Bar) {
  if (!validBars([previousSession], previousSession.time).length) return null;
  const { high, low, close } = previousSession,
    pivot = (high + low + close) / 3;
  return {
    pivot,
    r1: 2 * pivot - low,
    s1: 2 * pivot - high,
    r2: pivot + high - low,
    s2: pivot - high + low,
  };
}
const nyParts = (time: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(time))
      .map((part) => [part.type, part.value]),
  );
export function sessionRange(
  bars: Bar[],
  day: string,
  cutoff: string,
  kind: "premarket" | "opening",
) {
  const start = kind === "opening" ? 570 : 240,
    end = kind === "opening" ? 585 : 570;
  const parts = nyParts(cutoff),
    cutoffDay = `${parts.year}-${parts.month}-${parts.day}`;
  if (
    cutoffDay < day ||
    (cutoffDay === day && Number(parts.hour) * 60 + Number(parts.minute) < end)
  )
    return {
      status: "not_formed" as const,
      high: null,
      low: null,
      volume: null,
    };
  const input = validBars(bars, cutoff).filter((bar) => {
    const part = nyParts(bar.time),
      minutes = Number(part.hour) * 60 + Number(part.minute);
    return (
      `${part.year}-${part.month}-${part.day}` === day &&
      minutes >= start &&
      minutes < end &&
      new Date(bar.time).getUTCSeconds() === 0
    );
  });
  // Input contract is one-minute bars. A hole is missing coverage, never a flat minute.
  const minutes = new Set(input.map((bar) => bar.time.slice(0, 16)));
  if (minutes.size !== end - start)
    return {
      status: "unavailable" as const,
      high: null,
      low: null,
      volume: null,
    };
  return {
    status: "available" as const,
    high: Math.max(...input.map((bar) => bar.high)),
    low: Math.min(...input.map((bar) => bar.low)),
    volume: input.reduce((sum, bar) => sum + bar.volume, 0),
  };
}
export function normalCDF(x: number): number {
  const sign = x < 0 ? -1 : 1,
    z = Math.abs(x) / Math.sqrt(2),
    t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}
export function blackScholes(
  spot: number,
  strike: number,
  years: number,
  rate: number,
  iv: number,
  type: "call" | "put",
  dividend = 0,
) {
  if (
    ![spot, strike, years, rate, iv, dividend].every(Number.isFinite) ||
    spot <= 0 ||
    strike <= 0 ||
    years <= 0 ||
    iv <= 0
  )
    return null;
  const d1 =
      (Math.log(spot / strike) + (rate - dividend + iv ** 2 / 2) * years) /
      (iv * Math.sqrt(years)),
    d2 = d1 - iv * Math.sqrt(years);
  const s = spot * Math.exp(-dividend * years),
    k = strike * Math.exp(-rate * years);
  const price =
    type === "call"
      ? s * normalCDF(d1) - k * normalCDF(d2)
      : k * normalCDF(-d2) - s * normalCDF(-d1);
  const gamma =
    (Math.exp(-dividend * years) * Math.exp((-d1 * d1) / 2)) /
    (Math.sqrt(2 * Math.PI) * spot * iv * Math.sqrt(years));
  return {
    price,
    gamma,
    delta:
      Math.exp(-dividend * years) *
      (type === "call" ? normalCDF(d1) : normalCDF(d1) - 1),
  };
}
export function impliedVolatility(
  price: number,
  spot: number,
  strike: number,
  years: number,
  rate: number,
  type: "call" | "put",
  dividend = 0,
): number | null {
  if (
    ![price, spot, strike, years, rate, dividend].every(Number.isFinite) ||
    spot <= 0 ||
    strike <= 0 ||
    years <= 0 ||
    price <= 0
  )
    return null;
  const s = spot * Math.exp(-dividend * years),
    k = strike * Math.exp(-rate * years),
    lower = Math.max(0, type === "call" ? s - k : k - s),
    upper = type === "call" ? s : k;
  if (price <= lower || price >= upper) return null;
  let low = 0.0001,
    high = 5;
  if (
    blackScholes(spot, strike, years, rate, high, type, dividend)!.price < price
  )
    return null;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2,
      calculated = blackScholes(
        spot,
        strike,
        years,
        rate,
        mid,
        type,
        dividend,
      )!.price;
    if (calculated > price) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}
export function expectedMove(
  spot: number,
  iv: number,
  calendarDays: number,
): number | null {
  return [spot, iv, calendarDays].every(Number.isFinite) &&
    spot > 0 &&
    iv >= 0 &&
    calendarDays > 0
    ? spot * iv * Math.sqrt(calendarDays / 365)
    : null;
}
export function gammaExposure(
  contracts: {
    type: "call" | "put";
    gamma: number;
    openInterest: number;
    multiplier: number;
  }[],
  spot: number,
): number | null {
  if (
    !contracts.length ||
    !Number.isFinite(spot) ||
    spot <= 0 ||
    contracts.some(
      (c) =>
        ![c.gamma, c.openInterest, c.multiplier].every(Number.isFinite) ||
        c.gamma < 0 ||
        c.openInterest < 0 ||
        c.multiplier <= 0,
    )
  )
    return null;
  // An explicitly assumed call-positive / put-negative OI proxy, not observed dealer inventory.
  return contracts.reduce(
    (sum, c) =>
      sum +
      (c.type === "call" ? 1 : -1) *
        c.gamma *
        c.openInterest *
        c.multiplier *
        spot ** 2 *
        0.01,
    0,
  );
}
