import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { FIRST_RATE_SYMBOLS, prepareFirstRate } from "../lib/consensus/firstrate.ts";
import { writeHourlyFixtures } from "./fixtures/firstrate-hourly-controls.ts";
import { digest } from "../lib/consensus/history.ts";

test("a late old file advances its ETF without rolling back other ETFs or their newer issuer review", async () => {
  const root = await mkdtemp(join(tmpdir(), "daily-consensus-late-firstrate-"));
  try {
    const scripts = join(root, "scripts");
    const privateDir = join(root, ".consensus/private-firstrate");
    await mkdir(scripts);
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(scripts, "collect-firstrate-inputs.py"), [
      "import json, pathlib, sys",
      "with (pathlib.Path(__file__).parent/(sys.argv[1]+'.json')).open() as fixture: print(fixture.read())",
    ].join("\n"));
    const from = "2026-11-03";
    async function sample(day: string, available: readonly string[]) {
      const rows = exchangeSessions(from, day).map((session, i) => ({ ...exchangeSession(session)!, open: 100 + i, close: 101 + i }));
      const stamp = day + "T22:00:00.000Z";
      const samples = FIRST_RATE_SYMBOLS.filter(ticker => available.includes(ticker)).map(symbol => ({
        symbol, url: `https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_${symbol}.zip`,
        sha256: digest([symbol, day]), basis: "split-adjusted", capturedAt: stamp, modifiedAt: stamp,
        rows: rows.map(({ session, open, close }) => ({ session, open, close })), regularMinutes: [],
      }));
      const sampleFailures = FIRST_RATE_SYMBOLS.filter(ticker => !available.includes(ticker)).map(symbol => ({ symbol, reason: "file delayed" }));
      const issuers = samples.length ? [...FIRST_RATE_SYMBOLS, "TLT"].map(symbol =>
        ({ symbol, source: "https://example.test/issuer", sha256: digest([symbol, day]), capturedAt: stamp, cash: [] })) : [];
      await writeFile(join(scripts, day + ".json"), JSON.stringify({ samples, sampleFailures, issuers }));
      for (const symbol of FIRST_RATE_SYMBOLS.filter(fund => available.includes(fund))) await writeHourlyFixtures(root, symbol, rows);
    }
    const stored = async () => JSON.parse(await readFile(join(privateDir, "approved.json"), "utf8")).approval;
    await sample("2026-11-10", FIRST_RATE_SYMBOLS);
    await prepareFirstRate(root, false, "2026-11-11T13:00:00.000Z");
    await sample("2026-11-11", []);
    await sample("2026-11-12", ["SPY", "IWM", "DIA"]);
    await prepareFirstRate(root, false, "2026-11-12T22:05:00.000Z");
    const initial = await stored();
    await sample("2026-11-11", ["QQQ"]);
    await prepareFirstRate(root, false, "2026-11-12T23:05:00.000Z");
    const corrected = await stored();
    assert.equal(corrected.through, "2026-11-12");
    assert.deepEqual(corrected.issuers, initial.issuers);
    for (const symbol of FIRST_RATE_SYMBOLS) {
      const current = corrected.symbols.find((row: { symbol: string }) => row.symbol === symbol);
      const previous = initial.symbols.find((row: { symbol: string }) => row.symbol === symbol);
      if (symbol === "QQQ") {
        assert.equal(previous.reviewedThrough, "2026-11-10");
        assert.equal(current.reviewedThrough, "2026-11-11");
        assert.deepEqual(current.rows.slice(0, -1), previous.rows);
      } else assert.deepEqual(current, previous);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
