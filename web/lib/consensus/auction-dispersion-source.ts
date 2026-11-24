import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { immutableSourceReceipt } from "../publication-storage.ts";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { publicBytes, type Fetcher } from "./public-source.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";

export const TREASURY_ANNOUNCED = "https://www.treasurydirect.gov/TA_WS/securities/announced?format=json";
export const TREASURY_AUCTIONED = "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json";
export const AUCTION_SOURCE_DIRECTORY = ".consensus/private-treasury-award-dispersion";
const tenors = [2, 3, 5, 7, 10, 20, 30];
const millisPerDay = 86_400_000;
const fullDay = 390 * 60_000;
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const stamp = (s: string) =>
  typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const dateOnly = (s: string) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && publicDate(s) === s;

function nextDate(day: string) {
  return new Date(Date.parse(day) + millisPerDay).toISOString().slice(0, 10);
}

function firstFull(day: string) {
  for (let n = 0; n < 8; n++, day = nextDate(day)) {
    if (!hasReviewedCalendar(day)) return null;
    const c = exchangeSession(day);
    if (c && Date.parse(c.closeAt) - Date.parse(c.openAt) === fullDay) return c;
  }
  return null;
}

export function targetAfterAuction(day: string) {
  if (!dateOnly(day) || !hasReviewedCalendar(day)) return null;
  return firstFull(nextDate(day));
}

export function nextEligibleMorning(now: string) {
  if (!stamp(now)) return null;
  const day = newYorkDate(now),
    c = firstFull(day);
  return c && now < c.openAt ? c : c && firstFull(nextDate(day));
}

function requiredDay(value: unknown) {
  const s = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d\d-\d\dT00:00:00$/.test(s) || !dateOnly(s.slice(0, 10)))
    throw Error("Invalid Treasury source date");
  return s.slice(0, 10);
}

function localClock(day: string, time: string) {
  let hh: number, mm: number;
  const civil = /^(\d{1,2}):(\d{2}) (AM|PM)(?: ET)?$/.exec(time);
  const military = /^(\d{2}):(\d{2})$/.exec(time);
  if (civil && +civil[1] >= 1 && +civil[1] <= 12) {
    hh = (+civil[1] % 12) + (civil[3] === "PM" ? 12 : 0);
    mm = +civil[2];
  } else if (military && +military[1] < 24) {
    hh = +military[1];
    mm = +military[2];
  } else throw Error("Invalid Treasury competitive or release time");
  if (mm > 59) throw Error("Invalid Treasury minute");
  const at = newYorkTimestamp(
    day.replaceAll("-", "") + "T" + String(hh).padStart(2, "0") + String(mm).padStart(2, "0") + "00",
  );
  if (!at) throw Error("Invalid Eastern auction clock");
  return at;
}

type Row = {
  cusip: string;
  day: string;
  description: string;
  tenor: number;
  reopened: boolean;
  announced: string;
  issue: string;
  maturity: string;
  close: string;
  result: string;
  high: string;
  median: string;
  cover: string;
};

