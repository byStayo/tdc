import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSchwabRetailFlows,
  parseSchwabRetailXml,
  validateSchwabRetailFlows,
} from "../lib/consensus/schwab-retail-flows.ts";

const at = "2026-11-24T04:00:00.000Z";
const period = "2026-10-31";
const first = "0001410368-26-111031",
  next = "0001410368-26-111034";
const series = "S000004508",
  contract = "C000012383";
const url = (a: string) => "https://www.sec.gov/Archives/edgar/data/857156/" + a.replaceAll("-", "") + "/";
const date = "2026-11-06",
  accepted = "2026-11-06T17:28:21.000Z",
  wall = "2026-11-06 12:28:21";
const tag = (n: string, v: string | number) => `<${n}>${v}</${n}>`;
const days = [1, 2, 5, 6, 7, 8, 9, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30].map(
  (d) => "2026-10-" + String(d).padStart(2, "0"),
);
function xml() {
  const header = tag("headerData", tag("submissionType", "N-MFP3"));
  const general = tag(
    "generalInfo",
    tag("reportDate", period) +
      tag("cik", "0000857156") +
      tag("seriesId", series) +
      tag("finalFilingFlag", "N") +
      tag("fundAcqrdOrMrgdWthAnthrFlag", "N") +
      tag("totalShareClassesInSeries", 2),
  );
  const portfolio = tag(
    "seriesLevelInfo",
    tag("fundRetailMoneyMarketFlag", "Y") +
      tag("moneyMarketFundCategory", "Prime") +
      tag("masterFundFlag", "N") +
      tag("feederFundFlag", "N") +
      tag("netAssetOfSeries", "249.99"),
  );
  const month = tag(
    "monthlyShareholderFlowReported",
    tag("totalGrossSubscriptions", "212.10") + tag("totalGrossRedemptions", "233.31"),
  );
  const flows = days
    .map((d) =>
      tag(
        "dialyShareholderFlowReported",
        tag("dailyShareHolderFlowDate", d) +
          tag("dailyGrossSubscriptions", "10.10") +
          tag("dailyGrossRedemptions", "11.11"),
      ),
    )
    .join("");
  const nav = days.map((d) => tag("dailyNetAssetValuePerShareDateClass", d)).join("");
  const yields = days
    .map((d) => tag("sevenDayNetYield", tag("sevenDayNetYieldDate", d) + tag("sevenDayNetYieldValue", "0.0377")))
    .join("");
  const investor = tag(
    "classLevelInfo",
    tag("classesId", contract) +
      tag("classFullName", "Investor Shares") +
      tag("netAssetsOfClass", "200.00") +
      month +
      flows +
      nav +
      yields,
  );
  const other = tag(
    "classLevelInfo",
    tag("classesId", "C000012381") + tag("classFullName", "Ultra Shares") + tag("netAssetsOfClass", "49.99"),
  );
  return tag(
    "edgarSubmission",
    header +
      tag(
        "formData",
        general + portfolio + investor + other + tag("scheduleOfPortfolioSecuritiesInfo", "private holdings"),
      ),
  );
}
type Fake = { accession: string; form: string; series: string; filed: string; utc: string; local: string };
const selected: Fake = { accession: first, form: "N-MFP3", series, filed: date, utc: accepted, local: wall };
function index(f: Fake) {
  const info = (k: string, v: string) => `<div class="infoHead">${k}</div><div class="info">${v}</div>`;
  return (
    info("Period of Report", period) +
    info("Filing Date", f.filed) +
    info("Accepted", f.local) +
    `<table><tr><td>Series</td><td>${f.series}</td></tr><tr><td>Class/Contract</td><td>${contract}</td><td>Investor Shares</td><td>SWVXX</td></tr>
    <tr><td><a href="${new URL(url(f.accession)).pathname}primary_doc.xml">file</a></td><td>${f.form}</td></tr></table>`
  );
}
function source(filings: Fake[] = [selected], body = xml(), indexFor = index) {
  const seen: string[] = [];
  const fetcher = async (request: string) => {
    seen.push(request);
    if (request === "https://data.sec.gov/submissions/CIK0000857156.json")
      return Response.json({
        cik: "857156",
        filings: {
          recent: {
            form: filings.map((f) => f.form),
            accessionNumber: filings.map((f) => f.accession),
            reportDate: filings.map(() => period),
            filingDate: filings.map((f) => f.filed),
            acceptanceDateTime: filings.map((f) => f.utc),
          },
        },
      });
    for (const f of filings) {
      if (request === url(f.accession) + f.accession + "-index.htm") return new Response(indexFor(f));
      if (request === url(f.accession) + "primary_doc.xml") return new Response(body);
    }
    throw Error("Unexpected fixture URL");
  };
  return { seen, fetcher };
}

test("selects the original investor series, reconciles cents and exposes only monthly market-wide context", async () => {
  const s = source([{ ...selected, accession: next, series: "S000001111" }, selected]);
  const result = await collectSchwabRetailFlows(s.fetcher, () => at);
  assert.equal(result.status, "available", result.collectionNote);
  assert.deepEqual(result.instruments, ["MARKET"]);
  assert.deepEqual(result.directionalInstruments, []);
  assert.deepEqual(result.scores, { daily: null, weekly: null, monthly: null });
  assert.deepEqual(result.series, [{ date: period, value: (-2121 / 20000) * 100 }]);
  assert.deepEqual(
    result.metrics.map((m) => m.value),
    [-2121 / 1e11, 20000 / 1e11, 3.77],
  );
  assert.equal(result.schwabRetailFlows?.days, 21);
  assert.equal(result.schwabRetailFlows?.firstVerifiedAt, at);
  assert.equal(result.schwabRetailFlows?.publiclyKnownBy, "2026-11-07T05:00:00.000Z");
  assert.equal(result.source.releasedAt, date);
  assert.equal(result.source.observedAt, period);
  assert.equal(result.source.url, url(first) + first + "-index.htm");
  assert.equal(s.seen.filter((v) => v.endsWith("primary_doc.xml")).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private holdings|dialyShareholderFlowReported/);
  validateSchwabRetailFlows(result, at);
});

