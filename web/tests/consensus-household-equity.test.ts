import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { collectHouseholdEquity, householdEquityTable, validateHouseholdEquity } from "../lib/consensus/household-equity.ts";
import { observationDigest, validateSnapshot } from "../lib/consensus/history.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";
import type { Signal } from "../lib/consensus/types.ts";

const html = await readFile(new URL("./fixtures/fed-household-equity-20260911.html", import.meta.url), "utf8");
const id = "fed-household-equity-transactions";
const current = "https://www.federalreserve.gov/releases/z1/current/html/S1M_t.htm";
const dated = "https://www.federalreserve.gov/releases/z1/20260911/html/S1M_t.htm";
const release = "https://www.federalreserve.gov/releases/z1/";
const matrix = "https://www.federalreserve.gov/releases/z1/20260911/html/M3_t_c.htm";
const unitHtml = await readFile(new URL("./fixtures/fed-household-equity-unit-20260911.html", import.meta.url), "utf8");
const releaseHtml = '<div class="dates">Release Date: September 11, 2026 2026:Q2 Release</div>';
const cutoff = "2026-11-19T20:00:00.000Z";
const doc = (text = html, retrievedAt = cutoff) => ({ text, retrievedAt, sha256: createHash("sha256").update(text).digest("hex") });
const bodies = { [current]: html, [dated]: html, [release]: releaseHtml, [matrix]: unitHtml };
const reader = (overrides: Record<string, ReturnType<typeof doc>> = {}, at = cutoff) => async (url: string) => {
  if (url in overrides) return overrides[url];
  assert.ok(url in bodies, `Unexpected source ${url}`);
  return doc(bodies[url as keyof typeof bodies], at);
};
const fetcher = (overrides: Record<string, string> = {}) => async (url: string) => {
  const value = { ...bodies, ...overrides }[url];
  return new Response(value ?? "", { status: value === undefined ? 503 : 200 });
};

test("synthetic next-quarter release recurs through the normal daily collector without backdating", async t => {
  // Deliberately synthetic future evidence; these are not observed Fed figures.
  const at = "2026-12-11T20:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const quarters = ["2025:Q2", "2025:Q3", "2025:Q4", "2026:Q1", "2026:Q2", "2026:Q3"];
  const next = html.replaceAll("September 11, 2026", "December 10, 2026")
    .replace(/>20\d{2}:Q[1-4]<\/th>/g, () => `>${quarters.shift()}</th>`)
    .replace('>1352.7</td>', '>999.0</td>');
  const bodies: Record<string, string> = {
    "https://www.federalreserve.gov/releases/z1/": '<div class="dates">Release Date: December 10, 2026 2026:Q3 Release</div>',
    [current]: next,
    "https://www.federalreserve.gov/releases/z1/20261210/html/S1M_t.htm": next,
    "https://www.federalreserve.gov/releases/z1/20261210/html/M3_t_c.htm": '<span class="tableunit">Billions of dollars; seasonally adjusted</span><table id="M3.t.c"><thead><tr><th id="s1">Households and Nonprofit Organizations</th></tr></thead><tbody><tr><th>Corporate equities</th><td headers="s1 i1 c1">FA153064105</td></tr></tbody></table><div id="lastUpdate">Last Update: December 10, 2026</div>',
  };
  const snapshot = await collectSnapshot(async url => new Response(bodies[url] ?? "", { status: url in bodies ? 200 : 503 }));
  const signal = snapshot.signals.find(s => s.id === id)!;
  assert.equal(signal.status, "available", signal.summary);
  assert.equal(signal.source.releasedAt, "2026-12-10");
  assert.equal(signal.source.url, "https://www.federalreserve.gov/releases/z1/20261210/html/S1M_t.htm");
  assert.deepEqual(signal.series, [{ date: "2026-09-30", value: 999 }]);
  assert.equal(signal.householdEquity?.firstObservedAt, at);
  assert.ok(Object.values(signal.scores).every(score => score === null));
  validateSnapshot(snapshot);
  const prior = await collectHouseholdEquity(reader(), () => cutoff);
  const interrupted = await collectHouseholdEquity(async () => { throw new SourceTransportError("offline"); }, () => cutoff, prior);
  const repeated = await collectSnapshot(async url => new Response(bodies[url] ?? "", { status: url in bodies ? 200 : 503 }), {
    ...snapshot, signals: snapshot.signals.map(s => s.id === id ? interrupted : s),
  });
  const nextSignal = repeated.signals.find(s => s.id === id)!;
  assert.equal(nextSignal.status, "available", nextSignal.summary);
  assert.equal(nextSignal.householdEquity?.firstObservedAt, at);
  assert.notEqual(nextSignal.householdEquity?.firstObservedSHA256, prior.householdEquity?.firstObservedSHA256);
  const revised = await collectSnapshot(async url => new Response(bodies[url]?.replace('>2016.1</td>', '>2017.1</td>') ?? "", { status: url in bodies ? 200 : 503 }), snapshot);
  assert.equal(revised.signals.find(s => s.id === id)?.status, "unavailable");
  assert.match(revised.signals.find(s => s.id === id)!.summary, /revised without a new verified vintage/);
  validateSnapshot(revised);
  const retry = await collectSnapshot(async url => new Response(bodies[url]?.replace('>2016.1</td>', '>2017.1</td>') ?? "", { status: url in bodies ? 200 : 503 }), revised);
  assert.equal(retry.signals.find(s => s.id === id)?.status, "unavailable", "A withheld revision lost the original native guard on retry");
  assert.deepEqual(retry.signals.find(s => s.id === id)?.series, []);
  validateSnapshot(retry);
  const tampered = structuredClone(retry);
  const receipt = tampered.signals.find(s => s.id === id)!.householdEquityCheckpoint!.receipt;
  if (receipt.reviewVersion === 'fed-household-equity-v2') receipt.nativeSHA256 = '0'.repeat(64);
  assert.throws(() => validateSnapshot(tampered), /household-equity/i);
  const restored = await collectSnapshot(async url => new Response(bodies[url] ?? "", { status: url in bodies ? 200 : 503 }), retry);
  assert.equal(restored.signals.find(s => s.id === id)?.status, "available");
  assert.deepEqual(restored.signals.find(s => s.id === id)?.householdEquity, signal.householdEquity);
  validateSnapshot(restored);
  const zero = await collectSnapshot(async url => new Response(bodies[url]?.replace('>999.0</td>', '>0.0</td>') ?? "", { status: url in bodies ? 200 : 503 }));
  assert.equal(zero.signals.find(s => s.id === id)?.series[0]?.value, 0);
});

