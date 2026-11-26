import { publicDate } from "../public-normalization.ts";
import { targetAfterAuction } from "./auction-dispersion-calendar.ts";
import { newYorkDate } from "./time.ts";
import type { Signal } from "./types.ts";

export const TREASURY_AWARD_ID = "treasury-competitive-auction-results";
const RESULT_INDEX = "https://www.treasurydirect.gov/auctions/announcements-data-results/";
const CATALOGUE_URL = "https://www.treasurydirect.gov/TA_WS/securities/announced?format=json";
const stamp = (value: string) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isSHA = (value: string) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

interface ResultRow {
  auctionDate: string;
  spreadBp: number;
  bidToCover: number;
  resultUrl: string;
  sha256: string;
}

export interface AuctionResultObservation {
  tenorYears: number;
  currentCusip: string;
  bidDeadlineAt: string;
  releaseMinuteAt: string | null;
  fileVersionAt: string | null;
  firstObservedAt: string;
  expiresAt: string;
  /** Current auction, then the auction of the same original tenor in each of the previous three months. */
  results: ResultRow[];
}

export interface TreasuryAuctionEvidence extends AuctionResultObservation {
  catalogue: { sha256: string; retrievedAt: string };
  verifiedAt: string;
}

function threeAuctionMedian(values: number[]) {
  return [...values].sort((a, b) => a - b)[1];
}

function presentation(evidence: TreasuryAuctionEvidence) {
  const [current, ...prior] = evidence.results;
  const spread = threeAuctionMedian(prior.map((row) => row.spreadBp));
  const cover = threeAuctionMedian(prior.map((row) => row.bidToCover));
  return {
    summary: `The ${evidence.tenorYears}-year auction’s highest accepted yield was ${current.spreadBp.toFixed(1)} bp above its median, compared with a median gap of ${spread.toFixed(1)} bp at the previous three auctions. Bid-to-cover was ${current.bidToCover.toFixed(2)}× against a three-auction median of ${cover.toFixed(2)}×.`,
    metrics: [
      {
        label: "High minus median accepted yield",
        value: current.spreadBp,
        unit: "bp",
        date: current.auctionDate,
      },
      {
        label: "Median yield gap at previous three auctions",
        value: spread,
        unit: "bp",
        date: prior[0].auctionDate,
      },
      { label: "Bid-to-cover", value: current.bidToCover, unit: "×", date: current.auctionDate },
      {
        label: "Median bid-to-cover at previous three auctions",
        value: cover,
        unit: "×",
        date: prior[0].auctionDate,
      },
    ],
  };
}

export function treasuryAuctionObservation(
  evidence: TreasuryAuctionEvidence | null,
  checkedAt: string,
): Signal {
  const current = evidence?.results[0];
  const observed = current && evidence ? presentation(evidence) : undefined;
  return {
    id: TREASURY_AWARD_ID,
    family: "events",
    title: "Treasury competitive auction results",
    shortLabel: "Treasury auction results",
    instruments: ["TLT"],
    directionalInstruments: [],
    status: observed ? "available" : "unavailable",
    summary:
      observed?.summary ??
      "A matching Treasury result and complete three-auction comparison are unavailable for the next full trading session.",
    source: {
      name: "U.S. Treasury · TreasuryDirect",
      url: current?.resultUrl ?? RESULT_INDEX,
      observedAt: current?.auctionDate ?? null,
      releasedAt: evidence?.releaseMinuteAt ?? current?.auctionDate ?? null,
      ...(evidence?.fileVersionAt ? { vintageAt: evidence.fileVersionAt } : {}),
      ...(evidence ? { approvedAt: evidence.verifiedAt } : {}),
      retrievedAt: evidence?.firstObservedAt ?? checkedAt,
      sha256: current?.sha256 ?? null,
      frequency: "per competitive nominal note or bond auction",
      attribution: "U.S. Department of the Treasury, Bureau of the Fiscal Service.",
      usage: "Public Treasury auction statistics with links to the original competitive results.",
    },
    methodology:
      "Treasury reports the high and median yields of accepted competitive bids. The gap is their difference in basis points. Each comparison uses the median of the preceding three monthly auctions of the same original tenor. Treasury’s announced and auctioned catalogues must agree with all four competitive result files.",
    limitation:
      "Bid-to-cover measures bids relative to the amount accepted. These auction statistics carry no directional vote or price forecast.",
    series: [],
    metrics: observed?.metrics ?? [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 8,
    unit: "bp",
    ...(evidence ? { treasuryAuction: evidence } : {}),
  };
}

export function treasuryAuctionExpired(signal: Signal, at: string): boolean {
  return (
    signal.id === TREASURY_AWARD_ID &&
    !!signal.treasuryAuction &&
    Date.parse(at) >= Date.parse(signal.treasuryAuction.expiresAt)
  );
}

function monthNumber(date: string) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
}

function validResult(row: ResultRow) {
  return (
    row &&
    publicDate(row.auctionDate) === row.auctionDate &&
    isSHA(row.sha256) &&
    /^https:\/\/www\.treasurydirect\.gov\/xml\/R_\d{8}_[1-9]\d*\.xml$/.test(row.resultUrl) &&
    row.resultUrl.startsWith(
      "https://www.treasurydirect.gov/xml/R_" + row.auctionDate.replaceAll("-", "") + "_",
    ) &&
    Number.isFinite(row.spreadBp) &&
    row.spreadBp >= 0 &&
    Number(row.spreadBp.toFixed(1)) === row.spreadBp &&
    Number.isFinite(row.bidToCover) &&
    row.bidToCover > 0 &&
    Number(row.bidToCover.toFixed(2)) === row.bidToCover
  );
}

