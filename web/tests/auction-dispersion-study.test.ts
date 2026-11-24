import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { AUCTION_DISPERSION_POLICY } from "../lib/consensus/auction-dispersion-policy.ts";
import {
  AUCTION_SOURCE_DIRECTORY,
  captureAuctionDispersion,
  nextEligibleMorning,
  replayAuctionDispersion,
  selectAuctionPanel,
  targetAfterAuction,
  TREASURY_ANNOUNCED,
  TREASURY_AUCTIONED,
  verifyAuctionOriginal,
  type AuctionNative,
} from "../lib/consensus/auction-dispersion-source.ts";
import {
  auctionDispersionStudy,
  collectMarketCalendarsWithAuction,
} from "../lib/consensus/auction-dispersion-study.ts";
import { exchangeCalendarVersion, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { calculateConsensus, effectiveStatus } from "../lib/consensus/engine.ts";
import {
  TREASURY_AWARD_ID,
  validateTreasuryAuctionObservation,
} from "../lib/consensus/treasury-auction-observation.ts";
import { MARKET_HISTORY_SOURCE } from "../lib/consensus/market-history-settlement.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { publisherSecondaryStudies } from "../lib/consensus/secondary-studies.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const target = "2026-11-25";
const issuedAt = target + "T13:00:00.000Z";
const edition = issuedAt.replace(/[:.]/g, "-");
const registration = "2026-11-24T18:12:00.000Z";
const receiptAt = "2026-11-24T18:20:00.000Z";
const now = () => new Date().toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const document = (text: string, at = now()) => ({ text, sha256: hash(text), retrievedAt: at });

function nominal(i: number, day: string, high: string, median: string, cover: string) {
  const date = day + "T00:00:00";
  return {
    type: "Note",
    securityType: "Note",
    originalSecurityTerm: "5-Year",
    securityTerm: "5-Year",
    securityDescription: "5-Year Note",
    inflationProtected: "No",
    floatingRate: "No",
    reopening: "No",
    cusip: "91200000" + i,
    competitiveAuctionCloseDate: date,
    announcementDate: day.slice(0, 7) + "-01T00:00:00",
    issueDate: date,
    maturityDate: "2031-" + day.slice(5) + "T00:00:00",
    competitiveAuctionCloseTime: "01:00 PM",
    highYield: high,
    medianYield: median,
    bidToCoverRatio: cover,
    treasuryAuctionResultsXmlFileName: "R_" + day.replaceAll("-", "") + "_1.xml",
  };
}
const recent = [
  nominal(1, "2026-11-24", "4.400", "4.335", "2.38"),
  nominal(2, "2026-10-27", "4.060", "4.010", "2.33"),
  nominal(3, "2026-09-23", "4.193", "4.120", "2.27"),
  nominal(4, "2026-08-26", "4.155", "4.110", "2.43"),
];
const bill = {
  type: "Bill",
  securityType: "Bill",
  securityTerm: "4-Week",
  cusip: "912000108",
  competitiveAuctionCloseDate: "2026-11-25T00:00:00",
  competitiveAuctionCloseTime: "10:00 AM",
  announcementDate: "2026-11-24T00:00:00",
};
function catalogue(rows = recent, variant = "") {
  return JSON.stringify([
    ...rows,
    ...Array.from({ length: 250 - rows.length }, () => ({ ...bill, variant })),
  ]);
}

function native(r: (typeof recent)[number], legacy = false, at = now()): AuctionNative {
  const day = r.competitiveAuctionCloseDate.slice(0, 10);
  const a = r.announcementDate.slice(0, 10);
  const identity =
    "<CUSIP>" +
    r.cusip +
    "</CUSIP><AnnouncementDate>" +
    a +
    "</AnnouncementDate><IssueDate>" +
    day +
    "</IssueDate><MaturityDate>" +
    r.maturityDate.slice(0, 10) +
    "</MaturityDate>";
  const financial =
    "<HighYield>" +
    r.highYield +
    "</HighYield><MedianYield>" +
    r.medianYield +
    "</MedianYield>" +
    "<LowYield>3.000</LowYield><BidToCoverRatio>" +
    r.bidToCoverRatio +
    "</BidToCoverRatio>";
  const name = r.treasuryAuctionResultsXmlFileName;
  const text = legacy
    ? '<td:AuctionData xmlns:td="http://www.treasurydirect.gov/"><AuctionAnnouncement>' +
      identity +
      "<SecurityType>NOTE</SecurityType><SecurityTermWeekYear>5-YEAR</SecurityTermWeekYear><SecurityTermDayMonth>0-MONTH</SecurityTermDayMonth>" +
      "<AuctionDate>" +
      day +
      "</AuctionDate><CompetitiveClosingTime>13:00</CompetitiveClosingTime><FloatingRate>N</FloatingRate>" +
      "<InflationIndexSecurity>N</InflationIndexSecurity><ReOpeningIndicator>N</ReOpeningIndicator></AuctionAnnouncement>" +
      "<AuctionResults><ReleaseTime>13:02</ReleaseTime>" +
      financial +
      "</AuctionResults></td:AuctionData>"
    : "<Data><TreasuryAuctionResults>" +
      identity +
      "<Technique>Auction</Technique><SecurityType>Note</SecurityType><SecurityDescription>5-Year Note</SecurityDescription>" +
      "<TreasuryAuctionResultsPressReleaseFileName>" +
      name.replace(".xml", ".pdf") +
      "</TreasuryAuctionResultsPressReleaseFileName>" +
      "<CompetitiveAuctionCloseDate>" +
      day +
      "</CompetitiveAuctionCloseDate><CompetitiveAuctionCloseTime>01:00 PM ET</CompetitiveAuctionCloseTime>" +
      "<FloatingRate>N</FloatingRate><InflationProtected>N</InflationProtected><Reopening>N</Reopening>" +
      "<Yields>" +
      financial.replace("<BidToCoverRatio>", "</Yields><AuctionResultsBreakdown><BidToCoverRatio>") +
      "</AuctionResultsBreakdown></TreasuryAuctionResults></Data>";
  const current = day.startsWith("2026-11");
  return {
    ...document(text, at),
    url: "https://www.treasurydirect.gov/xml/" + name,
    lastModified: new Date(day + (current ? "T18:02:45Z" : "T17:02:45Z")).toUTCString(),
  };
}

const set = (t: TestContext, at: string) => t.mock.timers.setTime(Date.parse(at));
async function workspace(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(registration) });
  const root = await mkdtemp(join(tmpdir(), "treasury-awards-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dir: join(root, AUCTION_SOURCE_DIRECTORY) };
}
const rejectRead = async () => {
  throw Error("Unexpected source read");
};
const documents = async (url: string) => {
  const r = recent.find((x) => url.endsWith("/" + x.treasuryAuctionResultsXmlFileName));
  assert.ok(r);
  return native(r, r === recent[2]);
};

test("select the single nominal auction and exactly its previous three calendar months before opening values", () => {
  assert.equal(selectAuctionPanel(catalogue(), target)?.length, 4);
  assert.equal(targetAfterAuction("2026-11-24")?.session, target);
  assert.equal(targetAfterAuction("2026-11-25")?.session, "2026-11-30");
  assert.equal(nextEligibleMorning("2026-11-27T13:00:00.000Z")?.session, "2026-11-30");
  assert.equal(targetAfterAuction("2027-11-24"), null); // Crosses an exchange opening with unreviewed hours.
  assert.equal(selectAuctionPanel(catalogue(), "2026-11-27"), null);
  const shared = { ...recent[0], cusip: "912000009", highYield: "", treasuryAuctionResultsXmlFileName: "" };
  assert.equal(selectAuctionPanel(catalogue([...recent, shared]), target), null);
  assert.equal(selectAuctionPanel(catalogue(recent.slice(0, 3)), target), null);
  assert.throws(() => selectAuctionPanel(catalogue([...recent, recent[1]]), target), /Duplicate/);
  assert.throws(() =>
    selectAuctionPanel(
      catalogue([
        { ...recent[0], treasuryAuctionResultsXmlFileName: "NC_20261124_1.xml" },
        ...recent.slice(1),
      ]),
      target,
    ),
  );
  assert.equal(
    digest(AUCTION_DISPERSION_POLICY),
    "3e523da29a6beae941a03e5771e10c4170dd0f6e94a5bfb623f74e2dec233103",
  );
});

test("current and legacy original formats reconcile percentage yields and their real result clocks", () => {
  const rows = selectAuctionPanel(catalogue(), target)!;
  const a = native(recent[0], false, receiptAt),
    b = native(recent[2], true, receiptAt);
  assert.deepEqual(verifyAuctionOriginal(rows[0], a, receiptAt), {
    releaseMinuteAt: null,
    fileVersionAt: "2026-11-24T18:02:45.000Z",
    spread: 65,
    cover: 238,
    sourceClock: "2026-11-24T18:02:45.000Z",
    witnessedAt: receiptAt,
  });
  assert.deepEqual(verifyAuctionOriginal(rows[2], b, receiptAt), {
    releaseMinuteAt: "2026-09-23T17:02:00.000Z",
    fileVersionAt: "2026-09-23T17:02:45.000Z",
    spread: 73,
    cover: 227,
    sourceClock: "2026-09-23T17:03:00.000Z",
    witnessedAt: receiptAt,
  });
  for (const [before, after] of [
    ["4.335", "4.401"],
    ["4.400", "4.40"],
    ["912000001", "912001001"],
    ["<MedianYield>", "<MedianYield>4.335</MedianYield><MedianYield>"],
    ["<FloatingRate>N", "<FloatingRate>Y"],
  ]) {
    const text = a.text.replace(before, after);
    assert.throws(() => verifyAuctionOriginal(rows[0], { ...a, text, sha256: hash(text) }, receiptAt));
  }
  for (const cm of [
    null,
    "Mon, 23 Nov 2026 18:02:00 GMT",
    "Tue, 24 Nov 2026 17:59:59 GMT",
    "Wed, 25 Nov 2026 19:00:00 GMT",
  ])
    assert.throws(() => verifyAuctionOriginal(rows[0], { ...a, lastModified: cm }, receiptAt));
  assert.throws(() => verifyAuctionOriginal(rows[0], a, registration));
});

test("a disputed second delivery or a result vector captured before its official clock cannot seal a panel", async (t) => {
  const { dir } = await workspace(t);
  set(t, receiptAt);
  const doc = document(catalogue());
  const mismatch = document(catalogue([{ ...recent[0], highYield: "4.401" }, ...recent.slice(1)]));
  await assert.rejects(
    captureAuctionDispersion(dir, registration, doc, async () => mismatch, rejectRead),
    /disagree/,
  );
  const early = document(catalogue(), "2026-11-24T18:00:30.000Z");
  await assert.rejects(
    captureAuctionDispersion(dir, "2026-11-24T17:50:00.000Z", early, async () => doc, documents),
    /predates/,
  );
  await assert.rejects(readFile(join(dir, "panels", target + ".json")), { code: "ENOENT" });
});

test("preserve the first source panel, bind each public capture clock, and withhold corrected or corrupted sources", async (t) => {
  const { dir } = await workspace(t);
  set(t, receiptAt);
  const doc = document(catalogue());
  assert.equal(await captureAuctionDispersion(dir, receiptAt, doc, rejectRead, rejectRead), "outside_window");
  assert.equal(
    await captureAuctionDispersion(dir, registration, doc, async () => doc, documents),
    "source_witnessed",
  );
  const first = await replayAuctionDispersion(dir, registration, target, doc, now());
  assert.ok(first);
  assert.equal(first.candidate, -1.5);
  assert.equal(first.control, 0.05);
  set(t, "2026-11-24T18:30:00.000Z");
  const current = document(catalogue(recent, "a new bill"));
  assert.equal(
    await captureAuctionDispersion(dir, registration, current, rejectRead, rejectRead),
    "source_witnessed",
  );
  const changed = document(catalogue([{ ...recent[0], medianYield: "4.334" }, ...recent.slice(1)]));
  assert.equal(
    await captureAuctionDispersion(dir, registration, changed, rejectRead, rejectRead),
    "changed_auction_withheld",
  );
  assert.equal(await replayAuctionDispersion(dir, registration, target, changed, now()), null);
  assert.equal(await replayAuctionDispersion(dir, registration, target, current, receiptAt), null);
  assert.equal((await replayAuctionDispersion(dir, registration, target, current, now()))?.candidate, -1.5);
  assert.equal(await replayAuctionDispersion(dir, registration, "2026-11-30", doc, now()), null);
  const path = join(dir, "panels", target + ".json");
  const damaged = JSON.parse(await readFile(path, "utf8"));
  damaged.originals[0].text = damaged.originals[0].text.replace("4.400", "4.100");
  await durableJSON(path, damaged);
  await assert.rejects(replayAuctionDispersion(dir, registration, target, current, now()), /original/);
});

test("an inactive or unavailable private auction source preserves the ordinary public calendar", async (t) => {
  const { root, dir } = await workspace(t);
  let alternativeRequests = 0;
  const read = async (url: string) => {
    if (url === TREASURY_ANNOUNCED) return document(catalogue());
    if (url === TREASURY_AUCTIONED) alternativeRequests++;
    throw Error("Missing alternate or unrelated fixture");
  };
  let result = await collectMarketCalendarsWithAuction(read, rejectRead, root);
  assert.equal(alternativeRequests, 0);
  const missing = result.signals.find((s) => s.id === TREASURY_AWARD_ID)!;
  assert.equal(missing.status, "unavailable");
  validateTreasuryAuctionObservation(missing, now());
  assert.equal(result.signals.find((s) => s.id === "treasury-calendar")?.status, "available");
  await auctionDispersionStudy.register(root);
  set(t, receiptAt);
  result = await collectMarketCalendarsWithAuction(read, rejectRead, root);
  assert.equal(alternativeRequests, 1);
  assert.equal(result.signals.find((s) => s.id === TREASURY_AWARD_ID)?.status, "unavailable");
  assert.equal(result.signals.find((s) => s.id === "treasury-calendar")?.status, "available");
  await assert.rejects(readFile(join(dir, "panels", target + ".json")), { code: "ENOENT" });
});

test("ordinary collector exposes only the four official auction statistics until the next full opening", async (t) => {
  const { root } = await workspace(t);
  await auctionDispersionStudy.register(root);
  set(t, receiptAt);
  let rows = recent;
  let resultRequests = 0;
  const read = async (url: string) => {
    if (url === TREASURY_AUCTIONED) resultRequests++;
    else if (url !== TREASURY_ANNOUNCED) throw Error("Unrelated calendar");
    return document(catalogue(rows));
  };
  const transport = async (url: string) => {
    resultRequests++;
    const doc = await documents(url);
    return new Response(doc.text, { headers: { "last-modified": doc.lastModified! } });
  };
  await collectMarketCalendarsWithAuction(read, transport, root);
  assert.equal(resultRequests, 5);
  set(t, issuedAt);
  const feed = await collectMarketCalendarsWithAuction(read, transport, root);
  const signal = feed.signals.find((s) => s.id === TREASURY_AWARD_ID)!;
  const calendar = feed.signals.find((s) => s.id === "treasury-calendar")!;
  assert.equal(resultRequests, 5);
  assert.equal(signal.status, "available");
  assert.deepEqual(
    signal.metrics.map((m) => [m.value, m.unit]),
    [
      [6.5, "bp"],
      [5, "bp"],
      [2.38, "×"],
      [2.33, "×"],
    ],
  );
  assert.deepEqual(signal.directionalInstruments, []);
  assert.deepEqual(signal.scores, { daily: null, weekly: null, monthly: null });
  assert.equal(signal.source.url, native(recent[0]).url);
  assert.equal(signal.source.sha256, native(recent[0]).sha256);
  assert.equal(signal.source.observedAt, "2026-11-24");
  assert.equal(signal.source.releasedAt, "2026-11-24");
  assert.equal(signal.source.vintageAt, "2026-11-24T18:02:45.000Z");
  assert.equal(signal.source.retrievedAt, receiptAt);
  assert.equal(signal.source.approvedAt, issuedAt);
  assert.equal(signal.treasuryAuction!.bidDeadlineAt, "2026-11-24T18:00:00.000Z");
  assert.equal(effectiveStatus(signal, "2026-11-25T09:29:59-05:00"), "available");
  assert.equal(effectiveStatus(signal, "2026-11-25T09:30:00-05:00"), "stale");
  const before = calculateConsensus([calendar], "TLT", "daily", issuedAt);
  const after = calculateConsensus([calendar, signal], "TLT", "daily", issuedAt);
  assert.equal(after.directionalCoverage, before.directionalCoverage);
  assert.equal(after.score, before.score);
  const snapshot: Snapshot = {
    schemaVersion: 1,
    id: edition,
    issuedAt,
    cutoff: issuedAt,
    engineVersion: "test-v1",
    origin: "prospective",
    signals: [calendar, signal],
    catalysts: [],
    sourcesAttempted: 2,
    collectionErrors: [],
  };
  validateSnapshot(snapshot);
  const assertRejected = (modify: (s: Signal) => void) => {
    const altered = structuredClone(signal);
    modify(altered);
    assert.throws(() => validateSnapshot({ ...snapshot, signals: [calendar, altered] }), /Treasury/);
  };
  assertRejected((s) => {
    s.scores.daily = 0.1;
  });
  assertRejected((s) => {
    s.source.releasedAt = issuedAt;
  });
  assertRejected((s) => {
    s.treasuryAuction!.expiresAt = "2026-11-30T14:30:00.000Z";
  });
  assertRejected((s) => {
    s.treasuryAuction!.results[1].auctionDate = "2026-08-01";
  });
  assertRejected((s) => {
    s.treasuryAuction!.results[2].resultUrl = s.source.url;
  });
  assertRejected((s) => {
    s.metrics[0].value = 6.9;
  });
  assertRejected((s) => {
    s.treasuryAuction!.catalogue.sha256 = "1".repeat(64);
  });
  assert.throws(() => validateSnapshot({ ...snapshot, signals: [signal] }), /calendar/);
  assert.throws(
    () =>
      validateSnapshot({ ...snapshot, signals: [{ ...calendar, treasuryAuction: signal.treasuryAuction }] }),
    /identity/,
  );
  for (const changed of [
    [{ ...recent[0], medianYield: "4.334" }, ...recent.slice(1)],
    [...recent, { ...recent[0], cusip: "912000009" }],
  ]) {
    rows = changed;
    const latest = await collectMarketCalendarsWithAuction(read, transport, root);
    const missing = latest.signals.find((s) => s.id === TREASURY_AWARD_ID)!;
    assert.equal(missing.status, "unavailable");
    assert.deepEqual(missing.metrics, []);
    assert.equal(missing.treasuryAuction, undefined);
    assert.equal(latest.signals.find((s) => s.id === "treasury-calendar")?.status, "available");
    assert.equal(resultRequests, 5);
  }
});

async function publish(root: string, signal: Signal) {
  const snapshot: Snapshot = {
    schemaVersion: 1,
    origin: "prospective",
    id: edition,
    issuedAt,
    cutoff: issuedAt,
    engineVersion: "consensus-rules-2.0.0",
    signals: [signal],
    catalysts: [],
    sourcesAttempted: 1,
    collectionErrors: [],
  };
  const dir = join(root, "public/consensus"),
    bytes = Buffer.from(JSON.stringify(snapshot));
  const index = Buffer.from(
    JSON.stringify([
      { id: edition, issuedAt, engineVersion: snapshot.engineVersion, sha256: digest(snapshot) },
    ]),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, edition + ".json"), bytes);
  await writeFile(join(dir, "index.json"), index);
  await writeFile(join(dir, "outcomes.json"), "[]");
  await recordPreopenReceipt(root, target, edition, bytes, index, target + "T13:02:00.000Z");
}

