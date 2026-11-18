import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { checkedMacroPoints, type PrimaryMacroProvider } from "./fed-market-data.ts";
import { newYorkDate } from "./time.ts";
import type { Point } from "./types.ts";

const BOARD = "https://www.federalreserve.gov/releases";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
type BalanceSheetId = "WALCL" | "WTREGEN" | "WRESBAL";
type BankCreditId = "BUSLOANS" | "TOTBKCR";
type BoardId = BalanceSheetId | BankCreditId | "DTWEXBGS";
type Read = (url: string) => Promise<PublicDocument>;

function plain(html: string): string {
  return html.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&#44;/g, ",")
    .replace(/\s+/g, " ").trim();
}

function date(year: number, month: string, day: string) {
  const number = MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1;
  const iso = `${year}-${String(number).padStart(2, "0")}-${day.padStart(2, "0")}`;
  if (publicDate(iso) !== iso) throw new Error("Invalid Board observation date");
  return iso;
}

function datedHeading(heading: string) {
  const match = /([A-Za-z]+)\.? (\d{1,2}), (20\d{2})$/.exec(heading);
  if (!match) throw new Error("Missing Board report date");
  return date(Number(match[3]), match[1], match[2]);
}

function releaseDate(doc: PublicDocument) {
  const match = /\bRelease Date:\s*([A-Z][a-z]+ \d{1,2}, 20\d{2})\b/.exec(plain(doc.text));
  const releasedAt = datedHeading(match?.[1] ?? "");
  if (releasedAt > newYorkDate(doc.retrievedAt)) throw new Error("Future-dated Board release");
  return releasedAt;
}

function shortDay(label: string, releasedAt: string) {
  const match = /^([A-Za-z]+)\.? (\d{1,2})$/.exec(label);
  if (!match) throw new Error("Invalid Board day column");
  const year = Number(releasedAt.slice(0, 4));
  const currentYear = date(year, match[1], match[2]);
  return currentYear <= releasedAt ? currentYear : date(year - 1, match[1], match[2]);
}

function tables(html: string) {
  return [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)]
    .map(([, tag, body]) => ({
      tag, rows: [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(([, row]) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => plain(cell))),
    }));
}

function exactlyOne<T>(values: T[], description: string): T {
  if (values.length !== 1) throw new Error(`Expected one ${description}`);
  return values[0];
}

function number(value: string | undefined) {
  if (!value || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value))
    throw new Error("Invalid Board macro value");
  return Number(value.replaceAll(",", ""));
}

export function balanceSheetPoints(doc: PublicDocument): Record<BalanceSheetId, Point> {
  const published = releaseDate(doc);
  const result = tables(doc.text);
  const averageTable = exactlyOne(result.filter(table =>
    table.rows[0]?.[1] === "Averages of daily figures" &&
    table.rows.some(row => row[0] === "U.S. Treasury, General Account" && row.length === 5)), "H.4.1 weekly-average table");
  const balanceTable = exactlyOne(result.filter(table =>
    table.rows[0]?.[1] === "Eliminations from consolidation" &&
    table.rows.some(row => row[0] === "Total assets")), "H.4.1 consolidated balance sheet");
  const observed = datedHeading(averageTable.rows[0][2] ?? "");
  if (!averageTable.rows[0][2].startsWith("Wednesday ") || !averageTable.rows[1][0].startsWith("Week ended ") ||
      datedHeading(averageTable.rows[1][0]) !== observed || datedHeading(balanceTable.rows[0][2]) !== observed ||
      new Date(observed + "T12:00:00Z").getUTCDay() !== 3 || observed >= published)
    throw new Error("H.4.1 Wednesday and week-average periods differ");
  const reading = (rows: string[][], label: string, column: number) =>
    ({ date: observed, value: number(exactlyOne(rows.filter(row => row[0] === label), label)[column]) });
  return {
    WALCL: reading(balanceTable.rows, "Total assets", 2),
    WTREGEN: reading(averageTable.rows, "U.S. Treasury, General Account", 1),
    WRESBAL: reading(averageTable.rows, "Reserve balances with Federal Reserve Banks", 1),
  };
}

