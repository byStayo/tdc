import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { collectPremarketNewsBatch } from "../lib/consensus/news-research.ts";

const winter = "20260105120000";
const summer = "20260701110000";

function story(batch: string, id: string, domain: string, tone: number, overrides: Record<number, string> = {}) {
  const fields = Array(27).fill("");
  fields[0] = `${batch}-${id}`;
  fields[1] = batch;
  fields[2] = "1";
  fields[3] = domain;
  fields[7] = "ECON_STOCKMARKET;OTHER_THEME";
  fields[15] = `${tone},1,1,2,3,4,100`;
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  return fields.join("\t");
}

function balancedStories(batch: string) {
  return Array.from({ length: 20 }, (_, index) =>
    story(batch, String(index + 1), `publisher${Math.floor(index / 2)}.example`, 0));
}

function archive(batch: string, stories: string[]) {
  return Buffer.from(zipSync({ [`${batch}.gkg.csv`]: strToU8(stories.join("\n")) }));
}

test("uses the fixed 07:00 New York batch and 08:00 evidence cutoff across DST", async () => {
  for (const sample of [
    { session: "2026-01-05", batch: winter, date: "Mon, 05 Jan 2026 11:50:00 GMT", batchAt: "2026-01-05T12:00:00.000Z", cutoff: "2026-01-05T13:00:00.000Z" },
    { session: "2026-07-01", batch: summer, date: "Wed, 01 Jul 2026 11:15:00 GMT", batchAt: "2026-07-01T11:00:00.000Z", cutoff: "2026-07-01T12:00:00.000Z" },
  ]) {
    const body = archive(sample.batch, balancedStories(sample.batch));
    const result = await collectPremarketNewsBatch(sample.session, async (url) => {
      assert.equal(url, `https://data.gdeltproject.org/gdeltv2/${sample.batch}.gkg.csv.zip`);
      return new Response(body, { headers: { "Last-Modified": sample.date } });
    });
    assert.equal(result.status, "available");
    assert.equal(result.batchAt, sample.batchAt);
    assert.equal(result.cutoff, sample.cutoff);
    if (result.status !== "available") assert.fail("The signed sample should qualify");
    assert.equal(result.availableAt, sample.batch === winter ? sample.batchAt : "2026-07-01T11:15:00.000Z");
    assert.equal(result.sourceSha256, createHash("sha256").update(body).digest("hex"));
  }
});

test("excludes a batch with ambiguous timing or a modification at or after cutoff", async () => {
  const body = archive(winter, balancedStories(winter));
  for (const lastModified of [null, "2026-01-05", "Mon, 05 Jan 2026 11:44:59 GMT", "Mon, 05 Jan 2026 13:00:00 GMT", "Tue, 06 Jan 2026 12:00:00 GMT"]) {
    const result = await collectPremarketNewsBatch("2026-01-05", async () => new Response(body, {
      headers: lastModified ? { "Last-Modified": lastModified } : undefined,
    }));
    assert.equal(result.status, "unverified_release");
  }
});

test("weights normalized publishers equally and discards duplicate and ineligible records", async () => {
  const ordinary = balancedStories(winter).slice(2);
  const publisher = [
    story(winter, "1", "www.Alpha.example", 10),
    story(winter, "2", " Alpha.example ", 10),
    story(winter, "21", "alpha.example", 10),
  ];
  const ineligible = [
    publisher[0],
    story(winter, "T22", "translated.example", -100),
    story(winter, "23", "other-batch.example", -100, { 1: "20260105121500" }),
    story(winter, "24", "nonweb.example", -100, { 2: "2" }),
    story(winter, "25", "theme.example", -100, { 7: "ECON_STOCKMARKETS" }),
    story(winter, "26", "short.example", -100, { 15: "-100,1,1,2,3,4,49" }),
    story(winter, "27", "bad-tone.example", 101),
  ];
  const result = await collectPremarketNewsBatch("2026-01-05", async () => new Response(
    archive(winter, [...ordinary, ...publisher, ...ineligible]),
    { headers: { "Last-Modified": "Mon, 05 Jan 2026 11:50:00 GMT" } },
  ));
  assert.equal(result.status, "available");
  if (result.status !== "available") assert.fail("The stock-market sample should qualify");
  assert.equal(result.records, 21);
  assert.equal(result.publishers, 10);
  assert.equal(result.tone, 1);
});

test("withholds tone when either sample-size floor fails", async () => {
  const records = balancedStories(winter);
  for (const stories of [records.slice(1), [...records.slice(2), story(winter, "1", "publisher1.example", 1), story(winter, "2", "publisher1.example", 1)]]) {
    const result = await collectPremarketNewsBatch("2026-01-05", async () => new Response(archive(winter, stories), {
      headers: { "Last-Modified": "Mon, 05 Jan 2026 11:50:00 GMT" },
    }));
    assert.equal(result.status, "insufficient_sample");
    assert.equal("tone" in result, false);
  }
});
