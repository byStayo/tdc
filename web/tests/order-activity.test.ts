import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { freezeConsensus } from "../lib/consensus/as-issued.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";

const tickers = ["SPY", "QQQ", "IWM", "DIA", "TLT"];
const secPage = "https://www.sec.gov/data-research/sec-markets-data/marketstructuredata-security";
const secFile = "/files/opa/data/market-structure/metrics-individual-security/individual_security_2026_q2.zip";
const retail = (ticker: string, vintage: string, wrongTicker = false) => JSON.stringify({
  url: `https://etfiq.com/funds/${ticker.toLowerCase()}/trading/`,
  section: "funds",
  as_of: vintage === "2026-11-16" ? "Nov 16, 2026" : "Nov 17, 2026",
  publisher: { name: "ETFIQ", url: "https://etfiq.com" },
  license: "https://etfiq.com/license/",
  truncated: false,
  structured_data: [{ "@type": "Dataset", name: `${ticker} trading costs and liquidity`,
    url: `https://etfiq.com/funds/${ticker.toLowerCase()}/trading/`, dateModified: vintage }],
  content: `Issuer close $777.33.\n ${wrongTicker ? "OTHER" : ticker} ranked 2nd of 4,083 ETFs by retail order activity in Sep 2026, an ETFIQ estimate. It drew 4.21% of the market-order dollars in 4 retail brokers’ reports. Retail activity ranking \n`,
});

function archive(duplicate = false) {
  const header = "Date,Security,Ticker,LitVol('000),OrderVol('000),Cancels,LitTrades,HiddenVol('000),TradeVolForHidden('000),OddLotVol('000),TradeVolForOddLots('000)";
  const rows = tickers.flatMap(symbol => [
    `20260629,ETF,${symbol},15,1000,360,12,18,600,30,750`,
    `20260630,ETF,${symbol},20,1000,480,12,30,600,60,750`,
  ]);
  if (duplicate) rows.push(rows[0]);
  return execFileSync("python3", ["-c", `
from zipfile import ZipFile
from io import BytesIO
import sys
buffer = BytesIO()
with ZipFile(buffer, 'w') as archive:
    archive.writestr('q2_2026_all.csv', sys.stdin.read())
    archive.writestr('README.txt', 'Synthetic fixture using the SEC MIDAS quarterly column names.')
sys.stdout.buffer.write(buffer.getvalue())
`], { input: [header, ...rows].join("\n") });
}

function sources({ vintage = "2026-11-16", etfiqUnavailable = false, badArchive = false, reuse = false } = {}) {
  return async (url: string, init?: RequestInit) => {
    if (url === secPage) return new Response(`<a href="${secFile}" download>2026 Q2</a>`);
    if (url === `https://www.sec.gov${secFile}`) {
      if (reuse) {
        assert.ok(new Headers(init?.headers).get("If-Modified-Since"));
        return new Response(null, { status: 304 });
      }
      return new Response(new Uint8Array(archive(badArchive)), { headers: { "Last-Modified": "Thu, 06 Aug 2026 18:10:19 GMT" } });
    }
    const ticker = /^https:\/\/etfiq\.com\/funds\/([a-z]+)\/trading\/index\.json$/.exec(url)?.[1]?.toUpperCase();
    if (ticker) return new Response(retail(ticker, vintage, etfiqUnavailable && ticker === "QQQ"));
    return new Response(null, { status: 503 });
  };
}

test("the daily collector saves five dated SEC and ETFIQ observations without giving either a vote", async () => {
  const snapshot = freezeConsensus(await collectSnapshot(sources()));
  const midas = snapshot.signals.filter(s => s.id.startsWith("sec-midas-"));
  const broker = snapshot.signals.filter(s => s.id.startsWith("etfiq-retail-"));
  assert.equal(midas.length, 5);
  assert.equal(broker.length, 5);
  assert.deepEqual(midas[0].series, [{ date: "2026-06-29", value: 1.5 }, { date: "2026-06-30", value: 2 }]);
  assert.deepEqual(midas[0].metrics.map(metric => metric.value), [2, 40, 5, 8]);
  assert.equal(midas[0].source.vintageAt, "2026-08-06T18:10:19.000Z");
  assert.deepEqual(broker[0].series, [{ date: "2026-09-30", value: 4.21 }]);
  assert.equal(broker[0].source.vintageAt, "2026-11-16");
  assert.equal(broker[0].source.releasedAt, null);
  assert.ok(!JSON.stringify(broker).includes("777.33"));
  assert.ok([...midas, ...broker].every(signal => signal.instruments.length === 1 &&
    signal.directionalInstruments?.length === 0 && Object.values(signal.scores).every(score => score === null)));
  validateSnapshot(snapshot);
  broker[0].scores.daily = 0.5;
  assert.throws(() => validateSnapshot(snapshot), /order activity/i);
});

test("a nightly page rebuild and a conditional MIDAS check keep the observation digest stable", async () => {
  const first = await collectSnapshot(sources());
  const second = await collectSnapshot(sources({ vintage: "2026-11-17", reuse: true }), first);
  const sec = (snapshot: typeof first) => snapshot.signals.find(s => s.id === "sec-midas-SPY");
  assert.ok(sec(first));
  assert.deepEqual(sec(second), sec(first));
  assert.equal(observationDigest(second), observationDigest(first));
});

test("a duplicate SEC row and a mismatched ETFIQ symbol fail closed independently", async () => {
  const snapshot = await collectSnapshot(sources({ etfiqUnavailable: true, badArchive: true }));
  const find = (id: string) => snapshot.signals.find(signal => signal.id === id);
  assert.equal(find("sec-midas-SPY")?.status, "unavailable");
  assert.equal(find("sec-midas-SPY")?.series.length, 0);
  assert.equal(find("etfiq-retail-QQQ")?.status, "unavailable");
  assert.equal(find("etfiq-retail-SPY")?.series[0].value, 4.21);
});