function catalogRows(text: string): Row[] {
  const entries = JSON.parse(text);
  if (!Array.isArray(entries) || entries.length !== 250) throw Error("Incomplete Treasury auction catalogue");
  const rows: Row[] = [];
  const ids = new Set<string>();
  for (const r of entries) {
    if (!r || typeof r !== "object" || !["Bill", "CMB", "FRN", "TIPS", "Note", "Bond"].includes(r.type))
      throw Error("Unknown Treasury auction product");
    if (r.type !== "Note" && r.type !== "Bond") continue;
    const tenor = Number(/^(\d+)-Year$/.exec(r.originalSecurityTerm)?.[1]);
    if (
      !tenors.includes(tenor) ||
      r.securityType !== (tenor <= 10 ? "Note" : "Bond") ||
      r.securityType !== r.type ||
      r.inflationProtected !== "No" ||
      r.floatingRate !== "No" ||
      !["Yes", "No"].includes(r.reopening) ||
      !/^[0-9A-Z]{9}$/.test(r.cusip)
    )
      throw Error("Inconsistent nominal Treasury security identity");
    const day = requiredDay(r.competitiveAuctionCloseDate),
      announced = requiredDay(r.announcementDate);
    const issue = requiredDay(r.issueDate),
      maturity = requiredDay(r.maturityDate);
    const initialIssue = r.reopening === "Yes" ? requiredDay(r.originalIssueDate) : issue;
    const initialMonths =
      (Number(maturity.slice(0, 4)) - Number(initialIssue.slice(0, 4))) * 12 +
      Number(maturity.slice(5, 7)) -
      Number(initialIssue.slice(5, 7));
    if (
      Math.abs(initialMonths - 12 * tenor) > 1 ||
      issue < day ||
      announced > day ||
      initialIssue > issue ||
      maturity <= issue ||
      r.securityDescription !== r.securityTerm + " " + r.securityType
    )
      throw Error("Treasury maturity, announcement or auction identity differs");
    const id = day + "/" + r.cusip;
    if (ids.has(id)) throw Error("Duplicate nominal Treasury auction");
    ids.add(id);
    rows.push({
      cusip: r.cusip,
      day,
      tenor,
      description: r.securityDescription,
      announced,
      issue,
      maturity,
      reopened: r.reopening === "Yes",
      close: localClock(day, r.competitiveAuctionCloseTime),
      result: r.treasuryAuctionResultsXmlFileName,
      high: r.highYield,
      median: r.medianYield,
      cover: r.bidToCoverRatio,
    });
  }
  return rows;
}

function previousMonths(month: string) {
  const d = new Date(month + "-01T00:00:00Z");
  return Array.from({ length: 3 }, () => {
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  });
}

/** Select from all nominal announcements before looking at the values or availability of any result. */
export function selectAuctionPanel(text: string, session: string) {
  if (!dateOnly(session) || !hasReviewedCalendar(session)) return null;
  const c = exchangeSession(session);
  if (!c || Date.parse(c.closeAt) - Date.parse(c.openAt) !== fullDay) return null;
  const rows = catalogRows(text);
  const candidates = rows.filter(
    (r) =>
      r.day < session &&
      Date.parse(session) - Date.parse(r.day) <= 8 * millisPerDay &&
      targetAfterAuction(r.day)?.session === session,
  );
  if (candidates.length !== 1) return null;
  const current = candidates[0],
    panel = [current];
  for (const month of previousMonths(current.day.slice(0, 7))) {
    const matching = rows.filter((r) => r.day.slice(0, 7) === month && r.tenor === current.tenor);
    if (matching.length !== 1) return null;
    panel.push(matching[0]);
  }
  if (panel.some((r) => !r.result || !r.high || !r.median || !r.cover)) return null;
  for (const r of panel) {
    if (
      !/^R_\d{8}_[1-9]\d*\.xml$/.test(r.result) ||
      !r.result.startsWith("R_" + r.day.replaceAll("-", "") + "_")
    )
      throw Error("Noncompetitive or misdated Treasury result filename");
  }
  return panel;
}

export type AuctionNative = PublicDocument & { url: string; lastModified: string | null };
export async function readAuctionNative(url: string, fetcher: Fetcher = fetch): Promise<AuctionNative> {
  if (!/^https:\/\/www\.treasurydirect\.gov\/xml\/R_\d{8}_[1-9]\d*\.xml$/.test(url))
    throw Error("Invalid Treasury results URL");
  let lastModified: string | null = null;
  const { bytes, sha256, retrievedAt } = await publicBytes(
    url,
    async (u, init) => {
      const response = await fetcher(u, init);
      lastModified = response.headers.get("Last-Modified");
      return response;
    },
    128 * 1024,
    "application/xml,text/xml",
  );
  return {
    url,
    lastModified,
    sha256,
    retrievedAt,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  };
}

function tag(xml: string, name: string, optional = false): string {
  const values = [
    ...xml.matchAll(new RegExp("<" + name + "(?:\\s[^<>]*)?>([\\s\\S]*?)</" + name + ">", "g")),
  ];
  if (optional && values.length === 0) return "";
  if (values.length !== 1 || !values[0][1].trim()) throw Error("Missing or ambiguous Treasury XML " + name);
  return values[0][1].trim();
}

function yieldMills(s: string) {
  if (!/^-?\d{1,2}\.\d{3}$/.test(s)) throw Error("Unexpected Treasury yield units or precision");
  return Number(s.replace(".", ""));
}

