import { mkdir, readFile, writeFile, rename, lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { publicCommunity } from "./community.ts";
import { acquirePublicationLock, finishPublicationLock } from "./publication-lock.ts";
import { collectBlueskySample, privateIdentifier, type Exclusions, type BlueskySample } from "./consensus/bluesky.ts";

export type PrivateBlueskyOperation = { kind: "collect"; seconds?: number } | { kind: "publish" } | { kind: "invalidate" } | { kind: "exclude"; identifier: string };
async function privatePath(path: string, folder = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (folder ? !stat.isDirectory() : !stat.isFile()) || (!folder && stat.nlink !== 1) || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || (!folder && stat.size > 1_000_000)) throw new Error("Unsafe private storage");
}
async function loadExclusions(directory: string): Promise<Exclusions> {
  const path = resolve(directory, "exclusions.json");
  try {
    await privatePath(path);
    const result = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(result.actors) || !Array.isArray(result.records) || [...result.actors, ...result.records].some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) throw new Error("Invalid private exclusions");
    return { actors: result.actors, records: result.records };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { actors: [], records: [] }; throw error; }
}
async function savePrivate(directory: string, name: string, data: unknown) {
  const path = resolve(directory, name), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function runPrivateBluesky(root: string, operation: PrivateBlueskyOperation, collect: typeof collectBlueskySample = collectBlueskySample) {
  const directory = resolve(root, ".consensus/bluesky-private");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await privatePath(directory, true);
  const release = await acquirePublicationLock(root, "bluesky-private");
  let failure: { error: unknown } | undefined;
  try {
    const candidate = resolve(directory, "candidate.json");
    const removeCandidate = () => unlink(candidate).catch((e) => { if (e.code !== "ENOENT") throw e; });
    const exclusions = await loadExclusions(directory);
    const publicPath = resolve(root, "lib/community-current.json");
    const writeCurrent = async (value: unknown) => {
      const temporary = `${publicPath}.${process.pid}.tmp`;
      await mkdir(resolve(root, "lib"), { recursive: true });
      await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o644 });
      try { await rename(temporary, publicPath); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    };
    const withdraw = async () => {
      // Do not create a public artifact where none exists.
      try { await lstat(publicPath); await writeCurrent(null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    if (operation.kind === "publish") {
      await privatePath(candidate);
      const sample = JSON.parse(await readFile(candidate, "utf8"));
      const aggregate = publicCommunity(sample);
      await writeCurrent(aggregate);
      return { status: "aggregate-staged", sampleId: aggregate.id, deploymentRequired: true, published: false };
    }
    if (operation.kind === "invalidate") {
      await withdraw(); await removeCandidate();
      return { status: "sample-withdrawal-staged", deploymentRequired: true, published: false };
    }
    if (operation.kind === "exclude") {
      const value = operation.identifier.trim();
      const did = /^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.:%_-]+)$/;
      const uri = /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.:%_-]+))\/app\.bsky\.feed\.post\/[A-Za-z0-9._~:-]{1,512}$/;
      if (did.test(value)) exclusions.actors = [...new Set([...exclusions.actors, privateIdentifier(value)])];
      else if (uri.test(value)) exclusions.records = [...new Set([...exclusions.records, privateIdentifier(value)])];
      else throw new Error("Invalid report identifier");
      // Same kernel lock as collection: an in-flight collection cannot resurrect a removed sample.
      await withdraw(); await removeCandidate();
      await savePrivate(directory, "exclusions.json", exclusions);
      return { status: "private-exclusion-saved-and-withdrawal-staged", deploymentRequired: true, published: false };
    }
    const sample: BlueskySample = await collect({ seconds: operation.seconds, exclusions });
    await savePrivate(directory, "candidate.json", sample);
    return { status: sample.status, events: sample.receivedEvents, matchedRecords: sample.matchedRecords, participants: sample.readings.map(({ instrument, participants }) => ({ instrument, participants })), endedAt: sample.endedAt, published: false, rawContentSaved: false };
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(release, failure); }
}
