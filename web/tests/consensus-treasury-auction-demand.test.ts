import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  collectTreasuryAuctionDemand, collectTreasuryAuctionRelease, parseTreasuryAuctionDemand,
  treasuryAuctionDemandUrl, verifyTreasuryAuctionRelease,
} from "../lib/consensus/treasury-auction-demand.ts";

const from = "2022-01-01", through = "2025-12-31";
const catalogUrl = treasuryAuctionDemandUrl(from, through);
const retrievedAt = "2026-11-18T17:55:00.000Z";
const row = {
  record_date: "2025-12-31",
  cusip: "912810UQ9",
  security_type: "Bond",
  security_term: "19-Year 11-Month",
  original_security_term: "20-Year",
  auction_date: "2025-12-17",
  issue_date: "2025-12-31",
  closing_time_comp: "01:00 PM",
  reopening: "Yes",
  inflation_index_security: "No",
  bid_to_cover_ratio: "2.670000",
  comp_accepted: "12942131100",
  indirect_bidder_accepted: "8437250000",
  direct_bidder_accepted: "2878091100",
  primary_dealer_accepted: "1626790000",
  xml_filenm_comp_results: "R_20251217_2.xml",
};
const catalog = (data = [row], count = data.length) => JSON.stringify({
  data,
  meta: { count: data.length, "total-count": count, "total-pages": count === data.length ? 1 : 2 },
});
const source = { url: catalogUrl, retrievedAt };
const fixture = `<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="results.xsl"?>
<td:AuctionData xmlns:td="http://www.treasurydirect.gov/">
  <AuctionAnnouncement>
    <CUSIP>912810UQ9</CUSIP>
    <AuctionDate>2025-12-17</AuctionDate>
    <IssueDate>2025-12-31</IssueDate>
    <CompetitiveClosingTime>13:00</CompetitiveClosingTime>
  </AuctionAnnouncement>
  <AuctionResults>
    <PrimaryDealerAccepted>1626790000</PrimaryDealerAccepted>
    <IndirectBidderAccepted>8437250000</IndirectBidderAccepted>
    <DirectBidderAccepted>2878091100</DirectBidderAccepted>
    <CompetitiveAccepted>12942131100</CompetitiveAccepted>
    <BidToCoverRatio>2.67</BidToCoverRatio>
    <ReleaseTime>13:02</ReleaseTime>
  </AuctionResults>
</td:AuctionData>`;

test("Treasury legacy query retrieves a bounded nominal sample and retains original tenor on reopening", async () => {
  const [result] = await collectTreasuryAuctionDemand(from, through, async url => {
    const request = new URL(url);
    assert.equal(request.host, "api.fiscaldata.treasury.gov");
    assert.match(request.searchParams.get("filter")!, /original_security_term:in:\(10-Year,20-Year,30-Year\)/);
    assert.match(request.searchParams.get("filter")!, /inflation_index_security:eq:No/);
    return { body: catalog(), url, retrievedAt };
  });
  assert.equal(result.tenor, 20);
  assert.equal(result.securityTerm, "19-Year 11-Month");
  assert.equal(result.reopened, true);
  assert.equal(result.auctionDate, "2025-12-17");
  assert.equal(result.datasetRecordDate, "2025-12-31");
  assert.equal(result.competitiveCloseAt, "2025-12-17T18:00:00.000Z");
  assert.equal(result.indirectShare, 8_437_250_000 / 12_942_131_100);
  assert.equal(result.bidToCoverRatio, 2.67);
  assert.equal(result.source.sha256, createHash("sha256").update(catalog()).digest("hex"));
  assert.deepEqual(result.release, { status: "dated-only" });
  assert.throws(() => treasuryAuctionDemandUrl(from, "2026-01-02"), /2022–2025/);
});

