import { publicDate } from "../public-normalization.ts";
import { policyCsv } from "./policy.ts";
import { TAIWAN_DATA_AGENCY, TAIWAN_LICENSE_URL, TAIWAN_OPEN_DATA_NOTICE } from "./taiwan-attribution.ts";
import type { Signal } from "./types.ts";

export const TWSE_SECTOR_ID = "taiwan-semiconductor-relative";
export const TWSE_SECTOR_CATALOG = "https://data.gov.tw/dataset/11555";
export const TWSE_SECTOR_DIRECTORY = ".consensus/private-twse-sector";
const host = "https://www.twse.com.tw/";
const broad = "發行量加權股價指數",
  sector = "半導體類指數";
const fields = ["指數", "收盤指數", "漲跌(+/-)", "漲跌點數", "漲跌百分比(%)", "特殊處理註記"];
const header = ["日期", "指數/報酬指數", ...fields.slice(1)];
const dateOnly = (v: string) => /^\d{4}-\d\d-\d\d$/.test(v) && publicDate(v) === v;
const instant = (v: string) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const roc = (d: string) => String(Number(d.slice(0, 4)) - 1911) + d.slice(5).replace("-", "");
export const taiwanOpenAt = (date: string) => (dateOnly(date) ? date + "T01:00:00.000Z" : "");
const taiwanCloseAt = (date: string) => date + "T05:30:00.000Z";

export function twseSectorUrls(date: string) {
  if (!dateOnly(date)) throw Error("Invalid TWSE date");
  const compact = date.replaceAll("-", "");
  return {
    csv: host + "exchangeReport/MI_INDEX?response=open_data&date=" + compact,
    report: host + "exchangeReport/MI_INDEX?date=" + compact + "&type=IND&response=json",
    calendar: host + "holidaySchedule/holidaySchedule?response=open_data&date=" + compact.slice(0, 4) + "0101",
  };
}

type Bucket = { close: number; change: number; percent: number };
export type SectorPair = { market: Bucket; sector: Bucket };
function hundredths(text: unknown, signed = false) {
  if (
    typeof text !== "string" ||
    !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(text) ||
    (!signed && text.startsWith("-"))
  )
    throw Error("Invalid fixed-precision TWSE index field");
  const value = Number(text.replace(/[,.]/g, ""));
  if (!Number.isSafeInteger(value)) throw Error("TWSE index field exceeds exact precision");
  return value;
}
function bucket(row: string[]): Bucket {
  if (row.length !== 6 || row[5] !== "" || !["+", "-", "", " "].includes(row[2]))
    throw Error("Unverified or flagged TWSE price index");
  const close = hundredths(row[1]),
    magnitude = hundredths(row[3]),
    percent = hundredths(row[4], true);
  const change = row[2] === "-" ? -magnitude : magnitude,
    previous = close - change;
  if (
    !(close > 0 && previous > 0) ||
    (row[2].trim() === "") !== (magnitude === 0) ||
    (percent !== 0 && Math.sign(percent) !== Math.sign(change)) ||
    Math.abs(percent - (10_000 * change) / previous) > 0.501
  )
    throw Error("TWSE level, signed point change and rounded percentage disagree");
  return { close, change, percent };
}
function two(rows: string[][]): SectorPair {
  const get = (name: string) => {
    const matches = rows.filter((r) => Array.isArray(r) && r[0] === name);
    if (matches.length !== 1) throw Error("Expected one native TWSE price-index row");
    return bucket(matches[0]);
  };
  return { market: get(broad), sector: get(sector) };
}

