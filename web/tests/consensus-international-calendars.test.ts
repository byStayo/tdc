import test from "node:test";
import assert from "node:assert/strict";
import {
  boeEvents,
  ecbEvents,
  bojEvents,
  reconcileReleasedCalendars,
} from "../lib/consensus/international-calendars.ts";
import { readFileSync } from "node:fs";
import { eventUpcoming } from "../lib/consensus/time.ts";
import { validateSnapshot } from "../lib/consensus/history.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { missingSignals } from "../lib/consensus/registry.ts";

const cutoff = "2026-11-03T08:00:00.000Z";
// As issued, before the scoped calendar correction: both schedules and their original releases are present.
function releasedEdition(): Snapshot {
  return JSON.parse(readFileSync(new URL("../public/consensus/2026-11-05T13-14-01-431Z.json", import.meta.url), "utf8"));
}
const ukSchedule = "boe-decision-2026-11-05";
const japanSchedule = "boj-minutes-2026-09-18-2026-11-05";
test("matched releases retire only their own calendar entries and update the saved next event and counts", () => {
  const original = releasedEdition(), next = reconcileReleasedCalendars(original);
  assert.deepEqual(next.catalysts, original.catalysts.filter(c => ![ukSchedule, japanSchedule].includes(c.id)));
  assert.ok(original.catalysts.some(c => c.id === ukSchedule));
  for (const [id, n, title] of [["boe-calendar", 1, "Bank of England policy decision"], ["boj-calendar", 4, "BoJ summary of opinions"]] as const) {
    const signal = next.signals.find(s => s.id === id)!;
    assert.equal(signal.metrics[0].value, n);
    assert.ok(signal.summary.includes(`next: ${title}`));
    assert.deepEqual(signal.source, original.signals.find(s => s.id === id)!.source);
  }
  assert.equal(reconcileReleasedCalendars(next), next);
});
test("a date alone, a future release, an unrelated story or the wrong meeting cannot retire a schedule", () => {
  const original = releasedEdition(), uk = original.catalysts.find(c => c.id === ukSchedule)!;
  const jp = original.catalysts.find(c => c.id === japanSchedule)!;
  const ukRelease = original.catalysts.find(c => c.kind === "release" && c.url.endsWith("/november-2026"))!;
  const jpRelease = original.catalysts.find(c => c.url.endsWith("/g260918.pdf"))!;
  for (const wrong of [
    { ...ukRelease, at: "2026-11-05" }, { ...ukRelease, at: "2026-11-05T18:00:00.000Z" },
    { ...ukRelease, url: uk.url }, { ...ukRelease, url: ukRelease.url.replace("/november-", "/october-") },
    { ...ukRelease, source: "Other publisher" }, { ...jpRelease, url: jpRelease.url.replace("g260918", "g261030") },
    { ...jpRelease, at: "2026-11-05T23:50:00.000Z" },
  ]) {
    const pending = { ...original, catalysts: [uk, jp, wrong] };
    assert.equal(reconcileReleasedCalendars(pending), pending);
  }
  const preLondon = reconcileReleasedCalendars({ ...original, cutoff: "2026-11-05T11:59:59.999Z" });
  assert.ok(preLondon.catalysts.some(c => c.id === ukSchedule));
  assert.ok(!preLondon.catalysts.some(c => c.id === japanSchedule));
});
test("UK confirmed calendars keep the year, report distinction and local date", () => {
  const html =
    "<h2>2026 confirmed dates</h2><table><tr><td>Thursday 5 November</td><td>MPC Summary and minutes and Monetary Policy Report</td></tr><tr><td>Thursday&nbsp;17 December</td><td>MPC Summary and minutes</td></tr><tr><td>Thursday 31 November</td><td>MPC Summary and minutes</td></tr></table><h2>2027 confirmed dates</h2><table><tr><td>Thursday 4 February</td><td>MPC Summary and minutes</td></tr></table>";
  const events = boeEvents(html, cutoff);
  assert.deepEqual(
    events.map((e) => e.at),
    ["2026-11-05", "2026-12-17"],
  );
  assert.match(events[0].title, /Monetary Policy Report/);
  assert.equal(events[0].dateZone, "Europe/London");
  assert.deepEqual(
    boeEvents(html.replaceAll("confirmed", "provisional"), cutoff),
    [],
  );
  assert.deepEqual(
    boeEvents(html, "2026-12-30T08:00:00.000Z").map((e) => e.at),
    ["2027-02-04"],
  );
});
test("ECB calendar selects monetary decision days, excluding other meetings and first days", () => {
  const row = (day: string, name: string) =>
    `<dt>${day}</dt><dd>Governing Council of the ECB: ${name}</dd>`;
  const html =
    row("25/11/2026", "non-monetary policy meeting") +
    row("16/12/2026", "monetary policy meeting in Frankfurt (Day 1)") +
    row(
      "17/12/2026",
      "monetary policy meeting in Frankfurt (Day 2), followed by press conference",
    ) +
    row(
      "31/11/2026",
      "monetary policy meeting (Day 2), followed by press conference",
    );
  const events = ecbEvents(html, cutoff);
  assert.deepEqual(
    events.map((e) => e.at),
    ["2026-12-17"],
  );
  assert.equal(events[0].dateZone, "Europe/Berlin");
});
const japan = (rows: string) =>
  `<table><caption class="non-caption">Table : 2026</caption><thead><tr><th>Date of MPM</th><th>Release Schedule</th></tr><tr><th>Outlook Report<br>(The Bank's View)</th><th>Summary of Opinions</th><th>MPM Minutes</th></tr></thead><tbody>${rows}</tbody></table>`;
