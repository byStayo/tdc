import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectBlsPayrollNews,
  selectPayrollReleases,
  validateBlsPayrollNews,
} from "../lib/consensus/bls-payroll-news.ts";

const at = "2026-11-24T05:30:00.000Z";
const before = "2026-11-06T13:29:59.000Z";
const current = "https://www.bls.gov/news.release/archives/empsit_11062026.htm";
const previous = "https://www.bls.gov/news.release/archives/empsit_10022026.htm";
const index = (extra = "") =>
  '<a href="' +
  new URL(current).pathname +
  '">October 2026 Employment Situation</a>' +
  extra +
  '<a href="' +
  new URL(previous).pathname +
  '">September 2026 Employment Situation</a>';
const news = (clock: string, period: string, headline: string, revisions: string) =>
  "<html><pre>Transmission of material in this news release is embargoed until USDL-26-0000 8:30 a.m. " +
  clock +
  " Technical information. THE EMPLOYMENT SITUATION -- " +
  period +
  " " +
  headline +
  " " +
  revisions +
  "</pre><pre>unrelated table</pre></html>";
const latest = news(
  "(ET) Friday, November 6, 2026",
  "OCTOBER 2026",
  "Total nonfarm payroll employment rose by 165,000 in October.",
  "The change in total nonfarm payroll employment for August was revised up by 53,000, from +133,000 to +186,000, and the change for September was revised up by 31,000, from +29,000 to +60,000. With these revisions, employment in August and September combined is 84,000 higher than previously reported.",
);
const prior = news(
  "(EDT) Friday, October 2, 2026",
  "SEPTEMBER 2026",
  "Both total nonfarm payroll employment (+29,000) and the unemployment rate changed little.",
  "The change in total nonfarm payroll employment for July was revised down from +21,000 to -10,000, and the change for August was revised down from +162,000 to +133,000. With these revisions, employment in July and August combined is 60,000 lower than previously reported.",
);
function source(body = latest, old = prior, links = index()) {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (url: string) => {
      calls.push(url);
      if (url.endsWith("/bls/news-release/empsit.htm")) return new Response(links);
      if (url === current) return new Response(body);
      if (url === previous) return new Response(old);
      throw Error("private test token");
    },
  };
}

test("reconciles two original BLS vintages and preserves the actual availability clock", async () => {
  const fixture = source();
  const signal = await collectBlsPayrollNews(fixture.fetcher, () => at);
  assert.equal(signal.status, "available", signal.collectionNote);
  assert.deepEqual(fixture.calls.length, 3);
  assert.deepEqual(signal.instruments, ["MARKET", "TLT"]);
  assert.equal(signal.family, "news");
  assert.deepEqual(signal.directionalInstruments, []);
  assert.deepEqual(signal.scores, { daily: null, weekly: null, monthly: null });
  assert.equal(signal.source.observedAt, "2026-10-31");
  assert.equal(signal.source.releasedAt, "2026-11-06T13:30:00.000Z");
  assert.equal(signal.blsPayrollNews?.previous.releasedAt, "2026-10-02T12:30:00.000Z");
  assert.equal(signal.blsPayrollNews?.firstVerifiedAt, at);
  assert.deepEqual(signal.series, [{ value: 84000, date: "2026-10-31" }]);
  assert.deepEqual(
    signal.metrics.map((m) => m.value),
    [165000, 53000, 31000],
  );
  validateBlsPayrollNews(signal, at);
  assert.throws(() => validateBlsPayrollNews({ ...signal, id: "bls-upcoming-calendar" }), /another signal/);
  assert.throws(() => validateBlsPayrollNews({ ...signal, scores: { ...signal.scores, daily: 0 } }), /scope/);
  assert.throws(() => validateBlsPayrollNews({ ...signal, metrics: signal.metrics.slice(1) }), /display/);
  assert.throws(() => validateBlsPayrollNews(signal, "2026-11-20T14:00:00.000Z"), /cutoff/);
});

test("rejects an edited original, conflicting retained month, bad release clock and arithmetic changes", async () => {
  for (const [body, old] of [
    [latest.replace("embargoed until", "reissued and embargoed until"), prior],
    [latest.replace("<html>", "<html><p>This news release has been corrected.</p>"), prior],
    [latest.replace("Friday", "Thursday"), prior],
    [latest.replace("84,000 higher", "83,000 higher"), prior],
    [latest.replace("for August", "for October"), prior],
    [latest.replace("29,000 to +60,000", "30,000 to +61,000"), prior],
    [latest, prior.replace("(+29,000)", "(+20,000)")],
    [latest, prior.replace("133,000", "134,000").replace("60,000 lower", "59,000 lower")],
  ]) {
    const signal = await collectBlsPayrollNews(source(body, old).fetcher, () => at);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.failureKind, "validation");
    assert.deepEqual(signal.series, []);
    validateBlsPayrollNews(signal, at);
  }
});

test("selects only published links and rejects ambiguous current releases", () => {
  const august = '<a href="/news.release/archives/empsit_09042026.htm">August 2026 Employment Situation</a>';
  const octoberDup = '<a href="/news.release/archives/empsit_11122026.htm">October 2026 Employment Situation</a>';
  const result = selectPayrollReleases(index(august), before);
  assert.equal(result[0].period, "2026-09");
  assert.throws(() => selectPayrollReleases(index(octoberDup), at), /uniquely/);
  const cosmeticOldDup =
    august + '<a href="/news.release/archives/empsit_09052026.htm">August 2026 Employment Situation</a>';
  assert.equal(selectPayrollReleases(index(cosmeticOldDup), at)[0].url, current);
});

test("refetches both vintages, retains private native bytes and the first verified pair, and withholds a changed pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "consensus-bls-"));
  try {
    const first = await collectBlsPayrollNews(source().fetcher, () => at, directory);
    const later = "2026-11-24T06:00:00.000Z",
      fixture = source(latest + "<div>navigation changed</div>");
    const fresh = await collectBlsPayrollNews(fixture.fetcher, () => later, directory);
    assert.equal(fixture.calls.length, 3);
    assert.equal(fresh.blsPayrollNews?.firstVerifiedAt, at);
    assert.equal(fresh.source.retrievedAt, later);
    assert.equal(fresh.source.sha256, first.source.sha256);
    const mismatch = await collectBlsPayrollNews(
      source(latest.replace("165,000", "164,000")).fetcher,
      () => later,
      directory,
    );
    assert.equal(mismatch.status, "unavailable");
    const file = join(directory, "bls-payroll-2026-10.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    receipt.current.sha256 = "a".repeat(64);
    await writeFile(file, JSON.stringify(receipt));
    const bad = await collectBlsPayrollNews(source().fetcher, () => later, directory);
    assert.equal(bad.status, "unavailable");
    const transport = await collectBlsPayrollNews(
      async () => {
        throw Error("private test token");
      },
      () => at,
      directory,
    );
    assert.equal(transport.failureKind, "transport");
    assert.doesNotMatch(JSON.stringify(transport), /private test token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