test("normal collector and public morning witness enroll only the decided TLT event; first eligible settlement consumes one label", async (t) => {
  const { root } = await workspace(t);
  assert.equal(publisherSecondaryStudies.find((s) => s.name === "events")?.study, auctionDispersionStudy);
  await auctionDispersionStudy.register(root);
  set(t, receiptAt);
  let resultCalls = 0,
    xmlCalls = 0;
  const read = async (url: string) => {
    if (url === TREASURY_AUCTIONED) resultCalls++;
    else if (url !== TREASURY_ANNOUNCED) throw Error("Outside this fixture");
    return document(catalogue());
  };
  const transport = async (url: string) => {
    xmlCalls++;
    const doc = await documents(url);
    return new Response(doc.text, { headers: { "last-modified": doc.lastModified! } });
  };
  await collectMarketCalendarsWithAuction(read, transport, root);
  set(t, target + "T12:48:00.000Z");
  const feed = await collectMarketCalendarsWithAuction(read, transport, root);
  assert.equal(xmlCalls, 4);
  assert.equal(resultCalls, 1);
  const signal = feed.signals.find((s) => s.id === "treasury-calendar")!;
  assert.equal(signal.status, "available");
  assert.deepEqual(signal.scores, { daily: null, weekly: null, monthly: null });
  set(t, target + "T13:03:00.000Z");
  await publish(root, signal);
  assert.equal((await auctionDispersionStudy.enroll(root, target, edition)).enrolled, 1);
  const eventRoot = join(root, dirname(auctionDispersionStudy.registrationPath), "TLT");
  const evt = JSON.parse(await readFile(join(eventRoot, "events", edition + ".json"), "utf8")).value;
  assert.deepEqual(
    [evt.id, evt.candidate, evt.control, evt.prediction],
    ["treasury-awards:2026-11-24:912000001", -1.5, 0.05, null],
  );
  set(t, target + "T21:05:00.000Z");
  const tx = "bbbbbbbb-1111-4222-8333-444444444444",
    clock = exchangeSession(target)!;
  await durableJSON(
    join(root, ".consensus/evaluation-transaction.json"),
    { schemaVersion: 1, id: tx, synthetic: true },
    true,
  );
  let opened = 0;
  const row = {
    snapshotId: edition,
    instrument: "TLT" as const,
    horizon: "daily" as const,
    issuedAt,
    entryAt: clock.openAt,
    exitAt: clock.closeAt,
    source: MARKET_HISTORY_SOURCE,
    adjustment: OUTCOME_PRICE_BASIS,
    calendarVersion: exchangeCalendarVersion(target, target),
    direction: () => {
      opened++;
      return 1 as const;
    },
  };
  const issues = [{ id: edition, issuedAt }];
  await auctionDispersionStudy.stage(
    root,
    tx,
    [
      { ...row, instrument: "IWM" },
      { ...row, source: "guest" },
      { ...row, horizon: "monthly" },
    ],
    issues,
    [],
  );
  await auctionDispersionStudy.stage(
    root,
    tx,
    [row],
    [...issues, { id: "later", issuedAt: target + "T14:00:00.000Z" }],
    [],
  );
  await auctionDispersionStudy.stage(root, tx, [row], issues, [
    { instrument: "TLT", reservedAt: target + "T13:01:00.000Z", consumedThrough: issuedAt, testWindows: [] },
  ]);
  assert.equal(opened, 0);
  await auctionDispersionStudy.stage(root, tx, [row], issues, []);
  await auctionDispersionStudy.stage(root, tx, [row], issues, []);
  assert.equal(opened, 1);
  assert.equal(
    JSON.parse(await readFile(join(eventRoot, "admissions", edition + ".json"), "utf8")).value.source,
    MARKET_HISTORY_SOURCE,
  );
});
