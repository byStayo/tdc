import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { exchangeCalendarVersion, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate-technicals.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { safeURL } from "../lib/consensus/public-source.ts";
import { publisherSecondaryStudies } from "../lib/consensus/secondary-studies.ts";
import { refreshTaiwan } from "../lib/consensus/taiwan.ts";
import {
  calendarAllowsTaiwan,
  parseSectorCsv,
  parseSectorReport,
  TWSE_SECTOR_DIRECTORY,
  TWSE_SECTOR_ID,
  twseSectorUrls,
  validateSectorSignal,
} from "../lib/consensus/twse-sector.ts";
import { collectTwseSector, replayTwseSector } from "../lib/consensus/twse-sector-source.ts";
import { sectorTargetDate, twseSectorStudy } from "../lib/consensus/twse-sector-study.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const sourceDay = "2026-11-27",
  target = "2026-11-30";
const issuedAt = target + "T13:00:00.000Z",
  edition = issuedAt.replace(/[:.]/g, "-");
const broad = "發行量加權股價指數",
  sector = "半導體類指數";
const fields = ["指數", "收盤指數", "漲跌(+/-)", "漲跌點數", "漲跌百分比(%)", "特殊處理註記"];
const calendarHeader = "名稱,日期,星期,說明";
const calendar = [
  calendarHeader,
  "國曆新年開始交易日,1150102,五,x",
  "農曆春節前最後交易日,1150211,三,x",
  "市場無交易，僅辦理結算交割作業,1150212,四,x",
  "農曆春節後開始交易日,1150223,一,x",
  "和平紀念日,1150227,五,x",
  "和平紀念日,1150228,六,x",
  "勞動節,1150501,五,x",
  "端午節,1150619,五,x",
  "中秋節,1150925,五,x",
  "國慶日,1151009,五,x",
  "國慶日,1151010,六,x",
].join("\n");
const stamp = () => new Date().toISOString();
const clock = (t: TestContext, s: string) => t.mock.timers.setTime(Date.parse(s));
const original = (text: string) => ({
  text,
  sha256: createHash("sha256").update(text).digest("hex"),
  retrievedAt: stamp(),
});
function documents(date: string) {
  const parts = date.split("-"),
    roc = String(Number(parts[0]) - 1911);
  const rows = [
    [broad, "101.00", "+", "1.00", "1.00", ""],
    [sector, "98.00", "-", "2.00", "-2.00", ""],
  ];
  const csv = [["日期", "指數/報酬指數", ...fields.slice(1)], ...rows.map((r) => [roc + parts[1] + parts[2], ...r])]
    .map((r) => r.map((v) => '"' + v + '"').join(","))
    .join("\n");
  const compact = parts.join("");
  const report = JSON.stringify({
    stat: "OK",
    date: compact,
    params: { date: compact, type: "IND", controller: "afterTrading", action: "MI_INDEX", lang: "zh" },
    tables: [
      {
        title: roc + "年" + Number(parts[1]) + "月" + Number(parts[2]) + "日 價格指數(臺灣證券交易所)",
        fields,
        data: rows.map(([name, close, sign, ...other]) => [
          name,
          close,
          "<p style ='color:" + (sign === "+" ? "red" : "green") + "'>" + sign + "</p>",
          ...other,
        ]),
      },
    ],
  });
  return { csv, report };
}
async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T20:00:00Z") });
  const root = await mkdtemp(join(tmpdir(), "twse-forward-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function source(date: string, urls: string[] = [], schedule = calendar) {
  const expected = twseSectorUrls(date),
    { csv, report } = documents(date);
  return async (u: string) => {
    urls.push(u);
    if (u === expected.calendar) return original(schedule);
    if (u === expected.csv) return original(csv);
    if (u === expected.report) return original(report);
    throw Error("Unexpected source route");
  };
}
async function issue(root: string, signal: Signal) {
  const snapshot: Snapshot = {
    id: edition,
    issuedAt,
    cutoff: issuedAt,
    origin: "prospective",
    schemaVersion: 1,
    engineVersion: "consensus-rules-2.0.0",
    signals: [signal],
    catalysts: [],
    collectionErrors: [],
    sourcesAttempted: 1,
  };
  const dir = join(root, "public/consensus"),
    bytes = Buffer.from(JSON.stringify(snapshot));
  const index = Buffer.from(
    JSON.stringify([{ id: edition, issuedAt, engineVersion: snapshot.engineVersion, sha256: digest(snapshot) }]),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, edition + ".json"), bytes);
  await writeFile(join(dir, "index.json"), index);
  await writeFile(join(dir, "outcomes.json"), "[]");
  await recordPreopenReceipt(root, target, edition, bytes, index, target + "T13:01:00.000Z");
  return snapshot;
}

test("native price returns reconcile and exclude total return, special treatment, wrong sign, period and duplicate indices", () => {
  const single = "2026-03-04",
    { csv, report } = documents(single),
    pair = parseSectorCsv(csv, single);
  assert.deepEqual(pair, {
    market: { close: 10100, change: 100, percent: 100 },
    sector: { close: 9800, change: -200, percent: -200 },
  });
  assert.deepEqual(parseSectorReport(report, single), pair);
  for (const bad of [
    csv.replace("-2.00", "-3.00"),
    csv.replace(sector, broad),
    csv.replaceAll("1150304", "1150303"),
    csv.replace('"-2.00",""', '"-2.00","flag"'),
    csv.replace(sector, "半導體類報酬指數"),
  ])
    assert.throws(() => parseSectorCsv(bad, single));
  for (const bad of [
    report.replace("價格指數", "報酬指數"),
    report.replace("'-", "'+"),
    report.replace("afterTrading", "beforeTrading"),
    report.replace("-</p>", "+</p>"),
    report.replace("green", "yellow"),
  ].filter((v) => v !== report))
    assert.throws(() => parseSectorReport(bad, single));
});

test("both calendars and allowlisted original paths govern the exact dates and closures", () => {
  assert.ok(calendarAllowsTaiwan(calendar, "2026-02-11"));
  assert.ok(calendarAllowsTaiwan(calendar, "2026-02-23"));
  assert.equal(calendarAllowsTaiwan(calendar, "2026-02-12"), false);
  assert.equal(calendarAllowsTaiwan(calendar, "2026-02-14"), false);
  assert.throws(() => calendarAllowsTaiwan(calendar, "2027-02-11"));
  assert.throws(() => calendarAllowsTaiwan(calendar.replace("1150212,四", "1150212,二"), sourceDay));
  assert.equal(sectorTargetDate(target), sourceDay);
  assert.equal(sectorTargetDate(sourceDay), null);
  assert.equal(sectorTargetDate("2026-11-26"), null);
  assert.equal(sectorTargetDate("2027-11-29"), null);
  for (const url of Object.values(twseSectorUrls(sourceDay))) assert.equal(safeURL(url), url);
  for (const u of [
    "https://www.twse.com.tw/other",
    "https://www.twse.com.tw/exchangeReport/MI_INDEX?date=20261127&type=ALL&response=json",
    twseSectorUrls(sourceDay).report + "&x=1",
    twseSectorUrls(sourceDay).csv + "#fragment",
  ])
    assert.throws(() => safeURL(u));
});

test("one dated source, one public observation, three immutable originals; late reads cannot reset vintage", async (t) => {
  const root = await fixture(t),
    requests: string[] = [];
  clock(t, "2026-11-27T19:02:00.000Z");
  const sig = await collectTwseSector(root, source(sourceDay, requests));
  assert.equal(sig.status, "available");
  assert.equal(requests.length, 3);
  assert.deepEqual(sig.scores, { daily: null, weekly: null, monthly: null });
  validateSectorSignal(sig, stamp());
  assert.deepEqual(
    sig.metrics.map((m) => m.value),
    [-2, 1, -3],
  );
  const firstAt = sig.source.vintageAt;
  clock(t, "2026-11-30T12:49:00.000Z");
  const again = await collectTwseSector(root, source(sourceDay, requests));
  assert.equal(requests.length, 3);
  assert.equal(again.source.sha256, sig.source.sha256);
  assert.equal(again.source.vintageAt, firstAt);
  assert.equal(again.source.retrievedAt, firstAt);
  const proof = await replayTwseSector(root, again, stamp());
  assert.equal(proof?.candidate, -3);
  assert.equal(proof?.control, 1);
  const prior: Snapshot = {
    id: edition,
    issuedAt,
    cutoff: issuedAt,
    origin: "prospective",
    schemaVersion: 1,
    engineVersion: "consensus-rules-2.0.0",
    signals: [sig],
    catalysts: [],
    collectionErrors: [],
    sourcesAttempted: 1,
  };
  const scoped = await refreshTaiwan(prior, source(sourceDay, requests), stamp, root);
  assert.equal(scoped.signals.filter((s) => s.id === TWSE_SECTOR_ID).length, 1);
  assert.equal(scoped.sourcesAttempted, 3);
  for (const mutate of [
    (s: Signal) => {
      s.scores.daily = 1;
    },
    (s: Signal) => {
      s.source.vintageAt = "2026-11-27T02:45:00.000Z";
    },
    (s: Signal) => {
      s.metrics[2].value = 4;
    },
  ]) {
    const bad = structuredClone(again);
    mutate(bad);
    assert.throws(() => validateSectorSignal(bad, stamp()));
  }
  const path = join(root, TWSE_SECTOR_DIRECTORY, "sessions", sourceDay + "-report.json"),
    receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.document.text = receipt.document.text.replace("afterTrading", "changed");
  await durableJSON(path, receipt);
  await assert.rejects(replayTwseSector(root, sig, stamp()), /checksum/);
  assert.equal((await collectTwseSector(root, source(sourceDay, requests))).status, "unavailable");
  assert.equal(requests.length, 5);
});

test("Taiwan holiday or future-dated documents do not roll a known release forward", async (t) => {
  const root = await fixture(t),
    requests: string[] = [];
  clock(t, "2026-10-12T11:48:00.000Z");
  const holiday = await collectTwseSector(root, source("2026-10-09", requests));
  assert.equal(holiday.status, "unavailable");
  assert.equal(requests.length, 1);
  clock(t, "2026-11-27T19:00:00.000Z");
  const other = source(sourceDay);
  const invalid = await collectTwseSector(root, async (url) => ({
    ...(await other(url)),
    retrievedAt: "2026-11-30T15:00:00.000Z",
  }));
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.failureKind, "validation");
});

