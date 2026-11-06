import test from "node:test";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  HOLDINGS_MANAGERS,
  selectHoldingsFilings,
  parseHoldingsReport,
  collectHoldings,
  holdingsSignal,
  validateHoldings,
} from "../lib/consensus/holdings.ts";
import type {
  FilingIdentity,
  InstitutionalHoldings,
} from "../lib/consensus/holdings.ts";
import {
  validateSnapshot,
  observationDigest,
} from "../lib/consensus/history.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const cutoff = "2026-11-03T08:00:00.000Z",
  later = "2026-11-03T09:00:00.000Z";
const manager = HOLDINGS_MANAGERS[0];
const identity: FilingIdentity = {
  accession: "0001193125-26-352200",
  period: "2026-06-30",
  filedAt: "2026-08-14",
};
const previous: FilingIdentity = {
  accession: "0001193125-26-226661",
  period: "2026-03-31",
  filedAt: "2026-05-15",
};
function cover(
  cik = manager.cik as string,
  period = identity.period,
  count = 4,
  value = 1350,
) {
  const [year, month, day] = period.split("-");
  return `<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler"><submissionType>13F-HR</submissionType><cik>${cik}</cik><periodOfReport>${month}-${day}-${year}</periodOfReport><reportCalendarOrQuarter>${month}-${day}-${year}</reportCalendarOrQuarter><isAmendment>false</isAmendment><reportType>13F HOLDINGS REPORT</reportType><tableEntryTotal>${count}</tableEntryTotal><tableValueTotal>${value}</tableValueTotal><isConfidentialOmitted>false</isConfidentialOmitted></edgarSubmission>`;
}
function row(
  name: string,
  value: number,
  type = "SH",
  option = "",
  other = "1",
) {
  return `<infoTable><nameOfIssuer>${name}</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${name === "ACME" ? "000000001" : "000000002"}</cusip><value>${value}</value><sshPrnamt>${value * 10}</sshPrnamt><sshPrnamtType>${type}</sshPrnamtType>${option ? `<putCall>${option}</putCall>` : ""}<investmentDiscretion>DFND</investmentDiscretion><otherManager>${other}</otherManager></infoTable>`;
}
const table = (rows: string[]) =>
  `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows.join("")}</informationTable>`;
const rows = [
  row("ACME", 100),
  row("ACME", 200, "SH", "", "2"),
  row("BETA", 450, "SH", "Put"),
  row("BETA", 600, "PRN"),
];
const metadata = (cik = manager.cik as string) => ({
  cik,
  filings: {
    recent: {
      form: ["13F-HR", "13F-HR"],
      reportDate: [identity.period, previous.period],
      filingDate: [identity.filedAt, previous.filedAt],
      accessionNumber: [identity.accession, previous.accession],
    },
  },
});
function report(id: FilingIdentity) {
  const base = `https://www.sec.gov/Archives/edgar/data/1067983/${id.accession.replaceAll("-", "")}/`;
  return {
    ...id,
    url: `${base}${id.accession}-index.html`,
    coverUrl: `${base}primary_doc.xml`,
    tableUrl: `${base}holdings.xml`,
    retrievedAt: cutoff,
    hashes: {
      submissions: "a".repeat(64),
      index: "b".repeat(64),
      cover: "c".repeat(64),
      table: "d".repeat(64),
    },
    ...parseHoldingsReport(
      cover(manager.cik, id.period),
      table(rows),
      manager.cik,
      id,
    ),
  };
}
const sample = (): InstitutionalHoldings => ({
  ...manager,
  current: report(identity),
  previous: report(previous),
});
function snapshot(item = sample()): Snapshot {
  return {
    schemaVersion: 1,
    id: "2026-11-03T08-00-00-000Z",
    issuedAt: cutoff,
    cutoff,
    origin: "prospective",
    engineVersion: "test-v1",
    signals: [...missingSignals(cutoff), holdingsSignal(item)],
    catalysts: [],
    sourcesAttempted: 1,
    collectionErrors: [],
    holdings: [item],
  };
}

