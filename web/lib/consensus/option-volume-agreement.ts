import { exchangeSession } from "./exchange-calendar.ts";
import { newYorkTimestamp } from "./time.ts";

export const OPTION_VOLUME_COMPARISON_URL = "https://ai.strasmore.com/api/demo/sql";
export const OPTION_VOLUME_COMPARISON_METHOD = "strasmore-opra-minute-volume-ny-day-v1";

type Leg = { contract: string; volume: number };
export type VolumePair = { symbol: string; call: Leg; put: Leg };
type ComparisonRow = { ticker: string; minute_rows: number; contract_volume: number;
  warehouse_timezone: string; first_bar: string; last_bar: string };

/** Match the primary source's New York calendar-day aggregation, including extended trading. */
export function optionVolumeQuery(session: string, pairs: VolumePair[]) {
  if (!exchangeSession(session) || pairs.length === 0 || pairs.length > 5) throw new Error("Invalid options comparison scope");
  const nextDay = new Date(Date.parse(session) + 86_400_000).toISOString().slice(0, 10);
  const utc = (day: string) => newYorkTimestamp(day.replaceAll("-", "") + "T000000")!.replace("T", " ").slice(0, 19);
  const first = utc(session), end = utc(nextDay);
  const tickers: string[] = [];
  for (const { symbol, call, put } of pairs) {
    if (!["SPY", "QQQ", "IWM", "DIA", "TLT"].includes(symbol)) throw new Error("Unknown options underlying");
    const contract = new RegExp(`^${symbol}(\\d{6})([CP])(\\d{8})$`);
    const c = contract.exec(call.contract), p = contract.exec(put.contract);
    if (!c || !p || c[2] !== "C" || p[2] !== "P" || c[1] !== p[1] || c[3] !== p[3] ||
        ![call.volume, put.volume, call.volume + put.volume].every(n => Number.isSafeInteger(n) && n > 0))
      throw new Error("Invalid matched options evidence");
    tickers.push("O:" + call.contract, "O:" + put.contract);
  }
  if (new Set(pairs.map(pair => pair.symbol)).size !== pairs.length) throw new Error("Duplicate options underlying");
  const sql = [
    "SELECT ticker, count() AS minute_rows, sum(volume) AS contract_volume,",
    "timeZoneOf(any(window_start)) AS warehouse_timezone, min(window_start) AS first_bar, max(window_start) AS last_bar",
    "FROM global_markets.options_minute_aggs",
    `WHERE window_start >= toDateTime('${first}', 'UTC') AND window_start < toDateTime('${end}', 'UTC')`,
    `AND ticker IN (${tickers.map(ticker => `'${ticker}'`).join(", ")}) GROUP BY ticker ORDER BY ticker`,
  ].join(" ");
  return { first, end, tickers, sql };
}

/** A missing minute series is unresolved. Equal rounded shares cannot establish agreement on either leg. */
export function compareOptionVolume(session: string, pairs: VolumePair[], text: string) {
  const query = optionVolumeQuery(session, pairs);
  const data = JSON.parse(text);
  const columns = ["ticker", "minute_rows", "contract_volume", "warehouse_timezone", "first_bar", "last_bar"];
  if (data.sql !== query.sql || data.source !== "Strasmore Research" || data.truncated !== false ||
      JSON.stringify(data.columns) !== JSON.stringify(columns) || !Array.isArray(data.rows) ||
      data.row_count !== data.rows.length || data.rows.length > query.tickers.length ||
      data.window?.verdict?.outside !== false || data.window?.verdict?.clipped !== false)
    throw new Error("Independent options query changed or its date window was truncated");
  const totals = new Map<string, number>();
  for (const row of data.rows as ComparisonRow[]) {
    const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!query.tickers.includes(row.ticker) || totals.has(row.ticker) || row.warehouse_timezone !== "UTC" ||
        !time.test(row.first_bar) || !time.test(row.last_bar) || row.first_bar < query.first || row.last_bar < row.first_bar || row.last_bar >= query.end ||
        !Number.isSafeInteger(row.minute_rows) || row.minute_rows <= 0 || row.minute_rows > 24 * 60 ||
        !Number.isSafeInteger(row.contract_volume) || row.contract_volume < row.minute_rows)
      throw new Error("Invalid independent option minute aggregate");
    totals.set(row.ticker, row.contract_volume);
  }
  return pairs.map(pair => {
    const call = totals.get("O:" + pair.call.contract), put = totals.get("O:" + pair.put.contract);
    const leg = (actual: number | undefined, original: Leg) => actual === undefined ? "missing" : actual === original.volume ? "matched" : "different";
    const callStatus = leg(call, pair.call), putStatus = leg(put, pair.put);
    if (call === undefined || put === undefined) return { symbol: pair.symbol, status: "incomplete", callStatus, putStatus, putShareDifferencePoints: null };
    if (!Number.isSafeInteger(call + put)) throw new Error("Invalid independent total volume");
    const share = (puts: number, calls: number) => Math.round(100 * puts / (puts + calls));
    return { symbol: pair.symbol, status: callStatus === "matched" && putStatus === "matched" ? "matched" : "different",
      callStatus, putStatus, putShareDifferencePoints: share(put, call) - share(pair.put.volume, pair.call.volume) };
  });
}