function coverHundredths(s: string) {
  if (!/^[0-9]{1,2}\.\d{2}$/.test(s) || Number(s) <= 0) throw Error("Invalid Treasury bid-to-cover ratio");
  return Number(s.replace(".", ""));
}

export function verifyAuctionOriginal(row: Row, doc: AuctionNative, asOf: string) {
  if (
    doc.url !== "https://www.treasurydirect.gov/xml/" + row.result ||
    !stamp(doc.retrievedAt) ||
    !stamp(asOf) ||
    doc.retrievedAt > asOf ||
    doc.retrievedAt < row.close ||
    hash(doc.text) !== doc.sha256 ||
    Buffer.byteLength(doc.text) > 128 * 1024 ||
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/i.test(doc.text)
  )
    throw Error("Invalid Treasury original, bytes or custody clock");
  const xml = doc.text.replace(/^\s*<\?xml\s[^<>]*\?>\s*/, "").trim();
  let issue: string,
    results: string,
    competitiveDate: string,
    closeTime: string,
    floating: string,
    inflation: string,
    reopening: string;
  let yieldSection: string, coverageSection: string;
  let reported: string | null = null;
  if (/^<Data>\s*<TreasuryAuctionResults>/.test(xml) && xml.endsWith("</Data>")) {
    issue = results = tag(xml, "TreasuryAuctionResults");
    yieldSection = tag(results, "Yields");
    coverageSection = tag(results, "AuctionResultsBreakdown");
    if (
      tag(issue, "Technique") !== "Auction" ||
      tag(issue, "SecurityDescription") !== row.description ||
      tag(issue, "TreasuryAuctionResultsPressReleaseFileName") !== row.result.replace(".xml", ".pdf")
    )
      throw Error("Original Treasury competitive result identity differs");
    competitiveDate = tag(issue, "CompetitiveAuctionCloseDate");
    closeTime = tag(issue, "CompetitiveAuctionCloseTime");
    floating = tag(issue, "FloatingRate");
    inflation = tag(issue, "InflationProtected");
    reopening = tag(issue, "Reopening");
  } else if (
    /^<td:AuctionData\b[^<>]*xmlns:td="http:\/\/www\.treasurydirect\.gov\/"/.test(xml) &&
    xml.endsWith("</td:AuctionData>")
  ) {
    issue = tag(xml, "AuctionAnnouncement");
    results = tag(xml, "AuctionResults");
    yieldSection = coverageSection = results;
    const terms = [tag(issue, "SecurityTermWeekYear"), tag(issue, "SecurityTermDayMonth", true)].filter(
      (s) => s && !s.startsWith("0-"),
    );
    if ((terms.join(" ") + " " + tag(issue, "SecurityType")).toUpperCase() !== row.description.toUpperCase())
      throw Error("Legacy Treasury instrument term differs");
    competitiveDate = tag(issue, "AuctionDate");
    closeTime = tag(issue, "CompetitiveClosingTime");
    floating = tag(issue, "FloatingRate");
    inflation = tag(issue, "InflationIndexSecurity");
    reopening = tag(issue, "ReOpeningIndicator");
    const releaseTime = tag(results, "ReleaseTime", true);
    if (releaseTime) reported = new Date(Date.parse(localClock(row.day, releaseTime)) + 60_000).toISOString();
  } else throw Error("Unknown Treasury competitive result schema");
  if (
    tag(issue, "CUSIP") !== row.cusip ||
    tag(issue, "IssueDate") !== row.issue ||
    tag(issue, "MaturityDate") !== row.maturity ||
    tag(issue, "AnnouncementDate") !== row.announced ||
    competitiveDate !== row.day ||
    localClock(row.day, closeTime) !== row.close ||
    floating !== "N" ||
    inflation !== "N" ||
    reopening !== (row.reopened ? "Y" : "N") ||
    tag(issue, "SecurityType").toLowerCase() !== (row.tenor <= 10 ? "note" : "bond")
  )
    throw Error("Treasury result differs from catalogue security or clocks");
  const high = yieldMills(tag(yieldSection, "HighYield")),
    median = yieldMills(tag(yieldSection, "MedianYield")),
    low = yieldMills(tag(yieldSection, "LowYield"));
  const cover = coverHundredths(tag(coverageSection, "BidToCoverRatio"));
  if (
    high < median ||
    median < low ||
    high !== yieldMills(row.high) ||
    median !== yieldMills(row.median) ||
    cover !== coverHundredths(row.cover)
  )
    throw Error("Treasury yields or coverage did not reconcile");
  const modified =
    doc.lastModified && Number.isFinite(Date.parse(doc.lastModified))
      ? new Date(Date.parse(doc.lastModified)).toISOString()
      : null;
  if (modified && modified > doc.retrievedAt)
    throw Error("Treasury native modification is later than custody");
  if (reported && (reported < row.close || reported > doc.retrievedAt))
    throw Error("Treasury embedded release clock is inconsistent");
  const sameDay = modified && newYorkDate(modified) === row.day && modified >= row.close ? modified : null;
  if (!reported && !sameDay) throw Error("No contemporary Treasury competitive result clock");
  // A Last-Modified header dates this file version. Actual receipt proves it was available to this host.
  return {
    spread: high - median,
    cover,
    sourceClock: [reported, sameDay]
      .filter((s): s is string => !!s)
      .sort()
      .at(-1)!,
    witnessedAt: doc.retrievedAt,
  };
}

