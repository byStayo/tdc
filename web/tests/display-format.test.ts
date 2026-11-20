import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { publicationNotice, signalMetricLabel } from "../lib/display-format.ts";
import { archiveDisplayTitle } from "../lib/archive-title.ts";
import { getPublishedBrief } from "../lib/published-brief.ts";

test("editorial copy polish preserves stale publication and missing-source warnings", async () => {
  const publication = JSON.parse(await readFile(new URL("../lib/published-brief.json", import.meta.url), "utf8"));
  const stale = getPublishedBrief(Date.parse(publication.createdAt) + 73 * 60 * 60 * 1000);
  assert.equal(stale.status, "stale");
  assert.equal(publicationNotice(stale.message!), stale.message);
  assert.equal(publicationNotice("The published report is unavailable."), "The published report is unavailable.");
  assert.equal(publicationNotice("A source failed; earlier observations retain their dates."), "A source failed; earlier observations retain their dates.");
  assert.ok(!publicationNotice(publication.message).includes("Codex subscription"));
});

test("rate changes display signed basis points without changing stored observations", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-04T13-16-31-369Z.json", import.meta.url), "utf8"));
  const before = JSON.stringify(snapshot);
  for (const [id, level, change] of [["fred-DGS2", "4.59%", "+3 bp"], ["fred-DGS10", "4.91%", "-3 bp"], ["fred-EFFR", "3.88%", "0 bp"]]) {
    const signal = snapshot.signals.find((item: { id: string }) => item.id === id);
    assert.equal(signalMetricLabel(signal.metrics[0], signal.family), level);
    assert.equal(signalMetricLabel(signal.metrics[1], signal.family), change);
  }
  assert.equal(JSON.stringify(snapshot), before);
});

test("display precision preserves small FX values and does not convert non-rate percentages into bp", () => {
  const metric = { label: "Change", value: 1.25, unit: "%", date: "2026-11-03" };
  assert.equal(signalMetricLabel(metric, "earnings"), "+1.25%");
  assert.equal(signalMetricLabel({ ...metric, label: "Net / open interest", value: 13.3496 }, "institutions"), "13.35%");
  assert.equal(signalMetricLabel({ ...metric, label: "1 JPY in USD", value: .006317603842893473, unit: "USD" }, "fx"), "0.006318 USD");
  assert.equal(signalMetricLabel({ ...metric, value: -.00000000001, unit: "bp" }, "rates"), "0 bp");
  assert.equal(signalMetricLabel({ ...metric, value: Number.NaN }, "rates"), "—");
});

test("only three verified title fragments are omitted, with original archive records unchanged", async () => {
  const articles = JSON.parse(await readFile(new URL("../lib/archive-content.json", import.meta.url), "utf8")) as { id: string; title: string }[];
  const before = JSON.stringify(articles);
  const changed = articles.filter(article => archiveDisplayTitle(article) !== article.title);
  assert.deepEqual(changed.map(article => article.id).sort(), ["wordpress-478", "wordpress-480", "wordpress-483"]);
  for (const article of changed) assert.ok(article.title.endsWith(archiveDisplayTitle(article)));
  assert.equal(JSON.stringify(articles), before);
  assert.equal(archiveDisplayTitle({ id: "wordpress-483", title: "A corrected source title" }), "A corrected source title");
  assert.equal(archiveDisplayTitle({ id: "another-id", title: "precedent. Keep this title" }), "precedent. Keep this title");
});