export function datedSectorCsv(body: string, date: string): string[][] {
  const [columns, ...rows] = policyCsv(body.replace(/^\uFEFF/, ""));
  if (
    !dateOnly(date) ||
    columns?.join("|") !== header.join("|") ||
    !rows.length ||
    rows.length > 700 ||
    rows.some((r) => r.length !== 7 || r[0] !== roc(date))
  )
    throw Error("TWSE catalogue CSV differs from the requested session or schema");
  return rows.map((r) => r.slice(1));
}
export function datedSectorReport(body: string, date: string): string[][] {
  if (!dateOnly(date) || body.length > 2_000_000) throw Error("Invalid dated TWSE report");
  const compact = date.replaceAll("-", ""),
    data = JSON.parse(body);
  const matchesDate = (title: string) => {
    const match = /^(\d{2,3})年(\d{1,2})月(\d{1,2})日 價格指數\(臺灣證券交易所\)$/.exec(title);
    return (
      match &&
      [String(Number(match[1]) + 1911), match[2].padStart(2, "0"), match[3].padStart(2, "0")].join("-") === date
    );
  };
  if (
    data.stat !== "OK" ||
    data.date !== compact ||
    data.params?.date !== compact ||
    data.params?.type !== "IND" ||
    data.params?.controller !== "afterTrading" ||
    data.params?.action !== "MI_INDEX" ||
    data.params?.lang !== "zh" ||
    !Array.isArray(data.tables) ||
    data.tables.length > 30
  )
    throw Error("TWSE dated market report is missing its expected identity");
  const tabs = data.tables.filter((t: { title: string }) => matchesDate(t.title));
  if (tabs.length !== 1 || tabs[0].fields?.join("|") !== fields.join("|") || !Array.isArray(tabs[0].data))
    throw Error("TWSE stock-exchange price index table missing");
  const rows = tabs[0].data.filter((row: string[]) => Array.isArray(row) && [sector, broad].includes(row[0]));
  return rows.map((row: string[]) => {
    const sign =
      typeof row[2] === "string" ? row[2].replace(/^<p style\s*=\s*'color:(?:red|green)'>([+-])<\/p>$/i, "$1") : null;
    return [...row.slice(0, 2), sign, ...row.slice(3)];
  });
}
export const parseSectorCsv = (body: string, date: string) => two(datedSectorCsv(body, date));
export const parseSectorReport = (body: string, date: string) => two(datedSectorReport(body, date));

/** The annual exchange calendar also lists trading days on which work resumes. Require the actual dated prices as well. */
export function calendarAllowsTaiwan(body: string, date: string) {
  if (!dateOnly(date)) throw Error("Invalid Taiwan calendar date");
  const [columns, ...rows] = policyCsv(body.replace(/^\uFEFF/, "")),
    y = date.slice(0, 4),
    prefix = String(Number(y) - 1911);
  if (
    columns?.join("|") !== "名稱|日期|星期|說明" ||
    rows.length < 10 ||
    rows.length > 80 ||
    !rows.some((r) => r[0] === "國曆新年開始交易日") ||
    !rows.some((r) => r[0] === "農曆春節後開始交易日")
  )
    throw Error("Unknown TWSE annual holiday calendar");
  const known = new Map<string, string>(),
    weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  for (const [name, rawDay, weekday, ...rest] of rows) {
    const iso = y + "-" + rawDay.slice(-4, -2) + "-" + rawDay.slice(-2);
    if (
      !rawDay.startsWith(prefix) ||
      rawDay.length !== prefix.length + 4 ||
      !name ||
      !dateOnly(iso) ||
      rest.length !== 1 ||
      weekday !== weekdays[new Date(iso).getUTCDay()] ||
      known.has(iso)
    )
      throw Error("TWSE calendar date or year changed");
    known.set(iso, name);
  }
  const weekday = new Date(date).getUTCDay(),
    special = known.get(date);
  return (
    weekday !== 0 &&
    weekday !== 6 &&
    (!special || ["國曆新年開始交易日", "農曆春節前最後交易日", "農曆春節後開始交易日"].includes(special))
  );
}

const method =
  "Prior U.S. session's dated Taiwan semiconductor price-index percentage change minus the broad TAIEX price-index percentage change. Both signed percentages are verified against the official point change and closing level in two TWSE deliveries.";
const limit =
  "Taiwan semiconductor and broad market indices share constituents. The spread is one QQQ research input. Taiwan market holidays, inconsistent reports and shortened U.S. targets cannot supply a study outcome.";
const usage =
  "Open Government Data License 1.0, datasets 11555 and 11761. TWSE index performance and the Taiwan trading calendar are used for attributed analysis. Relative performance calculated by The Daily Consensus.";
