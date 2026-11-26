import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertPublicURL, collectEditorialEvidence } from "../scripts/collect-editorial-evidence.ts";
import { collectFedMinutes, validateFedMinutesSource, type FedMinutesData } from "../lib/fed-minutes-editorial.ts";
import { validateEditorialPublication } from "../scripts/publish-editorial-brief.ts";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const feedURL = "https://www.federalreserve.gov/feeds/press_monetary.xml";
const releaseURL = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261118a.htm";
const minutesURL = "https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm";
const now = Date.parse("2026-11-19T12:00:00.000Z");
const feed = `<rss><channel><item><title>Minutes of the Federal Open Market Committee, October 27-28, 2026</title><link><![CDATA[${releaseURL}]]></link><pubDate><![CDATA[Wed, 18 Nov 2026 19:00:00 GMT]]></pubDate></item></channel></rss>`;
const release = `<p class="article__time">November 18, 2026</p><h3 class="title">Minutes of the Federal Open Market Committee, October 27-28, 2026</h3><p class="releaseTime">For release at 2:00 p.m. EST <div><span>Share</span></div><p>Original release.</p><a href="/monetarypolicy/fomcminutes20261028.htm">HTML</a>`;
const minutes = `<div id="article"><h3>Minutes of the Federal Open Market Committee</h3><p><strong>October 27–28, 2026</strong></p><p>${"Synthetic discussion of financial conditions and monetary policy. ".repeat(20)}</p></div><a id="back-top"></a>`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const documents = { [feedURL]: feed, [releaseURL]: release, [minutesURL]: minutes };
const reader = (changes: Record<string, string> = {}) => async (url: string) => {
  const text = { ...documents, ...changes }[url];
  if (text === undefined) throw Error("Unexpected source URL");
  return { text, sha256: hash(text), retrievedAt: new Date(now).toISOString() };
};

test("future editorial preparation collects a bounded official minutes release with independent publication and meeting dates", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const calls: string[] = [];
  const evidence = await collectEditorialEvidence(async (input, init) => {
    const url = String(input); calls.push(url);
    assert.equal(init?.redirect, "error");
    if (url === feedURL) return new Response(feed);
    if (url === releaseURL) return new Response(release);
    if (url === minutesURL) return new Response(minutes);
    return new Response("Other collector unavailable", { status: 503 });
  });
  const source = evidence.sources.find(source => source.id === "FED_FOMC_MINUTES");
  assert.equal(source?.status, "ok");
  assert.equal(source?.kind, "fed_minutes");
  assert.equal(source?.url, releaseURL);
  assert.equal(source?.retrievalUrl, minutesURL);
  assert.deepEqual(source?.observationDates, ["2026-11-18"]);
  const data = source!.data as { publishedAt: string; meetingStartedOn: string; meetingEndedOn: string;
    catalog: { sha256: string }; release: { sha256: string }; minutes: { sha256: string }; usage: { scope: string } };
  assert.equal(data.publishedAt, "2026-11-18T19:00:00.000Z");
  assert.equal(data.meetingStartedOn, "2026-10-27");
  assert.equal(data.meetingEndedOn, "2026-10-28");
  assert.deepEqual([data.catalog.sha256, data.release.sha256, data.minutes.sha256], [hash(feed), hash(release), hash(minutes)]);
  assert.equal(data.usage.scope, "editorial-context-only");
  assert.equal(Object.hasOwn(source!.data as object, "text"), false, "the public manifest must not archive the full minutes");
  assert.ok((source!.data as { excerpt: string }).excerpt.length <= 1200);
  assert.equal(calls.filter(url => new URL(url).hostname === "www.federalreserve.gov").length, 3);
  assert.equal(evidence.sources.find(source => source.id === "SEC_MSFT")?.status, "unavailable");
});

test("Fed editorial URLs require exact official hosts and a bounded source path", () => {
  assert.equal(assertPublicURL(releaseURL), releaseURL);
  for (const url of [releaseURL.replace("www.federalreserve.gov", "www.federalreserve.gov.evil.example"),
    releaseURL.replace("https://", "http://"), releaseURL + "?key=secret", releaseURL + "#fragment",
    "https://www.federalreserve.gov/other.htm"])
    assert.throws(() => assertPublicURL(url));
});

test("missing clocks, future releases, impostor links and contradictory meeting identities stay unavailable", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const cases: Record<string, string>[] = [
    { [feedURL]: feed.replace(/<pubDate>[\s\S]*?<\/pubDate>/, "") },
    { [feedURL]: feed.replace("18 Nov 2026 19:00:00", "20 Nov 2026 19:00:00") },
    { [releaseURL]: release.replace("For release at 2:00 p.m. EST", "For immediate release") },
    { [releaseURL]: release.replace("2:00 p.m. EST", "2:00 p.m. EDT") },
    { [feedURL]: feed.replace(releaseURL, releaseURL.replace("federalreserve.gov", "federalreserve.gov.evil.example")) },
    { [releaseURL]: release.replace('href="/monetarypolicy/', 'href="https://www.federalreserve.gov.evil.example/monetarypolicy/') },
    { [minutesURL]: minutes.replace("October 27–28", "October 26–27") },
  ];
  for (const change of cases) {
    const source = await collectFedMinutes(reader(change));
    assert.equal(source.status, "unavailable"); assert.equal(source.data, null);
  }
  assert.equal((await collectFedMinutes(reader(), "2026-11-18T18:59:59.000Z")).status, "unavailable");
  for (const failed of [feedURL, releaseURL, minutesURL]) {
    const original = reader();
    assert.equal((await collectFedMinutes(async url => { if (url === failed) throw Error("Synthetic outage"); return original(url); })).status, "unavailable");
  }
});

