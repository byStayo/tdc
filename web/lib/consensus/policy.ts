import { publicDate } from "../public-normalization.ts";
import { INSTRUMENTS, type Point, type Signal } from "./types.ts";
import type { PublicDocument } from "./calendars.ts";
import { effectiveStatus } from "./engine.ts";

export function policyReadings(signals: Signal[], reference: string) {
  const groups = [
    {
      name: "Federal Reserve",
      currency: "USD",
      definition: "Federal funds target range",
      ids: ["policy-fed-lower", "policy-fed-upper"],
      family: "rates" as const,
      approximate: false,
    },
    {
      name: "European Central Bank",
      currency: "EUR",
      definition: "Deposit facility",
      ids: ["policy-ecb-deposit"],
      family: "international" as const,
      approximate: false,
    },
    {
      name: "Bank of England",
      currency: "GBP",
      definition: "Official Bank Rate",
      ids: ["policy-boe-bank"],
      family: "international" as const,
      approximate: false,
    },
    {
      name: "Bank of Japan",
      currency: "JPY",
      definition: "Overnight call-rate target",
      ids: ["policy-reviewed-boj"],
      family: "international" as const,
      approximate: true,
    },
  ];
  return groups.map((group) => {
    const members = group.ids.map((id) =>
      signals.find((signal) => signal.id === id),
    );
    const valid = members.every(
      (signal) =>
        signal &&
        signal.status === "available" &&
        signal.metrics.length &&
        Number.isFinite(signal.metrics[0].value),
    );
    const datesMatch =
      valid &&
      members.every(
        (signal) => signal!.source.observedAt === members[0]!.source.observedAt,
      );
    const lower = datesMatch ? members[0]!.metrics[0].value : null,
      upper = datesMatch ? members.at(-1)!.metrics[0].value : null;
    const ordered = lower !== null && upper !== null && lower <= upper;
    return {
      ...group,
      lower: ordered ? lower : null,
      upper: ordered ? upper : null,
      at: ordered ? members[0]!.source.observedAt : null,
      stale:
        ordered &&
        members.some(
          (signal) => effectiveStatus(signal!, reference) !== "available",
        ),
      note: !valid
        ? "No verified observation"
        : !datesMatch
          ? "Range dates do not align"
          : !ordered
            ? "Invalid target range"
            : group.approximate
              ? "Decision published"
              : "Provider observation",
    };
  });
}

/** Bounded CSV decoding, including quoted ECB descriptions containing commas. */
export function policyCsv(text: string): string[][] {
  if (text.length > 2_000_000) throw new Error("Policy source too large");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error("Malformed policy CSV quote");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (row.length > 100) throw new Error("Too many policy fields");
      if (c !== ",") {
        if (row.some((v) => v.length)) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed) throw new Error("Unexpected text after CSV quote");
      field += c;
    }
    if (rows.length > 10000) throw new Error("Too many policy observations");
  }
  if (quoted) throw new Error("Unclosed policy CSV quote");
  row.push(field);
  if (row.some((v) => v.length)) rows.push(row);
  return rows;
}
const numeric = (value: string) =>
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= -20 &&
  Number(value) <= 100;
function put(
  points: Map<string, number>,
  date: string,
  value: string,
  cutoff: string,
) {
  if (
    !publicDate(date) ||
    date.length !== 10 ||
    date > cutoff.slice(0, 10) ||
    !numeric(value)
  )
    return;
  if (points.has(date) && points.get(date) !== Number(value))
    throw new Error("Conflicting policy observations");
  points.set(date, Number(value));
}
const ordered = (points: Map<string, number>): Point[] =>
  [...points]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-800);

export function ecbPolicyPoints(text: string, cutoff: string): Point[] {
  const [header, ...rows] = policyCsv(text);
  const required = [
    "KEY",
    "TIME_PERIOD",
    "OBS_VALUE",
    "OBS_STATUS",
    "UNIT",
    "UNIT_MULT",
  ];
  if (
    !header ||
    new Set(header).size !== header.length ||
    required.some((key) => !header.includes(key))
  )
    throw new Error("Unexpected ECB policy schema");
  const points = new Map<string, number>();
  for (const row of rows) {
    if (row.length !== header.length)
      throw new Error("Malformed ECB policy row");
    const field = (key: string) => row[header.indexOf(key)];
    if (
      field("KEY") !== "FM.D.U2.EUR.4F.KR.DFR.LEV" ||
      field("UNIT") !== "PCPA" ||
      field("UNIT_MULT") !== "0"
    )
      throw new Error("Wrong ECB policy series or unit");
    if (!["A", "P"].includes(field("OBS_STATUS"))) continue;
    put(points, field("TIME_PERIOD"), field("OBS_VALUE"), cutoff);
  }
  return ordered(points);
}
const BOE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function boeRequestDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || publicDate(date) !== date)
    throw new Error("Invalid Bank Rate request date");
  return `${date.slice(8, 10)}/${BOE_MONTHS[Number(date.slice(5, 7)) - 1]}/${date.slice(0, 4)}`;
}
export function boePolicyPoints(text: string, cutoff: string): Point[] {
  const [header, ...rows] = policyCsv(text);
  if (header?.join(",") !== "DATE,IUDBEDR")
    throw new Error("Unexpected Bank Rate schema");
  const months = BOE_MONTHS;
  const points = new Map<string, number>();
  for (const row of rows) {
    if (row.length !== 2) throw new Error("Malformed Bank Rate row");
    const match = row[0].match(/^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/);
    if (!match || !months.includes(match[2])) continue;
    put(
      points,
      `${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, "0")}-${match[1]}`,
      row[1],
      cutoff,
    );
  }
  return ordered(points);
}
export function fedPolicyPoints(
  text: string,
  id: "DFEDTARL" | "DFEDTARU",
  cutoff: string,
): Point[] {
  const [header, ...rows] = policyCsv(text);
  if (
    header?.join(",") !== `observation_date,${id}` &&
    header?.join(",") !== `DATE,${id}`
  )
    throw new Error("Unexpected Fed target schema");
  const points = new Map<string, number>();
  for (const row of rows) {
    if (row.length !== 2) throw new Error("Malformed Fed target row");
    put(points, row[0], row[1], cutoff);
  }
  return ordered(points);
}

