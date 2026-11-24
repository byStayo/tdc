import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Consensus, FamilyReading, HistoryEntry, Snapshot } from "../lib/consensus/types.ts";
import { RANGE_ATTRIBUTION, RANGE_POLICY, RANGE_POLICY_V2, RANGE_SOURCE } from "../lib/consensus/regular-session-range.ts";
import { renderConnectionChart } from "../scripts/render-connection-chart.ts";

type ConnectionView = Omit<Consensus, "families"> & {
  families: (FamilyReading & { contributors: { signal: string; score: number }[] })[];
};
function report(edition: string): {
  views: ConnectionView[];
  signals: { id: string; providerLabel: string | null; status: string }[];
  byStatus: Record<string, number>;
} {
  const script = fileURLToPath(new URL("../scripts/report-connections.ts", import.meta.url));
  return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", script, edition, "--json"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
}

test("traces neutral and scope-limited votes to the saved sources", () => {
  const result = report("2026-11-24T03-23-41-372Z");
  assert.equal(result.views.length, 18);
  assert.deepEqual(result.byStatus, { available: 104, stale: 12, unavailable: 16, not_formed: 0 });
  const tlt = result.views.find(view => view.instrument === "TLT" && view.horizon === "daily")!;
  assert.deepEqual(tlt.families.filter(family => family.score !== null).map(family => family.id), ["rates"]);
  const options = tlt.families.find(family => family.id === "options")!;
  assert.ok(options.available > 0);
  assert.deepEqual(options.contributors, []);
  const rates = tlt.families.find(family => family.id === "rates")!.contributors;
  assert.ok(rates.some(source => source.signal === "fred-DGS10" && source.score === 0));
  assert.ok(!rates.some(source => source.signal === "fred-DGS2"));
  assert.equal(result.signals.find(signal => signal.id === "off-exchange")!.providerLabel, null);
});

test("uses the archived engine on an issue that predates frozen forecast views", () => {
  const result = report("2026-11-03T06-28-30-460Z");
  assert.equal(result.signals.length, 52);
  const market = result.views.find(view => view.instrument === "MARKET" && view.horizon === "daily")!;
  assert.equal(market.directionalCoverage, undefined);
  const input = market.families.find(family => family.id === "rates")!.contributors.find(source => source.signal === "fred-DGS2");
  assert.ok(input && Math.abs(input.score - 0.25) < 1e-12);
});

test("the offline chart keeps original values, source clocks and the archived horizon scope", () => {
  const edition = { id: "2026-11-24T05-42-23-689Z", issuedAt: "2026-11-24T05:42:23.689Z",
    engineVersion: "fixture", sha256: "a".repeat(64) } satisfies HistoryEntry;
  const signal = { id: "one", title: "Supply <checked>", summary: "Bonds & funds", instruments: ["MARKET"], unit: "%",
    source: { url: "https://example.org/series", observedAt: "2026-11-20", releasedAt: "2026-11-23" },
    limitation: "", metrics: [{ label: "Rate", value: 4.25, unit: "%", date: "2026-11-20" }],
    series: [{ date: "2026-11-19", value: 4.1 }] };
  const snapshot = { cutoff: edition.issuedAt, signals: [signal] } as Snapshot;
  const view = { instrument: "MARKET", horizon: "daily", label: "Monitoring", coverage: 1, reasons: [],
    neutral: 1, score: 0, bearish: 0, bullish: 0, agreement: null, abstain: true,
    families: [{ id: "rates", label: "Rates", expected: 1, available: 1, score: 0, weight: 1, status: "available",
      contributors: [{ signal: "one", score: 0 }] }] } satisfies ConnectionView;
  const html = renderConnectionChart(edition, snapshot, [{ id: "one", status: "available", providerLabel: "Example" }],
    [{ label: "Example", signals: ["one"] }], [view]);
  assert.match(html, /1 of 1 families vote/);
  assert.match(html, /Supply &lt;checked&gt;/);
  assert.match(html, /Bonds &amp; funds/);
  assert.match(html, /href="#signal-one"/);
  assert.match(html, /Observed 2026-11-20 · Released 2026-11-23/);
  assert.match(html, /2026-11-19   4.1/);
  assert.match(html, /4.25 %/);
  assert.doesNotMatch(html, /directional coverage|<script\b|<checked>/i);
  snapshot.regularSessionRanges = { method: RANGE_POLICY, url: RANGE_SOURCE,
    attribution: RANGE_ATTRIBUTION, rows: [{ fund: "TLT", session: "2026-11-20", closeFifth: 4,
      observedAt: "2026-11-20T21:00:00.000Z", verifiedAt: edition.issuedAt, receiptSha256: "b".repeat(64) }] };
  const withRange = renderConnectionChart(edition, snapshot, [{ id: "one", status: "available", providerLabel: "Example" }], [], [view]);
  assert.match(withRange, /TLT<\/strong> · Fourth fifth on 2026-11-20/);
  assert.match(withRange, /1 of 1 families vote/);
  assert.doesNotMatch(html, /Where each fund closed/);
  const tlt = snapshot.regularSessionRanges.rows[0];
  snapshot.regularSessionRanges = { method: RANGE_POLICY_V2, rows: [
    { ...tlt, fund: "SPY", source: "firstrate", session: "2026-11-23", observedAt: "2026-11-23T21:00:00.000Z" },
    { ...tlt, source: "market-history" },
  ] };
  const mixed = renderConnectionChart(edition, snapshot, [{ id: "one", status: "available", providerLabel: "Example" }], [], [view]);
  assert.match(mixed, /SPY<\/strong> · Fourth fifth on 2026-11-23[^<]*(?:<time[^>]*>[^<]*<\/time>) · <a href="https:\/\/firstratedata.com\/i\/etf\/SPY"[^>]*>FirstRate Data/);
  assert.match(mixed, /TLT<\/strong> · Fourth fifth on 2026-11-20[^<]*(?:<time[^>]*>[^<]*<\/time>) · <a href="https:\/\/getmarkethistory.com[^"]+"[^>]*>Market History/);
  assert.match(mixed, /1 of 1 families vote/);
});