function credit(year: string) {
  return (
    TAIWAN_DATA_AGENCY +
    " " +
    year +
    " After-market information – Daily closing market information – Market statistics and The opening (closing) dates of the centralized securities trading market (dataset versions not stated). " +
    TAIWAN_OPEN_DATA_NOTICE +
    " " +
    TAIWAN_LICENSE_URL +
    ". Selection and relative performance by The Daily Consensus."
  );
}
export function sectorSignal(
  at: string,
  data?: { date: string; firstAt: string; seal: string; pair: SectorPair },
): Signal {
  const date = data?.date,
    source = {
      name: "Taiwan Stock Exchange · Daily closing market statistics",
      url: TWSE_SECTOR_CATALOG,
      retrievedAt: data?.firstAt ?? at,
      observedAt: date ?? null,
      releasedAt: null,
      frequency: "daily Taiwan end of day",
      attribution: credit((date ?? at).slice(0, 4)),
      usage,
      sha256: data?.seal ?? null,
      ...(data && { vintageAt: data.firstAt }),
    };
  const signal: Signal = {
    id: TWSE_SECTOR_ID,
    family: "international",
    title: "Taiwan semiconductor performance versus TAIEX",
    shortLabel: "Taiwan semiconductor spread",
    instruments: ["QQQ"],
    directionalInstruments: [],
    status: data ? "available" : "unavailable",
    source,
    methodology: method,
    limitation: limit,
    unit: "percentage points",
    staleAfterDays: 7,
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    summary: "Matched Taiwan price-index changes are unavailable for the preceding U.S. session.",
  };
  if (data) {
    const [industry, market] = [data.pair.sector.percent, data.pair.market.percent],
      spread = (industry - market) / 100;
    signal.metrics = [
      { label: "Semiconductor price-index change", value: industry / 100, unit: "%", date: data.date },
      { label: "TAIEX price-index change", value: market / 100, unit: "%", date: data.date },
      { label: "Semiconductor minus TAIEX", value: spread, unit: signal.unit, date: data.date },
    ];
    signal.series = [{ date: data.date, value: spread }];
    signal.summary =
      "The Taiwan semiconductor price index moved " +
      (industry / 100).toFixed(2) +
      "% and the TAIEX moved " +
      (market / 100).toFixed(2) +
      "% on " +
      data.date +
      ".";
  }
  return signal;
}
export function validateSectorSignal(s: Signal, cutoff: string) {
  if (s.id !== TWSE_SECTOR_ID) return;
  const src = s.source,
    ref = sectorSignal(src.retrievedAt),
    observed = src.observedAt;
  if (
    !instant(cutoff) ||
    !instant(src.retrievedAt) ||
    src.retrievedAt > cutoff ||
    s.family !== ref.family ||
    s.title !== ref.title ||
    s.shortLabel !== ref.shortLabel ||
    s.instruments.join() !== "QQQ" ||
    s.directionalInstruments?.length !== 0 ||
    Object.keys(s.scores).sort().join() !== "daily,monthly,weekly" ||
    Object.values(s.scores).some((x) => x !== null) ||
    s.unit !== ref.unit ||
    s.staleAfterDays !== ref.staleAfterDays ||
    s.methodology !== method ||
    s.limitation !== limit ||
    src.name !== ref.source.name ||
    src.url !== TWSE_SECTOR_CATALOG ||
    src.usage !== usage ||
    src.frequency !== ref.source.frequency ||
    src.releasedAt !== null ||
    src.attribution !== credit((observed ?? src.retrievedAt).slice(0, 4))
  )
    throw Error("Unexpected Taiwan sector attribution, date or vote");
  if (s.status === "unavailable") {
    if (observed !== null || src.sha256 !== null || src.vintageAt !== undefined || s.series.length || s.metrics.length)
      throw Error("Unavailable Taiwan sector observation contains data");
    return;
  }
  if (
    s.status !== "available" ||
    !observed ||
    !dateOnly(observed) ||
    !src.vintageAt ||
    !instant(src.vintageAt) ||
    src.vintageAt > src.retrievedAt ||
    src.vintageAt < taiwanCloseAt(observed) ||
    !/^[a-f0-9]{64}$/.test(src.sha256 ?? "") ||
    s.metrics.length !== 3 ||
    s.metrics.some(
      (m) =>
        m.date !== observed || !Number.isFinite(m.value) || Math.abs(m.value * 100 - Math.round(m.value * 100)) > 1e-8,
    ) ||
    s.metrics.map((m) => m.label).join("|") !==
      "Semiconductor price-index change|TAIEX price-index change|Semiconductor minus TAIEX" ||
    s.metrics.map((m) => m.unit).join("|") !== "%|%|percentage points" ||
    Math.abs(s.metrics[0].value - s.metrics[1].value - s.metrics[2].value) > 1e-9 ||
    s.series.length !== 1 ||
    s.series[0].date !== observed ||
    s.series[0].value !== s.metrics[2].value
  )
    throw Error("Invalid Taiwan sector comparison or native receipt");
}
