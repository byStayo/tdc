import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import {
  ticSeries,
  collectCapital,
  monthEnd,
} from "../lib/consensus/capital.ts";
import {
  privateFundSeries,
  latestPrivateFundWorkbook,
  collectPrivateFunds,
} from "../lib/consensus/private-funds.ts";

const cutoff = "2026-11-03T07:00:00.000Z";
const header =
  "country\tcountry_code\tdate\tfor_lt_eqty_pos\tfor_lt_eqty_net\tfor_lt_eqty_valchg";
test("Treasury flows use only the grand total, preserve negative/zero and keep valuations separate", () => {
  const data = [
    "Millions of dollars",
    header,
    "Grand Total\t99996\t2026-08\t2000\t-100\t500",
    "Grand Total\t99996\t2026-07\t1000\t0\t200",
    "All Europe\t12345\t2026-08\t1000\t5000\t400",
    "Grand Total\t99996\t2026-12\t2000\t800\t500",
    "Grand Total\t99996\t2026-06\t2000\tn.a.\t500",
  ].join("\n");
  assert.deepEqual(ticSeries(data, "for_lt_eqty", cutoff), [
    { date: "2026-07-31", value: 0, holdings: 1, valuation: 0.2 },
    { date: "2026-08-31", value: -0.1, holdings: 2, valuation: 0.5 },
  ]);
  assert.equal(monthEnd("2024-02"), "2024-02-29");
  assert.equal(monthEnd("2024-13"), null);
  assert.throws(
    () =>
      ticSeries(data.replace("Millions", "Billions"), "for_lt_eqty", cutoff),
    /units/,
  );
  assert.throws(
    () =>
      ticSeries(
        data + "\nGrand Total\t99996\t2026-08\t2000\t101\t500",
        "for_lt_eqty",
        cutoff,
      ),
    /Conflicting/,
  );
});
test("capital collectors keep failures explicit and never cast a directional vote", async () => {
  const signals = await collectCapital(async () => {
    throw new Error("offline");
  });
  assert.equal(signals.length, 6);
  assert.ok(
    signals.every(
      (s) =>
        s.status === "unavailable" &&
        Object.values(s.scores).every((v) => v === null),
    ),
  );
});
function workbook(maskNet = false): Uint8Array {
  const strings = [
    "Fund Type",
    "2025Q2",
    "2025Q3",
    "2027Q1",
    "Private Equity Fund",
    "Tab.2.1",
    "Aggregate GAV ($ Billions)",
    "Tab.2.3",
    "Aggregate NAV ($ Billions)",
  ];
  const cell = (r: string, v: string | number, s = false) =>
    `<c r="${r}"${s ? ' t="s"' : ""}><v>${v}</v></c>`;
  const sheet = (values: [number, number, number], mask = false) =>
    `<worksheet><sheetData><row r="1">${[0, 1, 2, 3].map((v, i) => cell(`${String.fromCharCode(65 + i)}1`, v, true)).join("")}</row><row r="2">${cell("A2", 4, true)}${cell("B2", values[0])}${mask ? '<c r="C2"/>' : cell("C2", values[1])}${cell("D2", values[2])}</row></sheetData></worksheet>`;
  return zipSync(
    Object.fromEntries(
      Object.entries({
        "xl/workbook.xml": `<workbook><sheets>${["Notes", "Tab.1.1", "Tab.2.1", "Tab.2.3"].map((name, i) => `<sheet name="${name}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships>${[1, 2, 3, 4].map((i) => `<Relationship Id="rId${i}" Target="worksheets/sheet${i}.xml"/>`).join("")}</Relationships>`,
        "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row>${cell("A1", 5, true)}${cell("B1", 6, true)}</row><row>${cell("A2", 7, true)}${cell("B2", 8, true)}</row></sheetData></worksheet>`,
        "xl/worksheets/sheet2.xml": sheet([25133, 25155, 26000]),
        "xl/worksheets/sheet3.xml": sheet([7950, 7958, 9000]),
        "xl/worksheets/sheet4.xml": sheet([7286, 7293, 8000], maskNet),
      }).map(([k, v]) => [k, strToU8(v)]),
    ),
  );
}
test("SEC aggregate workbook selects named fund rows and periods, keeps masked cells missing", () => {
  const rows = privateFundSeries(workbook(), cutoff);
  assert.deepEqual(rows.gross.at(-1), { date: "2025-09-30", value: 7958 });
  assert.deepEqual(rows.net.at(-1), { date: "2025-09-30", value: 7293 });
  assert.equal(rows.count.at(-1)?.value, 25155);
  assert.equal(rows.gross.length, 2);
  assert.equal(
    privateFundSeries(workbook(true), cutoff).net.at(-1)?.date,
    "2025-06-30",
  );
});
test("SEC discovery rejects external credentials and future reports, chooses newest actual linked quarter", () => {
  const path = (q: string) =>
    `/files/investment/private-funds-statistics-${q}-supporting-data.xlsx`;
  const html = [
    path("2025-q2"),
    path("2025-q3"),
    path("2027-q1"),
    `https://attacker.example${path("2026-q3")}`,
    `https://name:pass@www.sec.gov${path("2026-q2")}`,
  ]
    .map((u) => `<a href="${u}">Report</a>`)
    .join("");
  assert.equal(
    latestPrivateFundWorkbook(html, cutoff),
    `https://www.sec.gov${path("2025-q3")}`,
  );
  assert.throws(() => latestPrivateFundWorkbook("", cutoff));
});
test("private-equity collector never fills a missing latest NAV or publishes asset values as flows", async () => {
  const page = async () => ({
    text: '<a href="/files/investment/private-funds-statistics-2025-q3-supporting-data.xlsx">Report</a>',
    sha256: "a".repeat(64),
    retrievedAt: cutoff,
  });
  const signal = await collectPrivateFunds(
    page,
    async () => new Response(new Uint8Array(workbook()).buffer),
    () => cutoff,
  );
  assert.equal(signal.status, "available");
  assert.equal(signal.source.observedAt, "2025-09-30");
  assert.equal(signal.metrics[0].value, 7958);
  assert.ok(Object.values(signal.scores).every((v) => v === null));
  assert.equal(
    (
      await collectPrivateFunds(
        page,
        async () => new Response(new Uint8Array(workbook(true)).buffer),
        () => cutoff,
      )
    ).status,
    "unavailable",
  );
});