test("13F parser reconciles dollars and aggregates discrete rows while excluding options and principal amounts", () => {
  const r = parseHoldingsReport(cover(), table(rows), manager.cik, identity);
  assert.equal(r.reportedValueUSD, 1350);
  assert.equal(r.shareValueUSD, 300);
  assert.equal(r.excludedValueUSD, 1050);
  assert.equal(r.sharePositions, 1);
  assert.deepEqual(r.top, [
    { issuer: "ACME", securityClass: "COM", valueUSD: 300, shares: 3000 },
  ]);
  assert.equal(r.remainingValueUSD, 0);
  const namespaced = table(rows)
    .replace(
      /<(\/?)(informationTable|infoTable|nameOfIssuer|titleOfClass|cusip|value|sshPrnamt|sshPrnamtType|putCall|investmentDiscretion|otherManager)/g,
      "<$1ns:$2",
    )
    .replace("xmlns=", "xmlns:ns=");
  assert.deepEqual(
    parseHoldingsReport(cover(), namespaced, manager.cik, identity),
    r,
  );
});
test("13F rejects totals, missing rows, wrong issuer/period, duplicate rows, unknown units and external entities", () => {
  for (const [c, t] of [
    [cover(manager.cik, identity.period, 4, 1351), table(rows)],
    [cover(), table(rows.slice(1))],
    [cover("0000000001"), table(rows)],
    [cover(manager.cik, "2026-03-31"), table(rows)],
    [cover(manager.cik, identity.period, 2, 200), table([rows[0], rows[0]])],
    [
      cover(),
      table(rows).replace("<sshPrnamtType>SH", "<sshPrnamtType>UNKNOWN"),
    ],
    [
      cover(),
      '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///private">]>' + table(rows),
    ],
    [cover(), table(rows).replace("ACME", "&unknown;")],
  ])
    assert.throws(() => parseHoldingsReport(c, t, manager.cik, identity));
});
test("filing selection requires consecutive original quarters and never ignores an amendment", () => {
  assert.deepEqual(selectHoldingsFilings(metadata(), manager.cik, cutoff), [
    identity,
    previous,
  ]);
  for (const mutate of [
    (m: ReturnType<typeof metadata>) => {
      m.filings.recent.form[0] = "13F-HR/A";
    },
    (m: ReturnType<typeof metadata>) => {
      m.filings.recent.form[0] = "13F-NT";
    },
    (m: ReturnType<typeof metadata>) => {
      m.filings.recent.reportDate[1] = "2025-12-31";
    },
    (m: ReturnType<typeof metadata>) => {
      m.filings.recent.filingDate[0] = "2026-11-04";
    },
    (m: ReturnType<typeof metadata>) => {
      m.cik = "0000000001";
    },
  ]) {
    const m = metadata();
    mutate(m);
    assert.throws(() => selectHoldingsFilings(m, manager.cik, cutoff));
  }
});
test("published institutional aggregates must agree with original evidence and cannot add a trading vote", () => {
  const s = snapshot();
  validateSnapshot(s);
  assert.ok(Object.values(s.signals.at(-1)!.scores).every((v) => v === null));
  for (const mutate of [
    (s: Snapshot) => {
      s.holdings![0].current.shareValueUSD += 1;
    },
    (s: Snapshot) => {
      s.holdings![0].current.url = "https://example.com/filing";
    },
    (s: Snapshot) => {
      s.signals.at(-1)!.scores.daily = 0.5;
    },
    (s: Snapshot) => {
      s.holdings = undefined;
    },
    (s: Snapshot) => {
      s.holdings![0].current.retrievedAt = "2026-11-04T08:00:00.000Z";
    },
  ]) {
    const copy = structuredClone(s);
    mutate(copy);
    assert.throws(() => validateSnapshot(copy));
  }
});
test("a source recheck alone does not publish another holdings edition", () => {
  const original = snapshot(),
    copy = structuredClone(original);
  for (const r of [copy.holdings![0].current, copy.holdings![0].previous]) {
    r.retrievedAt = later;
    r.hashes.table = "e".repeat(64);
  }
  copy.signals[copy.signals.length - 1] = holdingsSignal(copy.holdings![0]);
  assert.equal(observationDigest(original), observationDigest(copy));
  copy.holdings![0].current.confidentialOmitted = true;
  assert.notEqual(observationDigest(original), observationDigest(copy));
});
test("holdings transport failure retains dated evidence; invalid or amended evidence does not", () => {
  const original = snapshot(),
    next = structuredClone(original);
  next.id = "2026-11-03T09-00-00-000Z";
  next.issuedAt = next.cutoff = later;
  next.holdings = [];
  const s = next.signals.at(-1)!;
  s.status = "unavailable";
  s.series = [];
  s.metrics = [];
  s.source.observedAt = null;
  s.source.sha256 = null;
  s.failureKind = "transport";
  const retained = retainLastKnown(next, original);
  validateSnapshot(retained);
  assert.deepEqual(retained.holdings, original.holdings);
  assert.equal(retained.signals.at(-1)!.source.retrievedAt, cutoff);
  assert.equal(observationDigest(retained), observationDigest(original));
  s.failureKind = "validation";
  const rejected = retainLastKnown(next, original);
  validateSnapshot(rejected);
  assert.equal(rejected.signals.at(-1)!.status, "unavailable");
  assert.equal(rejected.holdings?.length, 0);
});
test("collector publishes only selected filing aggregates and labels source versus validation failure", async () => {
  const doc = (text: string) => ({
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    retrievedAt: cutoff,
  });
  const r = await collectHoldings(async (url) => {
    if (url.includes("1350694")) throw new SourceTransportError("HTTP 503");
    if (url.includes("submissions")) return doc(JSON.stringify(metadata()));
    if (url.endsWith("index.json"))
      return doc(
        JSON.stringify({
          directory: {
            item: [{ name: "primary_doc.xml" }, { name: "holdings.xml" }],
          },
        }),
      );
    if (url.endsWith("primary_doc.xml"))
      return doc(
        cover(
          manager.cik,
          url.includes("226661") ? previous.period : identity.period,
        ),
      );
    return doc(table(rows));
  }, cutoff);
  assert.equal(r.holdings.length, 1);
  validateHoldings(r.holdings, cutoff);
  assert.equal(r.signals[0].status, "available");
  assert.equal(r.signals[1].failureKind, "transport");
  assert.doesNotMatch(
    JSON.stringify(r.holdings),
    /<infoTable>|signature|street|phone|ccc/,
  );
  const invalid = await collectHoldings(async () => doc("{}"), cutoff);
  assert.ok(invalid.signals.every((s) => s.failureKind === "validation"));
});
