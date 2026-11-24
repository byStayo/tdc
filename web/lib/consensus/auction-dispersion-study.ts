import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUCTION_SOURCE_DIRECTORY,
  captureAuctionDispersion,
  readAuctionNative,
  replayAuctionDispersion,
  targetAfterAuction,
  TREASURY_ANNOUNCED,
} from "./auction-dispersion-source.ts";
import { AUCTION_DISPERSION_POLICY } from "./auction-dispersion-policy.ts";
import { collectMarketCalendars, type PublicDocument } from "./calendars.ts";
import { KIBOT_SUBSCRIBER_EOD_SOURCE } from "./kibot-eod-disclosure.ts";
import { MARKET_HISTORY_SOURCE } from "./market-history-settlement.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet.ts";
import { verifyPreopenWithMorningConfirmation } from "./preopen-receipt.ts";
import { publicText, type Fetcher } from "./public-source.ts";
import { createSecondaryStudy, type StudyPoint } from "./secondary-study.ts";
import { newYorkDate } from "./time.ts";
import type { Snapshot } from "./types.ts";

const policySha = "3e523da29a6beae941a03e5771e10c4170dd0f6e94a5bfb623f74e2dec233103";
const grants = [MARKET_HISTORY_SOURCE, MARKETPARQUET_SOURCE, KIBOT_SUBSCRIBER_EOD_SOURCE];

async function witnessedAuction(
  root: string,
  session: string,
  edition: string,
  registeredAt: string,
): Promise<StudyPoint[]> {
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition)) throw Error("Invalid Treasury study edition");
  const bytes = await readFile(join(root, "public/consensus", edition + ".json"));
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  const observation = snapshot.signals.find((s) => s.id === "treasury-calendar");
  if (
    !observation ||
    observation.status !== "available" ||
    observation.family !== "events" ||
    observation.source.url !== TREASURY_ANNOUNCED ||
    !observation.source.sha256
  )
    return [];
  const witness = await verifyPreopenWithMorningConfirmation(
    root,
    session,
    edition,
    bytes,
    new Date().toISOString(),
  );
  if (newYorkDate(witness.observedAt) !== session) return [];
  const source = await replayAuctionDispersion(
    join(root, AUCTION_SOURCE_DIRECTORY),
    registeredAt,
    session,
    {
      sha256: observation.source.sha256,
      retrievedAt: observation.source.retrievedAt,
    },
    snapshot.cutoff,
  );
  if (!source) return [];
  return [
    {
      instrument: "TLT",
      eventId: source.eventId,
      issuedAt: snapshot.issuedAt,
      observedThrough: source.observedThrough,
      recordedAt: witness.observedAt,
      sourceSeal: source.sourceSeal,
      control: source.control,
      candidate: source.candidate,
    },
  ];
}

export const auctionDispersionStudy = createSecondaryStudy({
  directory: ".consensus/private-treasury-award-study/v1",
  earliest: "2026-11-24T18:11:32.609Z",
  policy: AUCTION_DISPERSION_POLICY,
  policySha,
  requireNewRelease: false,
  disjointTests: true,
  granted: (fund, source) => fund === "TLT" && grants.includes(source),
  readPoints: (root, session, edition, fund, registeredAt) =>
    fund === undefined || fund === "TLT"
      ? witnessedAuction(root, session, edition, registeredAt)
      : Promise.resolve([]),
  validFeature: (e) => {
    const auction = /^treasury-awards:(\d{4}-\d\d-\d\d):[A-Z0-9]{9}$/.exec(e.id);
    return e.fund === "TLT" && !!auction && targetAfterAuction(auction[1])?.session === e.session;
  },
});

/** Operational source preflight. Registration, publication and ETF labels each have their own entry point. */
export async function collectAuctionStudyOnly(root: string, fetcher: Fetcher = fetch) {
  const registration = await auctionDispersionStudy.registration(root);
  if (!registration) return { status: "not_registered" };
  const read = (url: string) => publicText(url, fetcher);
  const announced = await read(TREASURY_ANNOUNCED);
  const status = await captureAuctionDispersion(
    join(root, AUCTION_SOURCE_DIRECTORY),
    registration.registeredAt,
    announced,
    read,
    (url) => readAuctionNative(url, fetcher),
  );
  return { status, receivedAt: announced.retrievedAt, sha256: announced.sha256 };
}

/** Use the exact calendar acquisition visible in this edition; an optional study outage cannot invalidate its public data. */
export async function collectMarketCalendarsWithAuction(
  read: (url: string) => Promise<PublicDocument>,
  fetcher: Fetcher,
  root?: string,
) {
  let announced: PublicDocument | undefined;
  const calendars = await collectMarketCalendars(async (url) => {
    const source = await read(url);
    if (url === TREASURY_ANNOUNCED) announced = source;
    return source;
  });
  if (!root || !announced) return calendars;
  try {
    const registration = await auctionDispersionStudy.registration(root);
    if (registration)
      await captureAuctionDispersion(
        join(root, AUCTION_SOURCE_DIRECTORY),
        registration.registeredAt,
        announced,
        read,
        (url) => readAuctionNative(url, fetcher),
      );
  } catch {
    console.error("Private Treasury auction comparison could not verify the complete dated source panel.");
  }
  return calendars;
}
