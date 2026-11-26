import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { ETF_FLOW_LICENSE } from "./etf-flows.ts";
import { sourceChunk, sourceFailureKind, sourceResponse } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";
import { INSTRUMENTS, type Signal } from "./types.ts";

const ETFs = INSTRUMENTS.filter(symbol => symbol !== "MARKET");
type ETF = typeof ETFs[number];
type ReadText = (url: string) => Promise<PublicDocument>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const SEC_PAGE = "https://www.sec.gov/data-research/sec-markets-data/marketstructuredata-security";
const SEC_ORIGIN = "https://www.sec.gov";
const archivePath = "/files/opa/data/market-structure/metrics-individual-security/";
const archiveName = /^individual_security_(20\d\d)_q([1-4])\.zip$/;
const midasParser = fileURLToPath(new URL("../../scripts/parse-sec-midas.py", import.meta.url));
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const maxZipSize = 40_000_000;
const retailPage = (symbol: ETF) => `https://etfiq.com/funds/${symbol.toLowerCase()}/trading/`;

const MIDAS = {
  prefix: "sec-midas-",
  family: "technicals",
  title: "Exchange order activity",
  source: "SEC MIDAS · Metrics by Individual Security",
  frequency: "daily sample released quarterly",
  attribution: `Source: U.S. Securities and Exchange Commission, MIDAS Metrics by Individual Security (${SEC_PAGE}).`,
  usage: "SEC-computed public market-structure measures. https://catalog.data.gov/dataset/metrics-by-individual-security",
  methodology: "The SEC sample begins at 9:35 a.m. ET. Lit trade volume divided by order volume, cancels divided by lit trades, and hidden and odd-lot shares use the separate denominators in the SEC archive readme. The odd-lot definition changed on November 3, 2025.",
  limitation: "Quarterly release lag. The metrics cover the exchanges and order types described by the SEC. They combine both sides of trades and give neither a price nor a directional vote.",
  unit: "%",
  staleAfterDays: 135,
  labels: ["Lit trade volume / order volume", "Cancels / lit trade", "Hidden trade volume share", "Odd-lot trade volume share"],
  units: ["%", "messages per trade", "%", "%"],
} as const;

const RETAIL = {
  prefix: "etfiq-retail-",
  family: "retail",
  title: "Retail order activity",
  source: "ETFIQ · retail order activity estimate",
  frequency: "monthly SEC Rule 605 reports",
  usage: `ETFIQ-computed shares, ranks and ranked counts may be reused, republished and used in models with attribution: ${ETF_FLOW_LICENSE}.`,
  methodology: "ETFIQ ranks ETFs by their share of market and marketable-limit order dollars reported by four retail brokers under SEC Rule 605. The observation date is the end of the report month.",
  limitation: "A subset of retail brokers and order types. The estimate combines buys and sells and does not measure holdings, sentiment or a directional vote.",
  unit: "%",
  staleAfterDays: 65,
  labels: ["Share of reported retail order dollars", "Retail activity rank", "ETFs in provider ranking"],
  units: ["%", "rank", "funds"],
} as const;

type Source = typeof RETAIL | typeof MIDAS;

function invalid(source: Source): never {
  throw new Error(`Invalid ${source.source} order activity`);
}

function baseSignal(source: Source, symbol: ETF, retrievedAt: string): Signal {
  const url = source === MIDAS ? SEC_PAGE : retailPage(symbol);
  return {
    id: source.prefix + symbol, family: source.family, title: `${symbol} · ${source.title}`,
    shortLabel: source.title, instruments: [symbol], directionalInstruments: [], status: "unavailable",
    summary: `No verified ${source.title.toLowerCase()} observation returned for ${symbol}.`,
    source: { name: source.source, url, retrievedAt, observedAt: null, releasedAt: null,
      frequency: source.frequency, usage: source.usage, sha256: null,
      attribution: source === MIDAS ? MIDAS.attribution : `Source: ETFIQ (${url}).` },
    methodology: source.methodology, limitation: source.limitation, series: [], metrics: [],
    scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: source.staleAfterDays, unit: source.unit,
  };
}

const metrics = (source: Source, values: number[], date: string) =>
  source.labels.map((label, index) => ({ label, value: values[index], unit: source.units[index], date }));