export async function collectPolicyRates(
  read: (url: string) => Promise<PublicDocument>,
  now = new Date().toISOString(),
): Promise<Signal[]> {
  const from = new Date(Date.parse(now) - 730 * 86400000)
    .toISOString()
    .slice(0, 10);
  const boeFrom = boeRequestDate(from);
  const specs = [
    {
      id: "fed-lower",
      title: "Federal Reserve · target lower bound",
      family: "rates" as const,
      url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARL&cosd=${from}`,
      citation: "https://fred.stlouisfed.org/series/DFEDTARL",
      parse: (text: string, cutoff: string) =>
        fedPolicyPoints(text, "DFEDTARL", cutoff),
      attribution:
        "Board of Governors of the Federal Reserve System, via FRED, Federal Reserve Bank of St. Louis",
      usage: "US government public-domain series; citation requested",
      definition:
        "Lower bound of the federal funds target range, not the effective market rate.",
    },
    {
      id: "fed-upper",
      title: "Federal Reserve · target upper bound",
      family: "rates" as const,
      url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU&cosd=${from}`,
      citation: "https://fred.stlouisfed.org/series/DFEDTARU",
      parse: (text: string, cutoff: string) =>
        fedPolicyPoints(text, "DFEDTARU", cutoff),
      attribution:
        "Board of Governors of the Federal Reserve System, via FRED, Federal Reserve Bank of St. Louis",
      usage: "US government public-domain series; citation requested",
      definition:
        "Upper bound of the federal funds target range, not the effective market rate.",
    },
    {
      id: "ecb-deposit",
      title: "ECB · deposit facility rate",
      family: "international" as const,
      url: `https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV?format=csvdata&startPeriod=${from}`,
      citation:
        "https://data.ecb.europa.eu/data/datasets/FM/FM.D.U2.EUR.4F.KR.DFR.LEV",
      parse: ecbPolicyPoints,
      attribution: "European Central Bank (ECB)",
      usage:
        "ECB free reuse with accurate attribution; chart and changes calculated by The Daily Consensus",
      definition:
        "ECB deposit facility rate, percent per annum. This is distinct from its refinancing and marginal-lending rates.",
    },
    {
      id: "boe-bank",
      title: "Bank of England · Bank Rate",
      family: "international" as const,
      url: `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${boeFrom}&Dateto=now&SeriesCodes=IUDBEDR&UsingCodes=Y&CSVF=TN&VPD=Y&VFD=N`,
      citation:
        "https://www.bankofengland.co.uk/boeapps/database/Bank-Rate.asp",
      parse: boePolicyPoints,
      attribution:
        "Bank of England Database, copyright Governor and Company of the Bank of England; Open Government Licence v3.0",
      usage:
        "Bank Rate data reused under https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/; no third-party FX data",
      definition:
        "Official Bank Rate. Daily observations can be published with a working-day lag.",
    },
  ];
  return Promise.all(
    specs.map(async (spec): Promise<Signal> => {
      const signal: Signal = {
        id: `policy-${spec.id}`,
        title: spec.title,
        shortLabel: spec.title,
        family: spec.family,
        instruments: [...INSTRUMENTS],
        status: "unavailable",
        summary: "No usable official policy-rate observation returned.",
        source: {
          name: spec.title,
          url: spec.citation,
          retrievedAt: now,
          observedAt: null,
          releasedAt: null,
          frequency: "daily policy level",
          attribution: spec.attribution,
          usage: spec.usage,
          sha256: null,
        },
        methodology: `${spec.definition} Only provider-published daily observations are used; no forward-filled new dates. No directional vote.`,
        limitation:
          "Different policy instruments and source dates. Nominal rate gaps alone are not an FX signal, an inflation-adjusted stance or a forecast of the next decision.",
        series: [],
        metrics: [],
        unit: "%",
        staleAfterDays: 7,
        scores: { daily: null, weekly: null, monthly: null },
      };
      try {
        const doc = await read(spec.url),
          series = spec.parse(doc.text, doc.retrievedAt),
          latest = series.at(-1);
        if (!latest) throw new Error("No current policy observations");
        const previousDifferent = [...series]
          .reverse()
          .find((point) => point.value !== latest.value);
        const change = previousDifferent
          ? series.find((point) => point.date > previousDifferent.date)!
          : null;
        return {
          ...signal,
          status: "available",
          source: {
            ...signal.source,
            observedAt: latest.date,
            sha256: doc.sha256,
            retrievedAt: doc.retrievedAt,
          },
          series,
          metrics: [
            {
              label: "Policy rate",
              value: latest.value,
              unit: "%",
              date: latest.date,
            },
            ...(change && previousDifferent
              ? [
                  {
                    label: "Last observed change",
                    value: (latest.value - previousDifferent.value) * 100,
                    unit: "bp",
                    date: change.date,
                  },
                ]
              : []),
          ],
          summary: `${spec.title}: ${latest.value.toFixed(2)}% observed ${latest.date}. ${spec.definition}`,
        };
      } catch {
        return signal;
      }
    }),
  );
}
