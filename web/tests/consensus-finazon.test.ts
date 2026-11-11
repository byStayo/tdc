import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFinazonSeries } from "../lib/consensus/finazon.ts";
import { checkTiingoSeries } from "../lib/consensus/tiingo.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";

const sessions = ["2026-10-30", "2026-11-02"].map((day) => exchangeSession(day)!);
const raw = sessions.map((row, i) => ({ t: Date.parse(row.openAt) / 1_000, o: 90 + i, c: 92 + i }));
const reference = {
  timestampBasis: "session-open" as const,
  sessions: sessions.map((row, i) => ({ ...row, open: raw[i].o, close: raw[i].c })),
  distributions: [{ session: "2026-11-02", amount: 0.343177 }],
  splits: [],
};
const factor = (92 - 0.343177) / 92;
const adjusted = [
  { ...raw[0], o: raw[0].o * factor * 0.8, c: raw[0].c * factor * 0.8 },
  { ...raw[1], o: raw[1].o * 0.8, c: raw[1].c * 0.8 },
];
const tiingo = sessions.map((row, i) => ({
  date: row.session + "T00:00:00.000Z", open: raw[i].o, close: raw[i].c,
  adjOpen: adjusted[i].o, adjClose: adjusted[i].c, divCash: i ? 0.343177 : 0, splitFactor: 1,
}));

test("reconciles Tiingo daily prints and issuer actions independently", () => {
  assert.deepEqual(checkTiingoSeries([...tiingo].reverse(), reference), { sessions: 2, cashDistributions: 1, splits: 0 });
  assert.throws(() => checkTiingoSeries([tiingo[0], { ...tiingo[1], date: sessions[1].openAt }], reference), /date/);
  assert.throws(() => checkTiingoSeries([tiingo[0], { ...tiingo[1], divCash: 0 }], reference), /cash distribution/);
  assert.throws(() => checkTiingoSeries([tiingo[0], { ...tiingo[1], splitFactor: 2 }], reference), /split/);
  assert.throws(() => checkTiingoSeries([{ ...tiingo[0], adjOpen: tiingo[0].open }, tiingo[1]], reference), /open adjustment/);
});

test("matches independent open and close prints and their issuer adjustment on a common scale", () => {
  assert.deepEqual(checkFinazonSeries({ data: raw }, { data: adjusted }, reference), {
    sessions: 2, cashDistributions: 1, splits: 0,
  });
});
test("rejects a missing session, wrong timestamp, misselected open or omitted dividend", () => {
  assert.throws(() => checkFinazonSeries({ data: raw.slice(1) }, { data: adjusted }, reference), /session coverage/);
  assert.throws(() => checkFinazonSeries({ data: [{ ...raw[0], t: raw[0].t - 60 }, raw[1]] }, { data: adjusted }, reference), /timestamp/);
  assert.throws(() => checkFinazonSeries({ data: [{ ...raw[0], o: raw[0].o + 0.01 }, raw[1]] }, { data: adjusted }, reference), /open price/);
  assert.throws(() => checkFinazonSeries({ data: [raw[0], { ...raw[1], c: raw[1].c - 0.01 }] }, { data: adjusted }, reference), /close price/);
  assert.throws(() => checkFinazonSeries({ data: raw }, { data: raw }, reference), /adjustment/);
});

test("verifies vendor samples before purchase without an API key and rejects missing or exposed data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tdc-finazon-sample-"));
  try {
    const referencesPath = join(directory, "reference.json"), samplesPath = join(directory, "samples.json");
    const symbols = ["SPY", "QQQ", "IWM", "DIA", "TLT"];
    const references = Object.fromEntries(symbols.map(symbol => [symbol, reference]));
    const samples = Object.fromEntries(symbols.map(symbol => [symbol, { raw: { data: raw }, adjusted: { data: adjusted } }]));
    const script = new URL("../scripts/research-finazon-prices.ts", import.meta.url).pathname;
    const run = (mode = "--samples") => spawnSync(process.execPath, ["--experimental-strip-types", script, mode, samplesPath, referencesPath], {
      env: { ...process.env, FINAZON_API_KEY: "" }, encoding: "utf8",
    });
    await writeFile(referencesPath, JSON.stringify(references), { mode: 0o600 });
    await writeFile(samplesPath, JSON.stringify(samples), { mode: 0o600 });
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    const result = JSON.parse(success.stdout);
    assert.equal(result.input, "supplied-samples");
    assert.deepEqual(result.checks.map((check: { symbol: string }) => check.symbol), symbols);
    assert.equal(result.published, false);
    delete samples.TLT;
    await writeFile(samplesPath, JSON.stringify(samples));
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing supplied samples for TLT/);
    assert.equal(missing.stdout, "");
    await writeFile(samplesPath, JSON.stringify(Object.fromEntries(symbols.map(symbol => [symbol, tiingo]))));
    const tiingoRun = run("--tiingo-samples");
    assert.equal(tiingoRun.status, 0, tiingoRun.stderr);
    const tiingoResult = JSON.parse(tiingoRun.stdout);
    assert.equal(tiingoResult.provider, "tiingo");
    assert.deepEqual(tiingoResult.checks.map((check: { symbol: string }) => check.symbol), symbols);
    assert.equal(tiingoResult.published, false);
    await chmod(samplesPath, 0o644);
    assert.match(run().stderr, /owner-only regular/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