export function bankCreditPoints(doc: PublicDocument): Record<BankCreditId, Point[]> {
  const published = releaseDate(doc);
  const table = exactlyOne(tables(doc.text).filter(item => /\bid="h8t2"/.test(item.tag)), "H.8 Table 2");
  const months = table.rows[0].slice(1, -1).map(label => {
    const match = /^(20\d{2}) ([A-Za-z]+)$/.exec(label);
    if (!match) throw new Error("Invalid H.8 month");
    return date(Number(match[1]), match[2], "1");
  });
  const weeks = table.rows[1].map(label => shortDay(label, published));
  if (table.rows[0].at(-1) !== "Week ending" || months.length < 2 || weeks.length < 2 ||
      weeks.some(day => new Date(day + "T12:00:00Z").getUTCDay() !== 3 || day >= published) ||
      !/Seasonally adjusted,\s*billions of dollars/i.test(plain(doc.text)))
    throw new Error("Invalid H.8 observation basis");
  const bank = exactlyOne(table.rows.filter(row => row[0] === "1" && row[1] === "Bank credit"), "H.8 bank credit row");
  const loans = exactlyOne(table.rows.filter(row => row[0] === "10" && row[1] === "Commercial and industrial loans"), "H.8 commercial loans row");
  if ([bank, loans].some(row => row.length !== 2 + months.length + weeks.length))
    throw new Error("H.8 row has an unexpected number of columns");
  return {
    TOTBKCR: checkedMacroPoints(weeks.map((day, index) => ({ date: day, value: number(bank[index + 2 + months.length]) })), published, "H.8 bank credit"),
    BUSLOANS: checkedMacroPoints(months.map((day, index) => ({ date: day, value: number(loans[index + 2]) })), published, "H.8 commercial loans"),
  };
}

export function broadDollarPoints(release: PublicDocument, history: PublicDocument): Point[] {
  const published = releaseDate(release);
  const table = exactlyOne(tables(release.text).filter(item =>
    item.rows.some(row => row[0] === "1) BROAD" && row[1] === "JAN06=100")), "H.10 Broad Dollar Index table");
  const latestRow = exactlyOne(table.rows.filter(row => row[0] === "1) BROAD"), "Broad Dollar Index row");
  const days = table.rows[0].slice(2).map(label => shortDay(label, published));
  const index = exactlyOne(tables(history.text).filter(item =>
    /\btitle="Nominal Broad Dollar Index - Daily Index\s*"/.test(item.tag)), "H.10 daily index history");
  if (days.length !== latestRow.length - 2) throw new Error("Incomplete H.10 week");
  const points = index.rows.flatMap(([label, value]) => {
    if (value === "ND") return [];
    const match = /^(\d{1,2})-([A-Z]{3})-(\d{2})$/.exec(label);
    if (!match) throw new Error("Invalid H.10 history date");
    return [{ date: date(2000 + Number(match[3]), match[2], match[1]), value: number(value) }];
  });
  const series = checkedMacroPoints(points, published, "H.10 broad dollar");
  const current = days.flatMap((day, index) => latestRow[index + 2] === "ND" ? [] : [{ date: day, value: number(latestRow[index + 2]) }]);
  if (!current.length || series.at(-1)?.date !== current.at(-1)?.date ||
      current.some(point => !series.some(prior => prior.date === point.date && prior.value === point.value)))
    throw new Error("H.10 dated release and rolling index differ");
  return series;
}

function priorBoardReleases(doc: PublicDocument, before: string, count: number) {
  const years = JSON.parse(doc.text) as { Months: { Dates: string[] }[] }[];
  const flat = years.flatMap(year => year.Months.flatMap(month => month.Dates));
  const dates = [...new Set(flat)].map(value => {
    if (!/^(?:19|20)\d{6}$/.test(value)) throw new Error("Invalid Board release index");
    const iso = value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6);
    if (publicDate(iso) !== iso) throw new Error("Invalid Board release index date");
    return iso;
  }).sort().filter(day => day < before).slice(-count);
  if (dates.length < count) throw new Error("Board release index lacks the required history");
  return dates;
}

function combineHash(docs: PublicDocument[]) {
  return createHash("sha256").update(docs.map(doc => doc.sha256).join("\n")).digest("hex");
}

