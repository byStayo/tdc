import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Consensus, FamilyReading } from "../lib/consensus/types.ts";

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
