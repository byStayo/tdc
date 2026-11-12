import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  policyCsv,
  ecbPolicyPoints,
  boePolicyPoints,
  fedPolicyPoints,
  collectPolicyRates,
  policyReadings,
} from "../lib/consensus/policy.ts";
import {
  validateReview,
  reviewedPolicySignals,
  type ReviewPacket,
} from "../lib/consensus/reviewed.ts";
import { effectiveStatus } from "../lib/consensus/engine.ts";

const at = "2026-11-03T08:00:00.000Z";
const ecb =
  'KEY,TIME_PERIOD,OBS_VALUE,OBS_STATUS,UNIT,UNIT_MULT,TITLE\nFM.D.U2.EUR.4F.KR.DFR.LEV,2026-11-02,2.5,A,PCPA,0,"Rate, actual"\n';
const boe = "DATE,IUDBEDR\n29 Oct 2026,3.75\n30 Oct 2026,3.75\n";

test("policy CSV preserves quoted descriptions and refuses malformed input", () => {
  assert.deepEqual(policyCsv('a,b\r\n"one, two","said ""three"""\n'), [
    ["a", "b"],
    ["one, two", 'said "three"'],
  ]);
  assert.throws(() => policyCsv('a,b\n"unterminated,2'));
  assert.throws(() => policyCsv('a,b\n"one"extra,2'));
});

test("ECB policy rates validate series, units, dates and observations without treating missing as zero", () => {
  assert.deepEqual(ecbPolicyPoints(ecb, at), [
    { date: "2026-11-02", value: 2.5 },
  ]);
  assert.deepEqual(ecbPolicyPoints(ecb.replace("2.5,A", "-0.5,A"), at), [
    { date: "2026-11-02", value: -0.5 },
  ]);
  assert.deepEqual(ecbPolicyPoints(ecb.replace("2.5,A", "0,A"), at), [
    { date: "2026-11-02", value: 0 },
  ]);
  assert.deepEqual(ecbPolicyPoints(ecb.replace("2.5,A", ",A"), at), []);
  assert.deepEqual(
    ecbPolicyPoints(ecb.replace("2026-11-02", "2026-11-04"), at),
    [],
  );
  assert.throws(() => ecbPolicyPoints(ecb.replace("PCPA,0", "PCPA,3"), at));
  assert.throws(() => ecbPolicyPoints(ecb.replace("DFR.LEV", "ESTR.LEV"), at));
  assert.throws(
    () =>
      ecbPolicyPoints(
        ecb + ecb.split("\n")[1].replace(",2.5,", ",3.5,") + "\n",
        at,
      ),
    /Conflicting/,
  );
});

test("Bank Rate and Fed parsers reject unrelated data and keep working-day gaps", () => {
  assert.deepEqual(
    boePolicyPoints(boe + "31 Feb 2026,3.75\n02 Nov 2026,n.a.\n", at),
    [
      { date: "2026-10-29", value: 3.75 },
      { date: "2026-10-30", value: 3.75 },
    ],
  );
  assert.throws(() => boePolicyPoints(boe.replace("IUDBEDR", "XUDLUSS"), at));
  assert.throws(
    () => boePolicyPoints(boe + "30 Oct 2026,4.00\n", at),
    /Conflicting/,
  );
  assert.deepEqual(
    fedPolicyPoints(
      "observation_date,DFEDTARL\n2026-11-02,3.75\n2026-11-03,.\n",
      "DFEDTARL",
      at,
    ),
    [{ date: "2026-11-02", value: 3.75 }],
  );
  assert.throws(() =>
    fedPolicyPoints("DATE,DFEDTARU\n2026-11-02,4\n", "DFEDTARL", at),
  );
});

const canada = JSON.stringify({
  seriesDetail: { V39079: { metadata: { unit: "Percent", frequency: "Business daily" } } },
  observations: [
    { d: "2026-11-02", V39079: { v: "2.50" } },
    { d: "2026-11-12", V39079: { v: "2.75" } },
  ],
});

