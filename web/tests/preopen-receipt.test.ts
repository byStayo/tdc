import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../lib/consensus/history.ts";
import { previousIssueInWitnessedIndex, recordPreopenReceipt, verifyPreopenReceipt, verifyPreopenWithMorningConfirmation } from "../lib/consensus/preopen-receipt.ts";
import type { HistoryEntry } from "../lib/consensus/types.ts";

test("prior selection tolerates later editions and rejects an omitted previous-morning issue", async t => {
  const root = await mkdtemp(join(tmpdir(), "consensus-witnessed-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "public/consensus");
  await mkdir(directory, { recursive: true });
  const indexFile = join(directory, "index.json");
  const history: HistoryEntry[] = [];
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T12:00:00.000Z") });

  async function issue(issuedAt: string) {
    const id = issuedAt.replace(/[:.]/g, "-");
    const snapshot = { id, issuedAt, engineVersion: "test" };
    const entry = { ...snapshot, sha256: digest(snapshot) };
    history.push(entry);
    const index = Buffer.from(JSON.stringify(history));
    const archive = Buffer.from(JSON.stringify(snapshot));
    await writeFile(indexFile, index);
    t.mock.timers.setTime(Date.parse(issuedAt) + 1000);
    const observedAt = new Date().toISOString();
    const session = issuedAt.slice(0, 10);
    await recordPreopenReceipt(root, session, id, archive, index, observedAt);
    return { entry, archive, session };
  }

  const early = await issue("2026-11-24T12:00:00.000Z");
  const lastPrior = await issue("2026-11-24T13:00:00.000Z");
  const current = await issue("2026-11-25T12:00:00.000Z");
  const before = "2026-11-24T14:30:00.000Z";
  const selectPrior = () => previousIssueInWitnessedIndex(root, current.session, current.entry.id,
    current.archive, new Date().toISOString(), before);
  assert.deepEqual(await selectPrior(), lastPrior.entry);
  await issue("2026-11-25T13:00:00.000Z");
  assert.deepEqual(await selectPrior(), lastPrior.entry);

  const receiptFile = join(root, ".consensus/private-preopen", current.session, current.entry.id + ".json");
  const original = await readFile(receiptFile, "utf8");
  const receipt = JSON.parse(original);
  receipt.indexText = JSON.stringify([early.entry, current.entry]);
  await writeFile(receiptFile, JSON.stringify(receipt));
  await assert.rejects(selectPrior, /archive index prefix/);

  await writeFile(receiptFile, original);
  await writeFile(indexFile, JSON.stringify(history.filter(entry => entry.id !== lastPrior.entry.id)));
  await assert.rejects(selectPrior, /archive index prefix/);
});

test("a dated public receipt survives repeat checks and cannot be reassigned to a later edition or session", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-public-receipt-"));
  try {
    const day = "2026-11-03";
    const issuedAt = "2026-11-03T13:00:31.020Z", edition = issuedAt.replace(/[:.]/g, "-");
    const snapshot = { id: edition, issuedAt, engineVersion: "test" };
    const entry = { id: edition, issuedAt, engineVersion: "test", sha256: digest(snapshot) };
    const index = Buffer.from(JSON.stringify([entry])), archive = Buffer.from(JSON.stringify(snapshot));
    const observed = "2026-11-03T14:29:48.155Z", bell = "2026-11-03T14:30:00.000Z";
    await assert.rejects(recordPreopenReceipt(root, day, edition, archive, index, bell), /pre-open window/);
    await assert.rejects(recordPreopenReceipt(root, "2026-11-04", edition, archive, index, observed), /another trading session/);
    await assert.rejects(recordPreopenReceipt(root, day, edition, archive, Buffer.from("[]"), observed), /selected public edition/);
    const [first, repeated] = await Promise.all([1, 2].map(() => recordPreopenReceipt(root, day, edition, archive, index, observed)));
    assert.deepEqual(first, repeated);
    const path = join(root, ".consensus", "private-preopen", day, edition + ".json");
    const bytes = await readFile(path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await recordPreopenReceipt(root, day, edition, archive, index, bell), first);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await verifyPreopenReceipt(root, day, edition, archive, bell), first);
    await assert.rejects(verifyPreopenReceipt(root, day, edition, Buffer.concat([archive, Buffer.from("\n")]), bell), /selected public edition/);
    await assert.rejects(verifyPreopenReceipt(root, day, edition, archive, issuedAt), /pre-open window/);
    await assert.rejects(verifyPreopenReceipt(root, day, "2026-11-03T14-00-00-000Z", archive, bell), /No pre-open/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real morning public recheck can supplement an evening witness without changing the first proof", async t => {
  const root = await mkdtemp(join(tmpdir(), "consensus-rewitness-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const session = "2026-11-24", issue = session + "T02:00:00.000Z", edition = issue.replace(/[:.]/g,"-");
  const night = session + "T02:05:00.000Z", feed = session + "T13:04:01.000Z", morning = session + "T13:04:02.000Z";
  const bell = session + "T14:30:00.000Z";
  t.mock.timers.enable({apis:["Date"],now:Date.parse(night)});
  const snapshot = {id:edition,issuedAt:issue,engineVersion:"test"}, archive = Buffer.from(JSON.stringify(snapshot));
  const entry = {id:edition,issuedAt:issue,engineVersion:"test",sha256:digest(snapshot)};
  const index = Buffer.from(JSON.stringify([entry]));
  const first = await recordPreopenReceipt(root,session,edition,archive,index,night);
  const path = join(root,".consensus/private-preopen",session,edition+".json");
  const morningPath = join(root,".consensus/private-preopen",session,"same-day",edition+".json");
  const original = await readFile(path);
  assert.deepEqual(await verifyPreopenWithMorningConfirmation(root,session,edition,archive,night),first);
  // Passing a pre-open timestamp after the bell cannot enroll a retroactive morning observation.
  t.mock.timers.setTime(Date.parse(bell));
  assert.deepEqual(await recordPreopenReceipt(root,session,edition,archive,index,feed),first);
  await assert.rejects(stat(morningPath),{code:"ENOENT"});
  t.mock.timers.setTime(Date.parse(morning));
  await assert.rejects(recordPreopenReceipt(root,session,edition,archive,Buffer.from("[]"),feed),/selected public edition/);
  const alteredHistory = Buffer.from(JSON.stringify([{...entry,id:"unwitnessed"},entry]));
  await assert.rejects(recordPreopenReceipt(root,session,edition,archive,alteredHistory,feed),/first witness/);
  const results=await Promise.all([1,2].map(()=>recordPreopenReceipt(root,session,edition,archive,index,feed)));
  assert.deepEqual(results,[first,first]);
  const second=await verifyPreopenWithMorningConfirmation(root,session,edition,archive,morning);
  assert.deepEqual(second,{...first,observedAt:morning});
  const frozen=await readFile(morningPath);
  assert.equal((await stat(morningPath)).mode&0o777,0o600);
  assert.deepEqual(await readFile(path),original);
  assert.deepEqual(await verifyPreopenReceipt(root,session,edition,archive,morning),first);
  assert.deepEqual(await verifyPreopenWithMorningConfirmation(root,session,edition,archive,feed),first);
  t.mock.timers.setTime(Date.parse(bell));
  assert.deepEqual(await recordPreopenReceipt(root,session,edition,archive,index,bell),first);
  assert.deepEqual(await readFile(morningPath),frozen);
  const forged=JSON.parse(frozen.toString()); forged.firstReceiptSha256="f".repeat(64);
  await writeFile(morningPath,JSON.stringify(forged));
  await assert.rejects(verifyPreopenWithMorningConfirmation(root,session,edition,archive,bell),/first witness/);
});


test("weekday capture only checks the saved edition's live target before entry", async () => {
  const { scheduledPreopenSession } = await import("../lib/consensus/preopen-receipt.ts");
  const target = "2026-11-24", morning = target + "T12:48:00.000Z";
  assert.equal(scheduledPreopenSession("2026-11-23T23:00:00.000Z", morning), target);
  assert.equal(scheduledPreopenSession("2026-11-24T09:39:00.000Z", morning), target);
  assert.equal(scheduledPreopenSession("2026-11-23T09:39:00.000Z", morning), null);
  assert.equal(scheduledPreopenSession("2026-11-24T09:39:00.000Z", target + "T14:30:00.000Z"), null);
  assert.equal(scheduledPreopenSession("2026-11-25T23:00:00.000Z", "2026-11-26T12:48:00.000Z"), null);
  assert.equal(scheduledPreopenSession("2026-11-25T23:00:00.000Z", "2026-11-27T12:48:00.000Z"), "2026-11-27");
});