export function federalReserveBoardProviders(read: Read): Record<BoardId, PrimaryMacroProvider> {
  const sheetUrl = BOARD + "/h41/current/default.htm";
  const creditUrl = BOARD + "/h8/current/default.htm";
  const currencyUrl = BOARD + "/h10/current/default.htm";
  let sheet: ReturnType<typeof loadBalance> | undefined;
  let credit: ReturnType<typeof loadCredit> | undefined;
  const description = (title: string, url: string, usage: string) => ({
    name: "Federal Reserve Board · " + title,
    url, attribution: "Board of Governors of the Federal Reserve System.", usage,
  });

  async function datedReleases(group: "h41" | "h8", current: PublicDocument, count: number) {
    const index = await read(BOARD + "/" + group + "/releaseDates.json");
    return Promise.all(priorBoardReleases(index, releaseDate(current), count).map(async day => {
      const doc = await read(BOARD + "/" + group + "/" + day.replaceAll("-", "") + "/default.htm");
      if (releaseDate(doc) !== day) throw new Error("Board archive does not match its dated index");
      return doc;
    }));
  }

  async function loadBalance() {
    const current = await read(sheetUrl);
    const releasedAt = releaseDate(current);
    const prior = await datedReleases("h41", current, 4);
    const documents = [...prior, current];
    const readings = documents.map(balanceSheetPoints);
    return {
      readings, releasedAt, sha256: combineHash(documents),
      retrievedAt: documents.map(doc => doc.retrievedAt).sort().at(-1)!,
    };
  }
  async function loadCredit() {
    const doc = await read(creditUrl);
    const latest = bankCreditPoints(doc);
    const releasedAt = releaseDate(doc);
    if (latest.TOTBKCR.length >= 5) return { ...doc, releasedAt, readings: latest };
    // Keep the newest printed value for a week repeated in adjacent issues.
    const prior = await datedReleases("h8", doc, 2);
    const weekly = new Map<string, Point>();
    for (const point of [...prior.flatMap(item => bankCreditPoints(item).TOTBKCR), ...latest.TOTBKCR])
      weekly.set(point.date, point);
    const documents = [...prior, doc];
    return {
      readings: { ...latest, TOTBKCR: checkedMacroPoints([...weekly.values()], releasedAt, "H.8 bank credit") },
      releasedAt, sha256: combineHash(documents),
      retrievedAt: documents.map(item => item.retrievedAt).sort().at(-1)!,
    };
  }
  function balance(id: BalanceSheetId, usage: string): PrimaryMacroProvider {
    return {
      source: description("H.4.1", sheetUrl, usage),
      async read() {
        const { readings, ...source } = await (sheet ??= loadBalance());
        return { ...source, series: checkedMacroPoints(readings.map(report => report[id]), source.releasedAt, "H.4.1") };
      },
    };
  }
  function loans(id: BankCreditId): PrimaryMacroProvider {
    return {
      source: description("H.8", creditUrl, "Seasonally adjusted Table 2, in USD billions at the published 0.1-billion precision."),
      async read() {
        const { readings, ...source } = await (credit ??= loadCredit());
        return { ...source, series: readings[id] };
      },
    };
  }
  return {
    WALCL: balance("WALCL", "Wednesday total assets in H.4.1 Table 5, in USD millions."),
    WTREGEN: balance("WTREGEN", "Week-average Treasury General Account balance in H.4.1 Table 1, in USD millions."),
    WRESBAL: balance("WRESBAL", "Week-average reserve balances in H.4.1 Table 1, in USD millions."),
    BUSLOANS: loans("BUSLOANS"), TOTBKCR: loans("TOTBKCR"),
    DTWEXBGS: {
      source: description("H.10", currencyUrl, "Daily nominal Broad Dollar Index, January 2006 = 100. History includes revisions available at capture."),
      async read() {
        const [release, history] = await Promise.all([read(currencyUrl), read(BOARD + "/h10/summary/jrxwtfb_nb.htm")]);
        return {
          series: broadDollarPoints(release, history), releasedAt: releaseDate(release), sha256: combineHash([release, history]),
          retrievedAt: [release.retrievedAt, history.retrievedAt].sort().at(-1)!,
        };
      },
    },
  };
}