type Packed = { sha256: string; retrievedAt: string; gzip: string };
function pack(doc: PublicDocument): Packed {
  if (hash(doc.text) !== doc.sha256 || !stamp(doc.retrievedAt))
    throw Error("Invalid auction catalogue hash or clock");
  return { sha256: doc.sha256, retrievedAt: doc.retrievedAt, gzip: gzipSync(doc.text).toString("base64") };
}
function unpack(p: Packed, at: string) {
  if (!stamp(p.retrievedAt) || p.retrievedAt > at || typeof p.gzip !== "string" || p.gzip.length > 500_000)
    throw Error("Invalid packed auction catalogue");
  const text = gunzipSync(Buffer.from(p.gzip, "base64"), { maxOutputLength: 2_000_000 }).toString("utf8");
  if (hash(text) !== p.sha256) throw Error("Saved auction catalogue hash differs");
  return text;
}

type Receipt = {
  session: string;
  registeredAt: string;
  announced: Packed;
  auctioned: Packed;
  originals: AuctionNative[];
  sealedAt: string;
};
const median3 = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y)[1];
function replayPanel(receipt: Receipt, session: string, registeredAt: string, through: string) {
  if (
    receipt.session !== session ||
    receipt.registeredAt !== registeredAt ||
    !stamp(registeredAt) ||
    !stamp(receipt.sealedAt) ||
    receipt.sealedAt > through ||
    receipt.sealedAt >= exchangeSession(session)!.openAt ||
    [receipt.announced, receipt.auctioned, ...receipt.originals].some(
      (d) => d.retrievedAt <= registeredAt || d.retrievedAt > receipt.sealedAt,
    )
  )
    throw Error("Auction panel was not captured prospectively for this session");
  const rows = selectAuctionPanel(unpack(receipt.announced, receipt.sealedAt), session);
  const cleared = selectAuctionPanel(unpack(receipt.auctioned, receipt.sealedAt), session);
  if (!rows || !cleared || digest(rows) !== digest(cleared) || receipt.originals.length !== 4)
    throw Error("Announcements and competitive result catalogue select different auctions");
  const [a, b, c, d] = rows.map((r, i) => verifyAuctionOriginal(r, receipt.originals[i], receipt.sealedAt));
  if ([receipt.announced, receipt.auctioned].some((source) => source.retrievedAt < a.sourceClock))
    throw Error("Treasury catalogue predates the selected original result");
  if ([b, c, d].some((r) => r.sourceClock >= a.sourceClock))
    throw Error("Treasury controls postdate the selected release");
  return {
    eventId: "treasury-awards:" + rows[0].day + ":" + rows[0].cusip,
    candidate: -(a.spread - median3(b.spread, c.spread, d.spread)) / 10,
    control: (a.cover - median3(b.cover, c.cover, d.cover)) / 100,
    originalSourceClock: a.sourceClock,
    originalWitnessedAt: a.witnessedAt,
    panelHash: digest(rows),
    seal: digest(receipt),
  };
}