const collect = () =>
  collectPolicyRates(
    async (url) => ({
      text: url.includes("DFEDTARL")
        ? "observation_date,DFEDTARL\n2026-11-02,3.75\n"
        : url.includes("DFEDTARU")
          ? "observation_date,DFEDTARU\n2026-11-02,4\n"
          : url.includes("ecb.europa.eu")
            ? ecb
            : url.includes("bankofcanada.ca") ? canada : boe,
      retrievedAt: at,
      sha256: "a".repeat(64),
    }),
    at,
  );

test("policy collection emits cited numeric context, never raw documents or fabricated directional votes", async () => {
  const signals = await collect();
  assert.equal(signals.length, 5);
  assert.ok(
    signals.every(
      (s) => s.status === "available" && s.source.sha256 === "a".repeat(64),
    ),
  );
  assert.ok(
    signals.every(
      (s) =>
        !Object.hasOwn(s.source, "text") &&
        Object.values(s.scores).every((score) => score === null),
    ),
  );
  assert.equal(
    signals.find((s) => s.id === "policy-boe-bank")!.source.observedAt,
    "2026-10-30",
  );
  const cad = signals.find(signal => signal.id === "policy-boc-target")!;
  assert.deepEqual(cad.series, [{ date: "2026-11-02", value: 2.5 }]);
  assert.equal(policyReadings(signals, at).find(reading => reading.currency === "CAD")?.lower, 2.5);
  assert.equal(policyReadings(signals.filter(signal => signal !== cad), at).some(reading => reading.currency === "CAD"), false);
  assert.ok(
    signals.every(
      (s) =>
        !s.source.url.includes("cosd=") && !s.source.url.includes("Datefrom="),
    ),
  );
  const failed = await collectPolicyRates(async () => {
    throw new Error("Provider unavailable");
  }, at);
  assert.ok(
    failed.every((s) => s.status === "unavailable" && s.metrics.length === 0),
  );
});

test("target range presentation refuses mismatched dates and inverted ranges and retains stale dates", async () => {
  const signals = await collect(),
    valid = policyReadings(signals, at)[0];
  assert.equal(valid.lower, 3.75);
  assert.equal(valid.upper, 4);
  assert.equal(valid.at, "2026-11-02");
  signals[1].source.observedAt = "2026-11-01";
  assert.equal(policyReadings(signals, at)[0].lower, null);
  signals[1].source.observedAt = "2026-11-02";
  signals[1].metrics[0].value = 3;
  assert.equal(policyReadings(signals, at)[0].lower, null);
  signals[1].metrics[0].value = 4;
  const older = policyReadings(signals, "2026-11-20T08:00:00.000Z")[0];
  assert.equal(older.stale, true);
  assert.equal(older.at, "2026-11-02");
});

test("reviewed Japan target preserves an approximate dated decision with bounded freshness", async () => {
  const packet: ReviewPacket = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/reviewed-developments-2026-11-03.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  packet.sources.push({
    id: "boj-test",
    name: "Bank of Japan policy statement",
    url: "https://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/k261030a.pdf",
    publishedAt: "2026-10-30",
    retrievedAt: packet.reviewedAt,
    sha256: "b".repeat(64),
  });
  packet.policies = [
    {
      bank: "BOJ",
      sourceId: "boj-test",
      rate: 1.25,
      qualification: "approximate",
    },
  ];
  validateReview(packet, at);
  const signal = reviewedPolicySignals(packet, at)[0];
  assert.equal(signal.source.observedAt, "2026-10-30");
  assert.equal(signal.series.length, 1);
  assert.equal(policyReadings([signal], at)[3].approximate, true);
  assert.equal(effectiveStatus(signal, "2027-01-03T08:00:00.000Z"), "stale");
  packet.policies[0].sourceId = "fed-october";
  assert.throws(() => validateReview(packet, at));
});
