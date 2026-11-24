import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { digest } from "../lib/consensus/history.ts";
import { COMPLETED_EVALUATIONS, EVALUATION_RELEASE_STATE, PRIVATE_OUTCOME_LEDGER, PUBLIC_OUTCOME_INDEX } from "../lib/consensus/outcome-ledger.ts";
import { readRetailOutcomeClocks } from "../lib/consensus/retail-outcome-clocks.ts";
import { durableJSON } from "../lib/publication-storage.ts";

test("monthly availability reads only header-bound metadata for the committed public identity slots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "retail-clock-metadata-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  const id = "a9386805-748e-4196-8a00-03a850916df2";
  const index = ["SPY", "IWM"].map(instrument => ({
    snapshotId: "2026-11-18T13-00-00-000Z", instrument, horizon:"daily", engineVersion:"consensus-rules-2.0.0"
  }));
  const relative = ".consensus/private-evaluation/label-availability.json";
  const sidecar = join(root, relative), journal = join(root, COMPLETED_EVALUATIONS, id + ".json");
  await mkdir(dirname(journal), {mode:0o700, recursive:true});
  await mkdir(dirname(sidecar), {mode:0o700, recursive:true});
  const ledger = ["An opaque fixture. This private outcome file is deliberately never created."];
  const times = ["2026-11-19T03:00:00.000Z", "2026-11-23T10:15:30.000Z"];
  const meta = { schemaVersion:1, ledgerSha256:digest(ledger), knownAt:times };
  const state = { status:"complete", outcomeLedgerTransactionId:id, hashes:{[PUBLIC_OUTCOME_INDEX]:digest(index)} };
  await durableJSON(join(root,EVALUATION_RELEASE_STATE),state);
  const header = async (clock?: unknown, publicHash = digest(index), ledgerHash = digest(ledger)) => {
    const writes: {path:string; value:unknown; before:null; after:string}[] = [
      {path:PUBLIC_OUTCOME_INDEX, value:index, before:null, after:publicHash},
      {path:PRIVATE_OUTCOME_LEDGER, value:ledger, before:null, after:ledgerHash}
    ];
    if (clock) writes.push({path:relative, value:clock, before:null, after:digest(clock)});
    await durableJSON(journal, {schemaVersion:1, id, createdAt:"2026-11-24T15:00:00.000Z", writes});
  };
  const read = () => readRetailOutcomeClocks(root,index,id);
  await header();
  assert.equal(await read(),null);
  await durableJSON(sidecar,meta);
  await assert.rejects(read, /Unsealed/);
  await header(meta);
  assert.deepEqual(await read(),times);
  await assert.rejects(readRetailOutcomeClocks(root,index.toReversed(),id), /current completed outcome index/);
  await assert.rejects(readRetailOutcomeClocks(root,index,"505c54ae-c518-45ed-9a1d-a5bdfe3d5b00"), /current completed/);
  await header(meta, "1".repeat(64));
  await assert.rejects(read, /public identities/);
  await header(meta, digest(index), "2".repeat(64));
  await assert.rejects(read, /completed ledger and public index/);
  await header(meta);
  await durableJSON(sidecar, {...meta,knownAt:times.toReversed()});
  await assert.rejects(read, /completed ledger and public index/);
  for (const bad of [{...meta,knownAt:[times[0]]}, {...meta,knownAt:[times[0],"2026-11-23"]}, {...meta,extra:1}]) {
    await durableJSON(sidecar,bad);
    await header(bad);
    await assert.rejects(read,/completed ledger and public index/);
  }
  await durableJSON(sidecar,meta);
  await header(meta);
  await chmod(sidecar,0o644);
  await assert.rejects(read, /owner-only metadata/);
  await unlink(sidecar);
  await assert.rejects(read, /Missing sealed/);
  await symlink(journal,sidecar);
  await assert.rejects(read, {code:"ELOOP"});
});
