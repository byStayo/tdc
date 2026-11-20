import assert from "node:assert/strict";
import test from "node:test";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { kibotIssuerCollectionStart, reviewIssuerBoundaries, scorePriceSensitivity } from "../lib/consensus/kibot-issuer-review.ts";
import { ETF_SYMBOLS, type MarketParquetDay } from "../lib/consensus/marketparquet.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const now = "2026-12-05T23:00:00.000Z";
const source = "https://example.com/kibot-fixture";
const cash = { SPY: [], QQQ: [], IWM: [], DIA: [], TLT: [] };

function rawPrices(dates: string[]): PriceEvidence[] {
  return ETF_SYMBOLS.map(instrument => ({ instrument, source, adjustment: "unadjusted", expectedSessions: dates,
    sessions: dates.map(session => ({ ...exchangeSession(session)!, open: 100, close: 100 })) }));
}

function filesFor(raw: PriceEvidence[]): MarketParquetDay[] {
  return raw[0].expectedSessions.map((session, i) => ({ session, sha256: "c".repeat(64),
    bars: Object.fromEntries(raw.map(({ instrument, sessions }) =>
      [instrument, { open: sessions[i].open, close: sessions[i].close }])) as MarketParquetDay["bars"] }));
}

function edition(day: string, time = "12:00"): Snapshot {
  const issuedAt = `${day}T${time}:00.000Z`;
  return { schemaVersion: 1, id: issuedAt, issuedAt, cutoff: issuedAt, engineVersion: "consensus-rules-2.0.0",
    origin: "prospective", signals: [], catalysts: [], sourcesAttempted: 0, collectionErrors: [] };
}

test("Kibot collection starts at the previous trading session of the earliest latest issuer action", () => {
  const actions = { SPY: [{ session: "2026-09-18", amount: 1 }], QQQ: [{ session: "2026-09-21", amount: 1 }],
    IWM: [{ session: "2026-06-15", amount: 1 }, { session: "2026-09-15", amount: 1 }],
    DIA: [{ session: "2026-10-16", amount: 1 }], TLT: [{ session: "2026-11-02", amount: 1 }] };
  assert.equal(kibotIssuerCollectionStart(actions, "2026-11-16"), "2026-09-14");
  assert.equal(kibotIssuerCollectionStart({ ...actions, IWM: [{ session: "2026-09-14", amount: 1 }] }, "2026-11-16"), "2026-09-11");
});

test("issuer review detects missing TLT cash even when both endpoint rows have a common rescaling", () => {
  const dates = exchangeSessions("2026-10-30", "2026-11-02");
  const raw = rawPrices(dates);
  const advertised = raw.map(series => ({ ...series, adjustment: OUTCOME_PRICE_BASIS,
    sessions: series.sessions.map((row, i) => {
      const factor = series.instrument === "TLT" || i === 1 ? 0.8 : 0.792;
      return { ...row, open: row.open * factor, close: row.close * factor };
    }) }));
  const distributions = { ...cash, SPY: [{ session: "2026-11-02", amount: 1 }], TLT: [{ session: "2026-11-02", amount: 0.343177 }] };
  const boundaries = reviewIssuerBoundaries(raw, advertised, distributions);
  const tlt = boundaries.find(row => row.symbol === "TLT")!;
  assert.equal(tlt.status, "missing");
  assert.equal(tlt.issuerAmount, 0.343177);
  assert.equal(tlt.observed.closeFactor, 1);
  assert.ok(Math.abs(tlt.expectedFactor - 0.99656823) < 1e-12);
  assert.ok(Math.abs(tlt.observed.closeErrorBps - 34.3177) < 1e-9);
  assert.equal(boundaries.find(row => row.symbol === "SPY")!.status, "matches-issuer");
});

test("sample sensitivity keeps the scheduled entry and never bridges an unmatched day", () => {
  const raw = rawPrices(exchangeSessions("2026-11-03", "2026-11-16"));
  const files = filesFor(raw).slice(1);
  files[1].bars.QQQ.close = 100.30; // November 5 fails the independent match.
  const snapshots = [edition("2026-11-03", "23:00"), edition("2026-11-05"), edition("2026-11-06"), edition("2026-11-06", "13:00")];
  const result = scorePriceSensitivity({ snapshots, files, cash, raw, sameRunSessions: ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"], now });
  assert.equal(result.expectedSessions[0], "2026-11-03");
  assert.equal(result.matchedSessions.length, 8);
  assert.equal(result.matchedSessions.some(row => row.session === "2026-11-05"), false);
  assert.equal(result.cohorts.daily.selected, 10);
  assert.equal(result.cohorts.daily.byCapture.cached.selected, 10);
  assert.equal(result.cohorts.weekly.selected, 5);
  assert.equal(result.cohorts.weekly.byCapture.mixed.selected, 5);
  assert.equal(result.cohorts.monthly.selected, 0);
});

test("sample sensitivity excludes shortened sessions even when both raw sources match", () => {
  const raw = rawPrices(exchangeSessions("2026-11-23", "2026-12-04"));
  const snapshots = [edition("2026-11-23"), edition("2026-11-27")];
  const files = filesFor(raw);
  const result = scorePriceSensitivity({ snapshots, files, cash, raw, sameRunSessions: files.map(row => row.session), now });
  assert.equal(result.expectedSessions.includes("2026-11-27"), true);
  assert.equal(result.matchedSessions.some(row => row.session === "2026-11-27"), false);
  assert.equal(result.cohorts.daily.selected, 5);
  assert.equal(result.cohorts.weekly.selected, 0);
});

test("sample sensitivity compares weekly labels after issuer cash is applied to both sources", () => {
  const raw = rawPrices(exchangeSessions("2026-11-04", "2026-11-10"));
  raw.find(series => series.instrument === "TLT")!.sessions.at(-1)!.close = 99.01;
  const files = filesFor(raw);
  files[0].bars.TLT.open = 100.02;
  const distributions = { ...cash, TLT: [{ session: "2026-11-09", amount: 1 }] };
  const { cohorts } = scorePriceSensitivity({
    snapshots: [edition("2026-11-04")], files, cash: distributions, raw,
    sameRunSessions: files.map(row => row.session), now,
  });
  // Guest entry is 99 and sample entry is 99.0198 after the same distribution.
  // The common exit of 99.01 falls between them.
  assert.equal(cohorts.weekly.selected, 5);
  assert.equal(cohorts.weekly.labelDisagreements, 1);
  assert.ok(Math.abs(cohorts.weekly.maxAbsReturnErrorBps! - 1.9998) < 0.001);
});
