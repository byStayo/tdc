import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateKibotResearch } from "../lib/consensus/kibot-research.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";

test("the shipped research aggregate is anchored to the archive and rejects source values at every level", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const report = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  validateKibotResearch(report, history[0]);
  for (const changed of [
    { ...report, outcomes: [{ entry: 1, exit: 2 }] },
    { ...report, daily: [{ ...report.daily[0], returnPct: 0.2 }, ...report.daily.slice(1)] },
    ...[{ weights: [0.1] }, { modelBrier: 0.250012 }, { testSamples: 1 }].map(fields => ({
      ...report, studies: [{ ...report.studies[0], ...fields }, ...report.studies.slice(1)],
    })),
    { ...report, firstEdition: history[1].id },
  ]) {
    assert.throws(() => validateKibotResearch(changed, history[0]), /reviewed aggregate schema/);
  }
});