test("normal daily collection admits the original household/NPISH transaction as nonvoting retail context", async () => {
  const snapshot = await collectSnapshot(fetcher());
  const signal = snapshot.signals.find(s => s.id === id);
  assert.ok(signal, "Normal collector omits the reviewed household-equity observation");
  assert.equal(signal.status, "available");
  assert.equal(signal.family, "retail");
  assert.equal(signal.source.url, dated);
  assert.equal(signal.source.releasedAt, "2026-09-11");
  assert.equal(signal.source.observedAt, "2026-06-30");
  assert.equal(signal.unit, "$bn SAAR");
  assert.deepEqual(signal.series, [{ date: "2026-06-30", value: 1352.7 }]);
  assert.deepEqual(signal.directionalInstruments, []);
  assert.ok(Object.values(signal.scores).every(score => score === null));
});

test("original Fed annual columns do not become earlier quarterly publications", () => {
  const result = householdEquityTable(html, cutoff);
  assert.deepEqual(result.points, [
    { date: "2025-03-31", value: 845.1 }, { date: "2025-06-30", value: -273.8 },
    { date: "2025-09-30", value: 1648.5 }, { date: "2025-12-31", value: 1076.4 },
    { date: "2026-03-31", value: 2016.1 }, { date: "2026-06-30", value: 1352.7 },
  ]);
});