export async function collectEtfiqRetailOrders(read: ReadText): Promise<Signal[]> {
  return Promise.all(ETFs.map(async symbol => {
    const base = baseSignal(RETAIL, symbol, new Date().toISOString());
    try {
      const doc = await read(retailPage(symbol) + "index.json");
      const page = JSON.parse(doc.text);
      if (page?.url !== base.source.url || page.section !== "funds" || page.publisher?.name !== "ETFIQ" ||
          page.publisher.url !== "https://etfiq.com" || page.license !== ETF_FLOW_LICENSE || page.truncated !== false ||
          typeof page.content !== "string" || !Array.isArray(page.structured_data) ||
          createHash("sha256").update(doc.text).digest("hex") !== doc.sha256) invalid(RETAIL);
      const datasets = page.structured_data.filter((entry: { "@type"?: string; url?: string } | null) =>
        entry?.["@type"] === "Dataset" && entry.url === page.url);
      const vintageAt = datasets[0]?.dateModified;
      if (datasets.length !== 1 || publicDate(vintageAt) !== vintageAt || typeof vintageAt !== "string" ||
          vintageAt > newYorkDate(doc.retrievedAt)) invalid(RETAIL);
      const vintage = new Date(vintageAt + "T00:00:00Z");
      if (page.as_of !== `${months[vintage.getUTCMonth()]} ${vintage.getUTCDate()}, ${vintage.getUTCFullYear()}`) invalid(RETAIL);

      // This period and the values come from the same per-fund machine-readable citation.
      const line = new RegExp(`^[ \\t]*${symbol} ranked (\\d+)(?:st|nd|rd|th) of ([\\d,]+) ETFs by retail order activity in ([A-Z][a-z]{2}) (20\\d\\d), an ETFIQ estimate\\. It drew (\\d+(?:\\.\\d+)?)% of the market-order dollars in 4 retail brokers[’'] reports\\.`, "gm");
      const matches = [...page.content.matchAll(line)];
      if (matches.length !== 1) invalid(RETAIL);
      const [, rankText, totalText, month, year, shareText] = matches[0];
      const monthIndex = months.indexOf(month);
      if (monthIndex < 0) invalid(RETAIL);
      const through = new Date(Date.UTC(Number(year), monthIndex + 1, 0)).toISOString().slice(0, 10);
      const values = [Number(shareText), Number(rankText), Number(totalText.replaceAll(",", ""))];
      const signal: Signal = { ...base, status: "available",
        summary: `${symbol} accounted for ${values[0]}% of the sample’s order dollars in ${month} ${year}, ranking ${values[1]} of ${values[2].toLocaleString("en-US")} ETFs.`,
        source: { ...base.source, retrievedAt: doc.retrievedAt, sha256: doc.sha256, observedAt: through, vintageAt },
        series: [{ date: through, value: values[0] }], metrics: metrics(RETAIL, values, through) };
      validateOrderActivity(signal);
      return signal;
    } catch (error) { return { ...base, failureKind: sourceFailureKind(error) }; }
  }));
}