test("Treasury catalog fails missing pages, duplicate results, TIPS and amounts inconsistent with the awards", () => {
  for (const [body, expected] of [
    [catalog([row], 2), /Incomplete/],
    [catalog([row, row]), /Duplicate/],
    [catalog([{ ...row, inflation_index_security: "Yes" }]), /nominal tenor scope/],
    [catalog([{ ...row, original_security_term: "19-Year" }]), /nominal tenor scope/],
    [catalog([{ ...row, comp_accepted: "12942131101" }]), /reconciliation/],
    [catalog([{ ...row, comp_accepted: "null" }]), /par amount/],
    [catalog([{ ...row, bid_to_cover_ratio: "0" }]), /bid-to-cover/],
    [catalog([{ ...row, xml_filenm_comp_results: "R_20251218_2.xml" }]), /filename/],
  ] as const) assert.throws(() => parseTreasuryAuctionDemand(body, from, through, source), expected);
});

test("the primary result validates competitive awards and records the release minute independently of rehosting", () => {
  const [auction] = parseTreasuryAuctionDemand(catalog(), from, through, source);
  const receipt = {
    body: fixture, url: auction.resultXmlUrl!, retrievedAt,
    lastModified: "Fri, 22 May 2026 15:11:47 GMT",
  };
  const verified = verifyTreasuryAuctionRelease(auction, receipt);
  assert.equal(verified.release.status, "timestamped");
  if (verified.release.status !== "timestamped") return;
  assert.equal(verified.release.availableAt, "2025-12-17T18:03:00.000Z");
  assert.equal(verified.release.basis, "xml-release-minute");
  assert.equal(verified.release.source.sha256, createHash("sha256").update(fixture).digest("hex"));
  assert.throws(() => verifyTreasuryAuctionRelease(auction, {
    ...receipt, body: fixture.replace("8437250000", "8437250200"),
  }), /disagrees/);
  assert.throws(() => verifyTreasuryAuctionRelease(auction, {
    ...receipt, body: fixture.replace("13:02", "12:59"),
  }), /before auction close/);
  assert.throws(() => verifyTreasuryAuctionRelease(auction, {
    ...receipt, retrievedAt: "2025-12-17T18:02:45.000Z",
  }), /predates/);
});

test("a result without internal timing remains dated only unless its official archive was updated on auction day", () => {
  const [auction] = parseTreasuryAuctionDemand(catalog(), from, through, source);
  const receipt = {
    body: fixture.replace("<ReleaseTime>13:02</ReleaseTime>", ""), url: auction.resultXmlUrl!, retrievedAt,
  };
  assert.equal(verifyTreasuryAuctionRelease(auction, {
    ...receipt, lastModified: "Fri, 22 May 2026 15:11:47 GMT",
  }).release.status, "dated-only");
  const verified = verifyTreasuryAuctionRelease(auction, {
    ...receipt, lastModified: "Wed, 17 Dec 2025 18:02:10 GMT",
  });
  assert.equal(verified.release.status, "timestamped");
  if (verified.release.status !== "timestamped") return;
  assert.equal(verified.release.availableAt, "2025-12-17T18:02:10.000Z");
  assert.equal(verified.release.basis, "result-last-modified");
});

test("a missing Treasury archive preserves dated-only evidence and transport failures remain visible", async () => {
  const [auction] = parseTreasuryAuctionDemand(catalog(), from, through, source);
  const withoutLink = { ...auction, resultXmlUrl: null };
  const mustNotFetch = async () => { assert.fail("An unsupported result URL must not be fetched"); };
  assert.equal(await collectTreasuryAuctionRelease(withoutLink, mustNotFetch), withoutLink);
  assert.equal(await collectTreasuryAuctionRelease(auction, async () => new Response(null, { status: 404 })), auction);
  await assert.rejects(collectTreasuryAuctionRelease(auction, async () => new Response(null, { status: 503 })), /HTTP 503/);
  await assert.rejects(collectTreasuryAuctionRelease({
    ...auction, resultXmlUrl: "https://example.com/xml/R_20251217_2.xml",
  }, mustNotFetch), /no supported result XML/);
});
