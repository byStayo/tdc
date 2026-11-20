import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectCtaReference, parseCtaReference } from "../lib/consensus/cta-reference.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";

const header = "Msg Cat/Type,TransTime,SeqNum,Symbol,instrumentType,partiId,prevClosePriceDate,lastClosePrice,highPrice,lowPrice,openPrice,totalVolume,shortSaleRestrictionInd,primaryListingMarketPartiId,financialStausInd,numberOfParticipants";
const symbols = ["IWM", "DIA", "SPY"];
const full = exchangeSession("2026-11-17")!;
const short = exchangeSession("2026-11-27")!;

function fixture(early = false): string {
  const description = early ? "Fri Nov 27 21:08:38 EDT 2026 prod" : "Tue Nov 17 22:03:29 EDT 2026 prod";
  const preliminary = early ? "13:15:00.92" : "16:15:00.99";
  const final = early ? "17:04:00.9" : "20:00:20.12";
  const consolidated = early ? "ConsolidatedEODSummary" : "FractionalConsolidatedEODSummary";
  const participant = early ? "ParticipantEODSummary" : "FractionalParticipantEODSummary";
  const rows = [description, header];
  for (const symbol of symbols) {
    rows.push(
      `${consolidated},_${preliminary},_21,${symbol},Equity,ARCA,_,105.01,110,90,,500000, ,ARCA,0,16,`,
      `${participant},_${preliminary},_22,${symbol},Equity,ARCA,_,105.01,110,90,99.95,240000,,,,,+`,
      `${consolidated},_${final},_23,${symbol},Equity,AMEX,_,103.07,110,90,,510000, ,ARCA,0,16,`,
      `${participant},_${final},_24,${symbol},Equity,ARCA,_,103.065000,110,90,99.99,244000,,,,,+`,
      `${participant},_${final},_25,${symbol},Equity,NASDAQ,_,102,110,90,102,244000,,,,,+`,
    );
  }
  return rows.join("\r\n") + "\r\n";
}

test("selects the final listing-participant open and last and preserves the source hash", () => {
  const bytes = Buffer.from(fixture());
  const result = parseCtaReference(bytes, full);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.scope, "private-price-reconciliation");
  assert.equal(result.basis, "as-traded-primary-listing-participant-eod-summary");
  assert.equal(result.source, "https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.20261117.csv");
  assert.deepEqual(result.rows.map(row => row.symbol), ["SPY", "IWM", "DIA"]);
  assert.deepEqual(result.rows[0], {
    ...full,
    symbol: "SPY",
    open: 99.99,
    close: 103.065,
    summaryAt: "2026-11-18T01:00:20.120Z",
  });
});

test("legacy CTS rows respect the independently scheduled early-close session", () => {
  const bytes = Buffer.from(fixture(true));
  const [row] = parseCtaReference(bytes, short).rows;
  assert.equal(row.openAt, "2026-11-27T14:30:00.000Z");
  assert.equal(row.closeAt, "2026-11-27T18:00:00.000Z");
  assert.equal(row.summaryAt, "2026-11-27T22:04:00.900Z");
  assert.throws(() => parseCtaReference(bytes, { ...short, closeAt: "2026-11-27T21:00:00.000Z" }), /reviewed exchange calendar/);
  assert.throws(() => parseCtaReference(bytes, full), /session date differs/);
});

test("fails closed on missing final rows, changed primary listings, and carried closes", () => {
  const source = fixture();
  const incomplete = source.split("\r\n").filter(line => !line.includes("_24,DIA,Equity,ARCA")).join("\r\n");
  assert.throws(() => parseCtaReference(Buffer.from(incomplete), full), /final ARCA summary for DIA/);
  assert.throws(() => parseCtaReference(Buffer.from(source.replace(",,510000, ,ARCA,", ",,510000, ,NASDAQ,")), full), /listing/);
  assert.throws(() => parseCtaReference(Buffer.from(source.replace("_24,IWM,Equity,ARCA,_", "_24,IWM,Equity,ARCA,20261116")), full), /current equity price/);
  const final = source.split("\r\n").find(line => line.includes("_24,IWM,Equity,ARCA"))!;
  assert.throws(() => parseCtaReference(Buffer.from(source + final.replace("103.065000", "103.07") + "\n"), full), /Conflicting/);
});

test("fetches one fixed archive or reads the previous verified bytes without networking", async () => {
  const bytes = Buffer.from(fixture());
  let calls = 0;
  const { reference, bytes: downloaded } = await collectCtaReference(full.session, {
    fetcher: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://ftp.nyse.com/cts_summary_files/CTA.Summary.EODSUM.20261117.csv");
      assert.equal(init?.redirect, "error");
      return new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } });
    },
  });
  const cached = await collectCtaReference(full.session, {
    cachedBytes: downloaded,
    fetcher: async () => { throw new Error("Unexpected network request"); },
  });
  assert.deepEqual(cached.reference, reference);
  assert.equal(calls, 1);
  await assert.rejects(collectCtaReference(full.session, {
    fetcher: async () => new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength + 9) } }),
  }), /archive is incomplete/);
});