function quarterFromArchive(url: string) {
  const prefix = SEC_ORIGIN + archivePath;
  const match = url.startsWith(prefix) ? archiveName.exec(url.slice(prefix.length)) : null;
  if (!match) invalid(MIDAS);
  const [, year, quarter] = match;
  const first = `${year}-${String(1 + 3 * (Number(quarter) - 1)).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(Number(year), Number(quarter) * 3, 0)).toISOString().slice(0, 10);
  return { year, quarter, first, end };
}

function latestMidasArchive(html: string, checkedAt: string) {
  const links = [...html.matchAll(/href=["']([^"']+)["'][^>]*>\s*(20\d\d) Q([1-4])\s*<\/a>/g)];
  const urls = links.flatMap(([, path, year, quarter]) => path === `${archivePath}individual_security_${year}_q${quarter}.zip` ? [SEC_ORIGIN + path] : []);
  const result = urls.sort().at(-1);
  if (!result || quarterFromArchive(result).end > newYorkDate(checkedAt)) invalid(MIDAS);
  return result;
}

/** Conditionally reread the dated ZIP to pick up revisions without downloading it daily. */
export async function collectSecMidas(read: ReadText, fetcher: Fetcher, previous: Signal[] = []): Promise<Signal[]> {
  const started = new Date().toISOString();
  try {
    const index = await read(SEC_PAGE);
    const url = latestMidasArchive(index.text, index.retrievedAt);
    const cached = ETFs.map(symbol => previous.find(signal => signal.id === MIDAS.prefix + symbol &&
      signal.source.url === url && signal.status === "available"));
    const prior = cached[0]?.source;
    const conditional = prior && cached.every(signal => signal && signal.source.sha256 === prior.sha256 &&
      signal.source.retrievedAt === prior.retrievedAt);
    const response = await sourceResponse(fetcher, url, {
      redirect: "error", signal: AbortSignal.timeout(45000),
      headers: { "User-Agent": "The Daily Consensus public research https://thedailyconsensus.com",
        Accept: "application/zip,application/octet-stream",
        ...(conditional ? { "If-Modified-Since": new Date(prior.retrievedAt).toUTCString() } : {}) },
    }, !!conditional);
    if (response.status === 304) return cached.map(signal => {
      const { collectionNote, ...verified } = signal!;
      return verified;
    });
    const chunks: Uint8Array[] = [], reader = response.body!.getReader();
    let size = 0;
    try {
      for (;;) {
        const chunk = await sourceChunk(reader);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxZipSize) invalid(MIDAS);
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    const retrievedAt = new Date().toISOString(), bytes = Buffer.concat(chunks, size);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { year, quarter } = quarterFromArchive(url);
    const modified = Date.parse(response.headers.get("Last-Modified") ?? "");
    const vintageAt = Number.isFinite(modified) ? new Date(modified).toISOString() : undefined;
    type Row = [string, number, number, number, number];
    const parsed = await new Promise<Record<ETF, Row[]>>((done, reject) => {
      const child = execFile("python3", [midasParser, year, quarter], { timeout: 30000, maxBuffer: 128000 }, (error, stdout) => {
        if (error) reject(error);
        else {
          try { done(JSON.parse(stdout)); }
          catch (parseError) { reject(parseError); }
        }
      });
      child.stdin!.on("error", reject);
      child.stdin!.end(bytes);
    });
    return ETFs.map(symbol => {
      const base = baseSignal(MIDAS, symbol, retrievedAt), rows = parsed[symbol];
      const [through, ...values] = rows.at(-1)!;
      const signal: Signal = { ...base, status: "available",
        summary: `${symbol} · ${year} Q${quarter}. The SEC archive covers ${rows.length} sessions through ${through}. Lit trades were ${values[0].toFixed(2)}% of order volume on that last session.`,
        source: { ...base.source, url, observedAt: through, sha256, vintageAt },
        series: rows.map(([date, value]) => ({ date, value })), metrics: metrics(MIDAS, values, through) };
      validateOrderActivity(signal);
      return signal;
    });
  } catch (error) {
    return ETFs.map(symbol => ({ ...baseSignal(MIDAS, symbol, started), failureKind: sourceFailureKind(error) }));
  }
}

export function validateOrderActivity(signal: Signal): void {
  const source = signal.id.startsWith(MIDAS.prefix) ? MIDAS : signal.id.startsWith(RETAIL.prefix) ? RETAIL : null;
  if (!source) return;
  const symbol = signal.id.slice(source.prefix.length) as ETF;
  const provenance = signal.source;
  if (!ETFs.includes(symbol) || signal.family !== source.family || signal.instruments.join() !== symbol ||
      !signal.directionalInstruments || signal.directionalInstruments.length || Object.values(signal.scores).some(score => score !== null) ||
      signal.staleAfterDays !== source.staleAfterDays || signal.unit !== source.unit ||
      provenance.releasedAt !== null || provenance.usage !== source.usage || provenance.frequency !== source.frequency ||
      provenance.name !== source.source ||
      provenance.attribution !== (source === MIDAS ? MIDAS.attribution : `Source: ETFIQ (${retailPage(symbol)}).`)) invalid(source);

  if (signal.status === "unavailable") {
    if (signal.series.length || signal.metrics.length || provenance.observedAt || provenance.sha256 || provenance.vintageAt ||
        provenance.url !== (source === MIDAS ? SEC_PAGE : retailPage(symbol))) invalid(source);
    return;
  }
  const { observedAt, vintageAt } = provenance;
  if (signal.status !== "available" || !observedAt || observedAt !== publicDate(observedAt) ||
      !provenance.sha256 || !/^[a-f0-9]{64}$/.test(provenance.sha256) ||
      (vintageAt !== undefined && (!publicDate(vintageAt) || vintageAt < observedAt || Date.parse(vintageAt) > Date.parse(provenance.retrievedAt))) ||
      signal.series.at(-1)?.date !== observedAt || signal.series.at(-1)?.value !== signal.metrics[0]?.value ||
      signal.metrics.length !== source.labels.length ||
      signal.metrics.some((item, index) => item.label !== source.labels[index] || item.unit !== source.units[index] ||
        item.date !== observedAt || !Number.isFinite(item.value) || item.value < 0)) invalid(source);

  if (source === MIDAS) {
    const { first, end } = quarterFromArchive(provenance.url);
    if (signal.series.length > 67 || signal.series.some(point => point.date < first || point.date > end || point.value < 0) ||
        signal.metrics.some((metric, index) => index >= 2 && metric.value > 100)) invalid(source);
  } else {
    const [share, rank, total] = signal.metrics.map(metric => metric.value);
    const nextDay = new Date(Date.parse(observedAt) + 86400000);
    if (signal.series.length !== 1 || !vintageAt || vintageAt !== publicDate(vintageAt) || nextDay.getUTCDate() !== 1 ||
        provenance.url !== retailPage(symbol) || share > 100 || !Number.isSafeInteger(rank) || !Number.isSafeInteger(total) ||
        rank < 1 || total < rank) invalid(source);
  }
}