const row = (meeting: string, opinions: string, minutes: string) =>
  `<tr><td>${meeting}</td><td>-</td><td>${opinions}</td><td>${minutes}</td></tr>`;
test("Japan calendar separates decision conclusions, opinions and minutes and honors an explicit next year", () => {
  const html = japan(
    row(
      "Oct. 29 (Thurs.), 30 (Fri.) [PDF 172KB]",
      "Nov. 10 (Tues.)",
      "Dec. 23 (Wed.)",
    ) +
      row(
        "Dec. 17 (Thurs.), 18 (Fri.)",
        "Dec. 28 (Mon.)",
        "Jan. 27 (Wed.), 2027",
      ),
  );
  const events = bojEvents(html, cutoff);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.filter((e) => e.importance === "major").map((e) => e.at),
    ["2026-12-18"],
  );
  assert.equal(
    events.find((e) => e.at === "2026-11-10")?.title,
    "BoJ summary of opinions · 2026-10-30 meeting",
  );
  assert.ok(
    events.every((e) => e.dateZone === "Asia/Tokyo" && e.at.length === 10),
  );
  assert.ok(
    bojEvents(html, "2026-12-30T00:00:00.000Z").some(
      (e) => e.at === "2027-01-27",
    ),
  );
  assert.equal(
    bojEvents(
      html.replace("Jan. 27 (Wed.), 2027", "Jan. 27 (Wed.)"),
      "2026-12-30T00:00:00.000Z",
    ).length,
    0,
  );
});
test("Japan malformed dates, withdrawn releases and changed table columns fail closed", () => {
  const html = japan(
    row("Oct. 30 (Fri.)", "To be announced", "Nov. 31 (Tue.)") +
      row("Dec. 2 (Wed.), 18 (Fri.)", "Dec. 28 (Mon.)", "-"),
  );
  assert.deepEqual(bojEvents(html, cutoff), []);
  const valid = japan(
    row("Dec. 17 (Thurs.), 18 (Fri.)", "Dec. 28 (Mon.)", "-"),
  );
  assert.deepEqual(
    bojEvents(valid.replace("MPM Minutes", "Unknown column"), cutoff),
    [],
  );
});
test("date-only catalysts expire on the source local day rather than New York midnight", () => {
  assert.equal(
    eventUpcoming("2026-11-05", "2026-11-05T14:59:00.000Z", 70, "Asia/Tokyo"),
    true,
  );
  assert.equal(
    eventUpcoming("2026-11-05", "2026-11-05T15:01:00.000Z", 70, "Asia/Tokyo"),
    false,
  );
  assert.equal(
    eventUpcoming(
      "2026-11-05",
      "2026-11-06T00:01:00.000Z",
      70,
      "Europe/London",
    ),
    false,
  );
  assert.equal(eventUpcoming("2026-11-05", "2026-11-06T00:01:00.000Z"), true);
});
test("saved snapshots reject unsupported or ambiguous event timezone metadata", () => {
  const catalyst = ecbEvents(
    "<dt>17/12/2026</dt><dd>Governing Council of the ECB: monetary policy meeting (Day 2), followed by press conference</dd>",
    cutoff,
  )[0];
  const s: Snapshot = {
    schemaVersion: 1,
    id: "2026-11-03T08-00-00-000Z",
    issuedAt: cutoff,
    cutoff,
    engineVersion: "test-v1",
    origin: "prospective",
    signals: missingSignals(cutoff),
    catalysts: [catalyst],
    sourcesAttempted: 1,
    collectionErrors: [],
  };
  validateSnapshot(s);
  assert.throws(
    () =>
      validateSnapshot({
        ...s,
        catalysts: [{ ...catalyst, dateZone: "Mars/Unknown" as never }],
      }),
    /Invalid catalyst/,
  );
  assert.throws(
    () =>
      validateSnapshot({
        ...s,
        catalysts: [{ ...catalyst, at: "2026-12-17T13:00:00.000Z" }],
      }),
    /Invalid catalyst/,
  );
});