for (const earlyEnrollment of [true, false])
  test(
    "future registration and actual core intake, registration before Taiwan open = " + earlyEnrollment,
    async (t) => {
      const root = await fixture(t);
      assert.equal(publisherSecondaryStudies.find((x) => x.name === "international")?.study, twseSectorStudy);
      if (!earlyEnrollment) clock(t, "2026-11-27T01:00:00.000Z");
      await twseSectorStudy.register(root);
      clock(t, "2026-11-27T19:01:00.000Z");
      const sig = await collectTwseSector(root, source(sourceDay));
      clock(t, target + "T13:03:00.000Z");
      const snap = await issue(root, sig);
      validateSnapshot(snap);
      const admission = await twseSectorStudy.enroll(root, target, edition);
      assert.equal(admission.enrolled, earlyEnrollment ? 1 : 0);
      if (!earlyEnrollment) return;
      const eventDir = join(root, dirname(twseSectorStudy.registrationPath), "QQQ");
      const saved = JSON.parse(await readFile(join(eventDir, "events", edition + ".json"), "utf8")).value;
      assert.deepEqual(
        [saved.id, saved.candidate, saved.control, saved.phase],
        ["twse:semiconductor:" + sourceDay, -3, 1, "train"],
      );
      clock(t, target + "T22:00:00.000Z");
      const tx = "abababab-1111-4222-8333-444444444444",
        us = exchangeSession(target)!;
      await durableJSON(
        join(root, ".consensus/evaluation-transaction.json"),
        { schemaVersion: 1, id: tx, synthetic: true },
        true,
      );
      let opened = 0;
      const row = {
        snapshotId: edition,
        instrument: "QQQ" as const,
        horizon: "daily" as const,
        issuedAt,
        entryAt: us.openAt,
        exitAt: us.closeAt,
        source: FIRST_RATE_SOURCE,
        adjustment: OUTCOME_PRICE_BASIS,
        calendarVersion: exchangeCalendarVersion(target, target),
        direction: () => {
          opened++;
          return 0 as const;
        },
      };
      const issues = [{ id: edition, issuedAt }];
      await twseSectorStudy.stage(
        root,
        tx,
        [
          { ...row, instrument: "SPY" },
          { ...row, horizon: "weekly" },
          { ...row, source: "guest" },
        ],
        issues,
        [],
      );
      await twseSectorStudy.stage(
        root,
        tx,
        [row],
        [...issues, { id: "later", issuedAt: target + "T14:00:00.000Z" }],
        [],
      );
      assert.equal(opened, 0);
      await twseSectorStudy.stage(root, tx, [row], issues, []);
      await twseSectorStudy.stage(root, tx, [row], issues, []);
      assert.equal(opened, 1);
    },
  );