test("missing or ambiguous periods, transaction values and sector definitions fail closed", () => {
  const row = html.match(/<tr\b[^>]*>[\s\S]*?FA153064105[\s\S]*?<\/tr>/)![0];
  for (const bad of [
    html.replace('>1352.7</td>', '>n.a.</td>'), html.replace('>1352.7</td>', '></td>'),
    html.replace('>2026:Q2</th>', '>2026:Q1</th>'), html.replace('>2026:Q2</th>', '>2026:Q3</th>'),
    html.replace('id="s1mt"', 'id="s1ms"'), html.replaceAll('FA153064105', 'LM153064105'),
    html.replace('through 2012q3', 'through 2026q2'), html.replace('Households and nonprofit organizations', 'Households'),
    html.replace(row, row + row), html.replace('id="lastUpdate"', 'id="updated"'),
    html.replace(/<td[^>]+headers="t9[^>]*>[\s\S]*?<\/td>/, ''),
  ]) assert.throws(() => householdEquityTable(bad, cutoff), /household-equity|Household-equity|Fed/);
});

test("date-only publication is not known at the quarter end or during its New York release day", async () => {
  for (const at of ["2026-06-30T20:00:00.000Z", "2026-09-11T23:59:00.000Z", "2026-09-12T01:00:00.000Z"])
    assert.equal((await collectHouseholdEquity(reader({}, at), () => at)).status, "unavailable");
  assert.equal((await collectHouseholdEquity(reader({}, "2026-09-12T12:00:00.000Z"), () => "2026-09-12T12:00:00.000Z")).status, "available");
  assert.throws(() => householdEquityTable(html.replaceAll("September 11, 2026", "December 10, 2026"), "2026-12-11T20:00:00.000Z"), /quarter|cadence/);
});

test("dated source disagreement, invalid digest or a future capture withholds the observation", async () => {
  for (const bad of [doc(html.replace('>1352.7</td>', '>1353.7</td>')), { ...doc(), sha256: 'bad' }, doc(html, "2026-11-20T20:00:00.000Z")]) {
    const signal = await collectHouseholdEquity(reader({ [dated]: bad }), () => cutoff);
    assert.equal(signal.status, "unavailable"); assert.equal(signal.failureKind, "validation");
    assert.deepEqual(signal.series, []); assert.equal(signal.householdEquity, undefined);
  }
});

test("original release, coded unit matrix, sector and quarter must describe the same vintage", async () => {
  for (const [url, text] of [
    [release, releaseHtml.replace('2026:Q2', '2026:Q3')],
    [release, releaseHtml.replace('September 11, 2026', 'December 10, 2026')],
    [release, releaseHtml + releaseHtml],
    [release, '<div class="dates">Release Date: September 11, 2026</div>'],
    [matrix, unitHtml.replace('Billions of dollars', 'Millions of dollars')],
    [matrix, unitHtml.replaceAll('seasonally adjusted', 'not seasonally adjusted')],
    [matrix, unitHtml.replaceAll('FA153064105', 'FL153064105')],
    [matrix, unitHtml.replace('headers="s1 i1 c1', 'headers="s2 i1 c1')],
    [matrix, unitHtml.replaceAll('September 11, 2026', 'December 10, 2026')],
    [dated, html.replace('Corporate equities<sup>', 'Mutual fund shares<sup>')],
    [dated, html.replace('personal trusts.', 'personal trusts and hedge funds.')],
    [dated, html.replaceAll('tender offer funds.', 'tender offer funds and other accounts.')],
  ]) {
    const signal = await collectHouseholdEquity(reader({ [url]: doc(text) }), () => cutoff);
    assert.equal(signal.status, "unavailable", `Admitted changed ${url}: ${text.slice(-250)}`);
    assert.equal(signal.failureKind, "validation");
  }
});

test("a revision within the same original vintage is withheld even when the latest quarter is unchanged", async () => {
  const first = await collectHouseholdEquity(reader(), () => cutoff);
  const changed = html.replace('>2016.1</td>', '>2017.1</td>');
  for (const previous of [undefined, first]) {
    const revision = await collectHouseholdEquity(reader({ [current]: doc(changed), [dated]: doc(changed) }), () => cutoff, previous);
    assert.equal(revision.status, "unavailable", revision.summary);
    assert.equal(revision.failureKind, "validation");
  }
});

test("first product collection uses the actual collection clock rather than cached evidence or legacy clocks", async () => {
  const earlier = "2026-11-19T16:00:00.000Z";
  const legacy = JSON.parse(await readFile(new URL('./fixtures/fed-household-equity-v1.json', import.meta.url), 'utf8')) as Signal;
  validateHouseholdEquity(legacy);
  const original = JSON.stringify(legacy);
  const signal = await collectHouseholdEquity(reader({}, earlier), () => cutoff, legacy);
  assert.equal(signal.status, "available", signal.summary);
  assert.equal(signal.householdEquity?.reviewVersion, "fed-household-equity-v2");
  assert.equal(signal.householdEquity?.firstObservedAt, cutoff);
  assert.equal(signal.source.retrievedAt, cutoff);
  assert.equal(JSON.stringify(legacy), original);
  if (signal.householdEquity?.reviewVersion === 'fed-household-equity-v2')
    assert.equal(signal.householdEquity.firstEvidenceRetrievedAt, earlier);
  for (const url of [current, dated, release, matrix]) {
    const bad = await collectHouseholdEquity(reader({ [url]: doc(bodies[url as keyof typeof bodies], '2026-09-11T15:00:00.000Z') }), () => cutoff);
    assert.equal(bad.status, 'unavailable', `Accepted pre-release evidence at ${url}`);
  }
});

test("publication enforces native units, NPISH residual scope, first capture, method break and nonvoting grade", async () => {
  const signal = await collectHouseholdEquity(reader(), () => cutoff);
  validateHouseholdEquity(signal);
  assert.equal(signal.householdEquity?.seriesId, "FA153064105.Q");
  assert.equal(signal.householdEquity?.firstObservedAt, cutoff);
  assert.equal(signal.householdEquity?.publicationClock, "date-only");
  assert.equal(signal.householdEquity?.revisedDefinitionFrom, "2012-10-01");
  assert.match(signal.limitation, /nonprofit|private-equity|residual/);
  for (const mutate of [
    (s: Signal) => { s.unit = "$bn cash"; }, (s: Signal) => { s.metrics[0].value += 1; },
    (s: Signal) => { s.source.url = 'https://www.federalreserve.gov.evil.invalid/releases/z1/20260911/html/S1M_t.htm'; },
    (s: Signal) => { s.source.releasedAt = "2026-06-30"; },
    (s: Signal) => { s.householdEquity!.firstObservedAt = "2026-06-30T20:00:00.000Z"; },
    (s: Signal) => { s.householdEquity!.firstObservedAt = "2026-11-20T20:00:00.000Z"; },
    (s: Signal) => { s.householdEquity!.revisedDefinitionFrom = "2012-01-01" as "2012-10-01"; },
    (s: Signal) => { s.scores.daily = 0.5; }, (s: Signal) => { s.directionalInstruments = ["SPY"]; },
    (s: Signal) => { s.limitation = "Retail investors bought equities"; },
    (s: Signal) => { delete s.householdEquity; }, (s: Signal) => { s.id = "wrong-id"; },
    (s: Signal) => { if (s.householdEquity?.reviewVersion === 'fed-household-equity-v2') s.householdEquity.nativeSHA256 = '0'.repeat(64); },
    (s: Signal) => { if (s.householdEquity?.reviewVersion === 'fed-household-equity-v2') s.householdEquity.publicationEvidence.url = release.replace('.gov/', '.gov.evil.invalid/'); },
    (s: Signal) => { if (s.householdEquity?.reviewVersion === 'fed-household-equity-v2') s.householdEquity.unitEvidence.url = matrix.replace('20260911', '20261210'); },
  ]) { const changed = structuredClone(signal); mutate(changed); assert.throws(() => validateHouseholdEquity(changed), /household-equity|Household-equity/); }
});

test("normal rerun preserves first verified capture and prior snapshot, without new observation identity", async () => {
  const first = await collectSnapshot(fetcher()), before = JSON.stringify(first);
  validateSnapshot(first);
  const second = await collectSnapshot(fetcher({ [current]: html + '<!-- changed navigation -->', [dated]: html + '<!-- changed navigation -->' }), first);
  assert.equal(JSON.stringify(first), before);
  assert.deepEqual(second.signals.find(s => s.id === id)?.householdEquity, first.signals.find(s => s.id === id)?.householdEquity);
  assert.equal(observationDigest(second), observationDigest(first));
  assert.notEqual(second.signals.find(s => s.id === id)?.source.sha256, first.signals.find(s => s.id === id)?.source.sha256);
  const tampered = structuredClone(first); tampered.signals.find(s => s.id === id)!.scores.daily = 1;
  assert.throws(() => validateSnapshot(tampered), /household-equity/);
});

test("household transport failure preserves original first-capture evidence through the existing last-known path", async () => {
  const snapshot = await collectSnapshot(async () => new Response('', {status: 503}));
  const at = snapshot.cutoff;
  const signal = await collectHouseholdEquity(reader({}, at), () => at);
  const failed = await collectHouseholdEquity(async () => { throw new SourceTransportError("offline"); }, () => at, signal);
  const first = { ...snapshot, signals: snapshot.signals.map(s => s.id === id ? signal : s) };
  const later = new Date(Date.parse(at) + 1000).toISOString();
  const next = { ...snapshot, id: later.replace(/[:.]/g, "-"), issuedAt: later, cutoff: later,
    signals: snapshot.signals.map(s => s.id === id ? failed : s) };
  const kept = retainLastKnown(next, first).signals.find(s => s.id === id)!;
  assert.equal(kept.status, "available"); assert.deepEqual(kept.source, signal.source);
  assert.deepEqual(kept.householdEquity, signal.householdEquity);
});

test("a household source outage does not withhold the distinct private-credit observation", async () => {
  const credit = await readFile(new URL("./fixtures/fed-private-credit-20260911.html", import.meta.url), "utf8");
  const result = await collectSnapshot(async url => new Response(url.includes('S124_8_t.htm') ? credit : '', {status: url.includes('S124_8_t.htm') ? 200 : 503}));
  assert.equal(result.signals.find(s => s.id === id)?.status, "unavailable");
  assert.equal(result.signals.find(s => s.id === 'fed-private-credit-loans')?.status, "available");
  assert.equal(result.signals.find(s => s.id === 'fed-private-credit-loans')?.series.at(-1)?.value, 50);
});