test("rejects monthly total drift, series asset mismatch, missing operating dates and ambiguous identities", () => {
  const valid = xml();
  for (const [from, to] of [
    [">212.10<", ">212.11<"],
    [">249.99<", ">249.98<"],
    [">Investor Shares<", ">Ultra Shares<"],
    [">Prime<", ">Government<"],
    ["<fundRetailMoneyMarketFlag>Y", "<fundRetailMoneyMarketFlag>N"],
    ["<sevenDayNetYieldDate>2026-10-01", "<sevenDayNetYieldDate>2026-10-02"],
    ["<seriesId>" + series, "<seriesId>S000001111"],
    ["<classesId>" + contract, "<classesId>C000012381"],
    ["<dailyGrossRedemptions>11.11", "<dailyGrossRedemptions>111.11"],
    ["<headerData>", "<!DOCTYPE arbitrary><headerData>"],
  ])
    assert.throws(() => parseSchwabRetailXml(valid.replace(from, to), period));
});

test("withholds the reading for a matching amendment, duplicate original or mismatched SEC timestamp", async () => {
  for (const [filings, renderer] of [
    [[selected, { ...selected, accession: next, form: "N-MFP3/A" }], index],
    [[selected, { ...selected, accession: next }], index],
    [[selected], (f: Fake) => index(f).replace(wall, "2026-11-06 12:28:22")],
    [[selected], (f: Fake) => index(f).replace("Investor Shares", "Ultra Shares")],
  ] as [Fake[], typeof index][]) {
    const r = await collectSchwabRetailFlows(source(filings, xml(), renderer).fetcher, () => at);
    assert.equal(r.status, "unavailable");
    assert.equal(r.failureKind, "validation");
    assert.deepEqual(r.series, []);
    validateSchwabRetailFlows(r, at);
  }
});

test("separates overnight EDGAR acceptance, official filing date and observed public access", async () => {
  const rollover = { ...selected, utc: "2026-11-05T23:15:00.000Z", local: "2026-11-05 18:15:00" };
  for (const checked of ["2026-11-06T02:00:00.000Z", "2026-11-06T10:00:00.000Z"]) {
    const r = await collectSchwabRetailFlows(source([rollover]).fetcher, () => checked);
    assert.equal(r.status, "unavailable");
  }
  const morning = "2026-11-06T14:00:00.000Z";
  const r = await collectSchwabRetailFlows(source([rollover]).fetcher, () => morning);
  assert.equal(r.status, "available", r.collectionNote);
  assert.equal(r.schwabRetailFlows?.acceptedAt, rollover.utc);
  assert.equal(r.schwabRetailFlows?.publiclyKnownBy, morning);
  assert.throws(() => validateSchwabRetailFlows(r, "2026-11-06T13:00:00.000Z"));
});

test("rechecks live catalogue, uses private immutable originals, and rejects altered cache or public output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daily-consensus-schwab-test-"));
  try {
    const fixture = source();
    const signal = await collectSchwabRetailFlows(fixture.fetcher, () => at, directory);
    assert.equal(signal.status, "available", signal.collectionNote);
    const second = source();
    assert.deepEqual(await collectSchwabRetailFlows(second.fetcher, () => at, directory), signal);
    assert.equal(second.seen.length, 1);
    assert.throws(() => validateSchwabRetailFlows({ ...signal, scores: { ...signal.scores, daily: 0.1 } }));
    assert.throws(() => validateSchwabRetailFlows({ ...signal, instruments: ["SPY"] }));
    assert.throws(() => validateSchwabRetailFlows({ ...signal, metrics: signal.metrics.slice(1) }));
    assert.throws(() =>
      validateSchwabRetailFlows({ ...signal, schwabRetailFlows: { ...signal.schwabRetailFlows!, days: 100 } }),
    );
    assert.throws(() =>
      validateSchwabRetailFlows({
        ...signal,
        schwabRetailFlows: { ...signal.schwabRetailFlows!, publiclyKnownBy: accepted },
      }),
    );
    const files = await readdir(directory);
    assert.equal(files.length, 2);
    for (const file of files) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    const path = join(directory, first + "-xml.json"),
      receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.sha256 = "a".repeat(64);
    await writeFile(path, JSON.stringify(receipt));
    const altered = await collectSchwabRetailFlows(fixture.fetcher, () => at, directory);
    assert.equal(altered.status, "unavailable");
    assert.equal(altered.failureKind, "validation");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects evidence on other signals and strips provider messages from public failures", async () => {
  const signal = await collectSchwabRetailFlows(source().fetcher, () => at);
  assert.throws(() => validateSchwabRetailFlows({ ...signal, id: "unrelated-signal" }), /another signal/);
  validateSchwabRetailFlows({ ...signal, id: "unrelated-signal", schwabRetailFlows: undefined });
  const rejected = await collectSchwabRetailFlows(
    async () => {
      throw Error("synthetic-secret");
    },
    () => at,
  );
  assert.equal(rejected.failureKind, "transport");
  const invalid = await collectSchwabRetailFlows(
    async () => new Response("synthetic-secret"),
    () => at,
  );
  assert.equal(invalid.failureKind, "validation");
  assert.doesNotMatch(JSON.stringify([rejected, invalid]), /synthetic-secret/);
});