test("ordinary full publication acquires exactly the three sector sources and retains an unscored QQQ comparison", async (t) => {
  const root = await fixture(t);
  clock(t, "2026-11-27T19:04:00.000Z");
  const matched: string[] = [];
  const urls = Object.values(twseSectorUrls(sourceDay));
  const marketSource = source(sourceDay, matched);
  const full = await collectSnapshot(
    async (url) =>
      urls.includes(url)
        ? new Response((await marketSource(url)).text)
        : new Response("Source outside the fixture", { status: 404 }),
    undefined,
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(matched.sort(), urls.sort());
  const rows = full.signals.filter((s) => s.id === TWSE_SECTOR_ID);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, "available");
  assert.deepEqual(row.instruments, ["QQQ"]);
  assert.deepEqual(row.scores, { daily: null, weekly: null, monthly: null });
  validateSectorSignal(row, full.cutoff);
  assert.equal((await replayTwseSector(root, row, full.cutoff))?.candidate, -3);
});

test("an identifiable first dated release with a marked index cannot be replaced by a corrected report", async (t) => {
  const root = await fixture(t);
  clock(t, "2026-11-27T19:02:00.000Z");
  const requests: string[] = [];
  const normal = source(sourceDay, requests),
    urls = twseSectorUrls(sourceDay);
  const first = await collectTwseSector(root, async (url) => {
    const d = await normal(url);
    if (url !== urls.report) return d;
    const report = JSON.parse(d.text);
    report.tables[0].data[1][5] = "special treatment";
    return original(JSON.stringify(report));
  });
  assert.equal(first.status, "unavailable");
  clock(t, target + "T12:48:06.000Z");
  assert.equal((await collectTwseSector(root, normal)).status, "unavailable");
  assert.equal(requests.length, 3);
});
