import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { signalScore } from "../lib/consensus/scoring-policy.ts";
import { operfPeriods, OPERF_INDEX, OPERF_ID, validateOperfCapital } from "../lib/consensus/operf-capital.ts";
import { collectOperfCapital, parseOperfTable, replayOperfCapital } from "../lib/consensus/operf-capital-source.ts";

const at = "2026-11-19T15:32:37.092Z";
const after = "2026-11-20T11:00:00.000Z";
const files = [1, 2].map(q => new URL("./fixtures/operf-synthetic-q" + q + ".pdf", import.meta.url));
const path = "/treasury/invested-for-oregon/Documents/Invested-for-OR-Performance-and-Holdings/2026/OPERF-Private-Equity-Portfolio-Quarter-";
const link = (q: number) => '<a href="' + path + q + '-2026.pdf">OPERF Private Equity Portfolio - Quarter ' + q + " 2026</a>";
const html = link(2) + link(1);
const entries = new Map<string, Buffer>([
  [OPERF_INDEX, Buffer.from(html)],
  [new URL(path + "1-2026.pdf", OPERF_INDEX).href, await readFile(files[0])],
  [new URL(path + "2-2026.pdf", OPERF_INDEX).href, await readFile(files[1])],
]);
const captured = (retrievedAt: string) => async (url: string) => {
  const bytes = entries.get(url)!;
  return {bytes, sha256: createHash("sha256").update(bytes).digest("hex"), retrievedAt};
};

test("the full daily collector compares exact partnership and vintage, retaining only two nonvoting aggregates", async t => {
  t.mock.timers.enable({apis: ["Date"], now: Date.parse(at)});
  const directory = await mkdtemp(join(tmpdir(), "operf-daily-"));
  try {
    const snapshot = await collectSnapshot(async url => entries.has(url)
      ? new Response(new Uint8Array(entries.get(url)!)) : new Response(null, {status: 503}), undefined, directory);
    const s = snapshot.signals.find(x => x.id === OPERF_ID)!;
    validateOperfCapital(s, snapshot.cutoff);
    assert.equal(s.status, "available");
    assert.equal(s.source.releasedAt, null);
    assert.equal(s.source.observedAt, "2026-06-30");
    assert.deepEqual(s.metrics.map(m => m.value), [9, 5]);
    assert.ok(s.operfCapital);
    assert.equal(s.operfCapital.firstObservedAt, at);
    assert.deepEqual([s.operfCapital.previousFunds, s.operfCapital.currentFunds, s.operfCapital.commonFunds,
      s.operfCapital.decreasingContributions, s.operfCapital.decreasingDistributions], [3, 4, 2, 1, 0]);
    assert.doesNotMatch(JSON.stringify(s), /Stable Alpha|Stable Beta|Reclassified|New Fund|gzip/);
    for (const h of ["daily", "weekly", "monthly"] as const) assert.equal(signalScore(s, "SPY", h), null);
    assert.ok(snapshot.signals.some(x => x.id === "private-capital" && x.status === "unavailable"));
    const [file] = await readdir(directory);
    const receiptPath = join(directory, file);
    assert.deepEqual(await replayOperfCapital(receiptPath, at), s);
    await assert.rejects(replayOperfCapital(receiptPath, "2026-11-19T12:48:00.000Z"), /cutoff/);

    const again = await collectOperfCapital(captured(after), directory, () => after);
    assert.equal(again.source.retrievedAt, after);
    assert.equal(again.operfCapital!.firstObservedAt, at);
    assert.deepEqual(await readdir(directory), [file]);
    const next = new Map(entries);
    next.set(OPERF_INDEX, Buffer.from(link(3) + html));
    next.set(new URL(path + "3-2026.pdf", OPERF_INDEX).href, await readFile(new URL("./fixtures/operf-synthetic-q3.pdf", import.meta.url)));
    const nextSignal = await collectOperfCapital(async url => {
      const bytes = next.get(url)!;
      return {bytes, sha256: createHash("sha256").update(bytes).digest("hex"), retrievedAt: after};
    }, directory, () => after);
    assert.equal(nextSignal.source.observedAt, "2026-09-30");
    assert.equal(nextSignal.operfCapital!.firstObservedAt, after);
    assert.deepEqual(nextSignal.metrics.map(x => x.value), [0, 0]);
    assert.equal((await readdir(directory)).length, 2);
    assert.deepEqual(await replayOperfCapital(receiptPath, after), s);
    const modified = structuredClone(s);
    modified.directionalInstruments = ["SPY"]; modified.scores.daily = 1;
    assert.throws(() => validateOperfCapital(modified, at), /scope/);
    const exposed = structuredClone(s);
    Object.assign(exposed.operfCapital!, {fundRows: ["sensitive"]});
    assert.throws(() => validateOperfCapital(exposed, at), /comparison/);
    const edited = JSON.parse(await readFile(receiptPath, "utf8"));
    edited.previous.gzip = edited.current.gzip;
    await writeFile(receiptPath, JSON.stringify(edited));
    assert.equal((await collectOperfCapital(captured(after), directory, () => after)).status, "unavailable");
    await assert.rejects(replayOperfCapital(receiptPath, after), /digest/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("quarter identity, printed dates and units, duplicate funds, portfolio reconciliation and notices fail closed", async () => {
  assert.throws(() => operfPeriods(link(1) + link(3), at), /adjacent/);
  assert.throws(() => operfPeriods(html, "2026-03-31T12:00:00.000Z"), /quarter/);
  assert.throws(() => operfPeriods(html.replace('href="/', 'href="https://example.com/'), at), /quarter/);
  const text = execFileSync("pdftotext", ["-layout", "-", "-"], {input: await readFile(files[0]), encoding: "utf8"});
  assert.equal(parseOperfTable(text, "2026-03-31").rows.size, 3);
  assert.throws(() => parseOperfTable(text, "2026-06-30"), /scope/);
  assert.throws(() => parseOperfTable(text.replace("($ in millions)", "($ in thousands)"), "2026-03-31"), /units/);
  assert.throws(() => parseOperfTable(text.replace("2019     Stable Beta", "2020     Stable Alpha"), "2026-03-31"), /Duplicate/);
  assert.throws(() => parseOperfTable(text.replace("$240.0", "$999.0"), "2026-03-31"), /reconcile/);
  assert.throws(() => parseOperfTable(text.replace("Private Equity Portfolio", "Private Equity Portfolio\nAll rights reserved"), "2026-03-31"), /notice/);
  const invalid = await collectOperfCapital(captured(after), undefined, () => at);
  assert.equal(invalid.status, "unavailable");
  assert.deepEqual(invalid.metrics, []);
});