/** The ordinary calendar and the results must cite exactly the same host capture of Treasury's panel. */
export function validateTreasuryAuctionObservation(signal: Signal, cutoff: string, calendar?: Signal) {
  const evidence = signal.treasuryAuction;
  if (signal.id !== TREASURY_AWARD_ID) {
    if (evidence !== undefined) throw Error("Treasury auction evidence has the wrong signal identity");
    return;
  }
  if (
    signal.family !== "events" ||
    signal.instruments.join() !== "TLT" ||
    !Array.isArray(signal.directionalInstruments) ||
    signal.directionalInstruments.length ||
    signal.scores.daily !== null ||
    signal.scores.weekly !== null ||
    signal.scores.monthly !== null ||
    signal.staleAfterDays !== 8 ||
    signal.series.length
  )
    throw Error("Invalid Treasury auction observation scope");
  if (!evidence) {
    if (
      signal.status !== "unavailable" ||
      signal.metrics.length ||
      signal.source.url !== RESULT_INDEX ||
      signal.source.observedAt !== null ||
      signal.source.sha256 !== null ||
      signal.source.releasedAt !== null ||
      signal.source.approvedAt !== undefined ||
      signal.source.vintageAt !== undefined
    )
      throw Error("Unverified Treasury auction observation carries data");
    return;
  }
  if (
    signal.status !== "available" ||
    ![2, 3, 5, 7, 10, 20, 30].includes(evidence.tenorYears) ||
    !/^[A-Z0-9]{9}$/.test(evidence.currentCusip) ||
    !Array.isArray(evidence.results) ||
    evidence.results.length !== 4 ||
    !evidence.results.every(validResult)
  )
    throw Error("Invalid Treasury competitive results or source identity");
  const [current, ...prior] = evidence.results;
  if (
    prior.some((r, i) => monthNumber(current.auctionDate) - monthNumber(r.auctionDate) !== i + 1) ||
    targetAfterAuction(current.auctionDate)?.openAt !== evidence.expiresAt
  )
    throw Error("Invalid Treasury comparison months or target session");
  if (
    !evidence.catalogue ||
    !isSHA(evidence.catalogue.sha256) ||
    ![
      evidence.bidDeadlineAt,
      evidence.firstObservedAt,
      evidence.verifiedAt,
      evidence.catalogue.retrievedAt,
    ].every(stamp) ||
    newYorkDate(evidence.bidDeadlineAt) !== current.auctionDate ||
    evidence.bidDeadlineAt > evidence.firstObservedAt ||
    evidence.firstObservedAt > evidence.verifiedAt ||
    evidence.catalogue.retrievedAt > evidence.verifiedAt ||
    evidence.verifiedAt >= evidence.expiresAt ||
    evidence.verifiedAt > cutoff ||
    (evidence.releaseMinuteAt === null && evidence.fileVersionAt === null)
  )
    throw Error("Invalid Treasury source or capture clocks");
  if (evidence.releaseMinuteAt !== null) {
    const endOfMinute = Date.parse(evidence.releaseMinuteAt) + 60_000;
    if (
      !evidence.releaseMinuteAt.endsWith(":00.000Z") ||
      endOfMinute > Date.parse(evidence.firstObservedAt) ||
      endOfMinute > Date.parse(evidence.catalogue.retrievedAt)
    )
      throw Error("The complete Treasury publication minute was not yet observable");
  }
  for (const sourceClock of [evidence.releaseMinuteAt, evidence.fileVersionAt]) {
    if (
      sourceClock !== null &&
      (!stamp(sourceClock) ||
        newYorkDate(sourceClock) !== current.auctionDate ||
        sourceClock < evidence.bidDeadlineAt ||
        sourceClock > evidence.firstObservedAt ||
        sourceClock > evidence.catalogue.retrievedAt)
    )
      throw Error("Invalid Treasury release minute or file version");
  }
  if (
    !calendar ||
    calendar.id !== "treasury-calendar" ||
    calendar.status !== "available" ||
    calendar.source.url !== CATALOGUE_URL ||
    calendar.source.sha256 !== evidence.catalogue.sha256 ||
    calendar.source.retrievedAt !== evidence.catalogue.retrievedAt
  )
    throw Error("Treasury auction comparison differs from the edition's calendar capture");
  const expected = treasuryAuctionObservation(evidence, cutoff);
  if (
    JSON.stringify(signal.metrics) !== JSON.stringify(expected.metrics) ||
    signal.summary !== expected.summary ||
    signal.source.url !== current.resultUrl ||
    signal.source.sha256 !== current.sha256 ||
    signal.source.observedAt !== current.auctionDate ||
    signal.source.releasedAt !== expected.source.releasedAt ||
    signal.source.vintageAt !== expected.source.vintageAt ||
    signal.source.approvedAt !== evidence.verifiedAt ||
    signal.source.retrievedAt !== evidence.firstObservedAt
  )
    throw Error("Treasury auction statistics or their cited provenance differ");
}