test("a Fed outage leaves unrelated editorial sources available", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const evidence = await collectEditorialEvidence(async input => {
    const url = new URL(input);
    if (url.hostname === "fred.stlouisfed.org") return new Response(`observation_date,${url.searchParams.get("id")}\n2026-11-18,3.75\n`);
    throw Error("Synthetic provider outage");
  });
  assert.equal(evidence.sources.find(source => source.id === "FED_FOMC_MINUTES")?.status, "unavailable");
  assert.equal(evidence.sources.find(source => source.id === "FRED_RATE")?.status, "ok");
});

test("the publication guard binds clocks, hashes, host identity, allowance and manifest cutoff", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const source = await collectFedMinutes(reader());
  const evidence = { schemaVersion: 1, scope: "market", collectedAt: new Date(now).toISOString(), sources: [source], limitations: ["Earlier meeting context."] };
  const candidate = { status: "ok", scope: "market", createdAt: evidence.collectedAt, model: "Codex editorial workflow",
    message: "Official meeting context.", data: { headline: "Minutes released", summary: "The release describes an earlier meeting.",
      bull: [], bear: [], watch: [{ text: "Read the original minutes in their meeting context.", sourceIds: [source.id] }], limitations: ["Descriptive context."] },
    sources: [{ id: source.id, title: source.title, url: source.url }] };
  assert.equal(validateEditorialPublication(candidate, evidence, now).brief.scope, "market");
  const mutations: ((data: FedMinutesData) => void)[] = [
    data => { data.publishedAt = "2026-11-20T19:00:00.000Z"; },
    data => { data.cutoff = "2026-11-18T18:59:59.000Z"; },
    data => { data.releaseClock = ""; },
    data => { data.release.sha256 = "missing"; },
    data => { data.minutes.url = minutesURL.replace("20261028", "20261027"); },
    data => { data.meetingEndedOn = "2026-11-20"; },
    data => { Object.assign(data, { text: "Private full minutes must not appear here.".repeat(500) }); },
    data => { Object.assign(data, { usage: { ...data.usage, scope: "forecast-input" } }); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(source); mutate(changed.data as FedMinutesData);
    assert.throws(() => validateEditorialPublication(candidate, { ...evidence, sources: [changed] }, now));
  }
  assert.throws(() => validateFedMinutesSource({ ...source, kind: "bls" }, now));
  assert.throws(() => validateEditorialPublication(candidate, { ...evidence, collectedAt: "2026-11-19T11:59:59.000Z" }, now));
});

test("the review command writes separate enriched evidence and preserves the original packet and pinned consensus draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-fed-editorial-review-"));
  try {
    await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
    await mkdir(join(root, "scripts")); await mkdir(join(root, ".editorial"), { mode: 0o700 }); await mkdir(join(root, ".consensus"), { mode: 0o700 });
    await cp(new URL("../scripts/collect-editorial-evidence.ts", import.meta.url), join(root, "scripts/collect-editorial-evidence.ts"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const originalPath = join(root, ".editorial/evidence-2026-11-19.json"), draft = join(root, ".consensus/last-collection.json");
    const original = JSON.stringify({ schemaVersion: 1, scope: "market", collectedAt: "2026-11-19T11:50:00.000Z",
      sources: [], limitations: ["Synthetic pinned packet."] });
    await writeFile(originalPath, original, { mode: 0o600 }); await writeFile(draft, "pinned synthetic draft", { mode: 0o600 });
    const control = `const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${now}]));}static now(){return ${now}}};const docs=${JSON.stringify(documents)};globalThis.fetch=async url=>{if(!Object.hasOwn(docs,String(url)))throw Error('Unexpected network');return new Response(docs[String(url)])};`;
    const result = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript," + encodeURIComponent(control),
      "scripts/collect-editorial-evidence.ts", "--enrich-fed-minutes", originalPath], { cwd: root, encoding: "utf8" }));
    assert.notEqual(result.output, originalPath);
    assert.equal(await readFile(originalPath, "utf8"), original);
    assert.equal(await readFile(draft, "utf8"), "pinned synthetic draft");
    const enriched = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(enriched.sources[0].status, "ok");
    assert.equal(enriched.sources[0].data.publishedAt, "2026-11-18T19:00:00.000Z");
    assert.equal(enriched.collectedAt, "2026-11-19T12:00:00.000Z");
    assert.equal(Object.hasOwn(enriched.sources[0].data, "text"), false);
    const captures = join(root, ".editorial/fed-minutes/captures"), files = await readdir(captures);
    assert.equal(files.length, 3);
    const privateMinutes = (await Promise.all(files.map(async file => {
      assert.equal((await stat(join(captures, file))).mode & 0o077, 0);
      return JSON.parse(await readFile(join(captures, file), "utf8"));
    }))).find(capture => capture.url === minutesURL);
    assert.equal(privateMinutes.text, minutes);
    assert.equal(hash(privateMinutes.text), privateMinutes.sha256);
    assert.ok(privateMinutes.normalizedText.length > enriched.sources[0].data.excerpt.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