function referencePath(session: string, doc: Pick<PublicDocument, "sha256" | "retrievedAt">) {
  if (!dateOnly(session) || !stamp(doc.retrievedAt) || !/^[a-f0-9]{64}$/.test(doc.sha256))
    throw Error("Invalid auction witness path");
  return session + "-" + doc.retrievedAt.replace(/[:.]/g, "-") + "-" + doc.sha256 + ".json";
}
type Reference = { session: string; seal: string; catalogue: Packed; verifiedAt: string };

function verifyReference(
  ref: Reference,
  panel: ReturnType<typeof replayPanel>,
  receipt: Receipt,
  announced: Pick<PublicDocument, "sha256" | "retrievedAt">,
  asOf: string,
) {
  const open = exchangeSession(receipt.session)!.openAt;
  if (
    ref.session !== receipt.session ||
    ref.seal !== panel.seal ||
    ref.catalogue.sha256 !== announced.sha256 ||
    ref.catalogue.retrievedAt !== announced.retrievedAt ||
    ref.catalogue.retrievedAt <= receipt.registeredAt ||
    ref.catalogue.retrievedAt < panel.originalSourceClock ||
    !stamp(ref.verifiedAt) ||
    ref.verifiedAt < ref.catalogue.retrievedAt ||
    ref.verifiedAt < receipt.sealedAt ||
    ref.verifiedAt >= open ||
    ref.verifiedAt > asOf ||
    digest(selectAuctionPanel(unpack(ref.catalogue, asOf), receipt.session)) !== panel.panelHash
  )
    throw Error("Edition Treasury announcement witness fails its original comparison");
}

export async function captureAuctionDispersion(
  directory: string,
  registeredAt: string,
  announced: PublicDocument,
  readCatalog: (url: string) => Promise<PublicDocument>,
  readNative: (url: string) => Promise<AuctionNative>,
  wall = () => new Date().toISOString(),
) {
  const now = wall(),
    target = nextEligibleMorning(now);
  if (!target || !stamp(registeredAt) || announced.retrievedAt <= registeredAt || announced.retrievedAt > now)
    return "outside_window";
  const rows = selectAuctionPanel(announced.text, target.session);
  if (!rows || rows[0].close > now) return "no_complete_distinct_auction";
  const { session } = target;
  const receipt = await immutableSourceReceipt(
    join(directory, "panels"),
    session + ".json",
    async () => {
      const auctioned = await readCatalog(TREASURY_AUCTIONED);
      const cleared = selectAuctionPanel(auctioned.text, session);
      if (!cleared || digest(cleared) !== digest(rows)) throw Error("Treasury auction catalogues disagree");
      const originals = await Promise.all(
        rows.map((row) => readNative("https://www.treasurydirect.gov/xml/" + row.result)),
      );
      return {
        session,
        registeredAt,
        announced: pack(announced),
        auctioned: pack(auctioned),
        originals,
        sealedAt: wall(),
      };
    },
    (value) => {
      replayPanel(value, session, registeredAt, wall());
    },
  );
  const sealed = replayPanel(receipt, session, registeredAt, wall());
  if (digest(rows) !== sealed.panelHash) return "changed_auction_withheld";
  await immutableSourceReceipt(
    join(directory, "references"),
    referencePath(session, announced),
    async () => ({
      session,
      seal: sealed.seal,
      catalogue: pack(announced),
      verifiedAt: wall(),
    }),
    (ref) => verifyReference(ref, sealed, receipt, announced, wall()),
  );
  return "source_witnessed";
}

export async function replayAuctionDispersion(
  directory: string,
  registeredAt: string,
  session: string,
  announced: Pick<PublicDocument, "sha256" | "retrievedAt">,
  cutoff: string,
) {
  if (!stamp(cutoff) || !dateOnly(session) || !hasReviewedCalendar(session)) return null;
  const c = exchangeSession(session);
  if (!c || cutoff >= c.openAt || announced.retrievedAt > cutoff) return null;
  const ref = await readResearchReceipt<Reference>(
    join(directory, "references", referencePath(session, announced)),
  );
  if (!ref) return null;
  const saved = await readResearchReceipt<Receipt>(join(directory, "panels", session + ".json"));
  if (!saved) throw Error("Sealed Treasury source panel missing");
  const point = replayPanel(saved, session, registeredAt, cutoff);
  verifyReference(ref, point, saved, announced, cutoff);
  return {
    ...point,
    observedThrough: ref.verifiedAt,
    sourceSeal: digest([point.seal, ref]),
  };
}
