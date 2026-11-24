import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { compareOptionVolume, OPTION_VOLUME_COMPARISON_METHOD, OPTION_VOLUME_COMPARISON_URL,
  optionVolumeQuery, type VolumePair } from "../lib/consensus/option-volume-agreement.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { sourceChunk, sourceResponse } from "../lib/consensus/source-failure.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const flags = process.argv.slice(2);
const dates = flags.filter(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg));
if (dates.length > 1 || flags.some(arg => !dates.includes(arg) && !["--cached-only", "--require-agreement"].includes(arg)))
  throw new Error("Usage: node --experimental-strip-types scripts/research-option-volume-agreement.ts [YYYY-MM-DD] [--cached-only] [--require-agreement]");

type Receipt = { method: string; source: string; capturedAt: string; text: string; sha256: string };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
async function acquire(sql: string): Promise<Receipt> {
  const response = await sourceResponse(fetch, OPTION_VOLUME_COMPARISON_URL, {
    method: "POST", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(25000),
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ sql }),
  });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error("Unexpected independent options response type");
    for (;;) {
      const item = await sourceChunk(reader);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 64000) throw new Error("Independent options response exceeds its limit");
      chunks.push(item.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return { method: OPTION_VOLUME_COMPARISON_METHOD, source: OPTION_VOLUME_COMPARISON_URL,
    capturedAt: new Date().toISOString(), text, sha256: sha256(text) };
}

const { current, snapshots } = await verifyPublicationTree(root);
const edition = dates.length ? snapshots.findLast(s => s.optionActivity?.session === dates[0]) : current;
const sample = edition?.optionActivity;
if (!sample || !edition) throw new Error("No archived options activity for the requested session");
const session = sample.session;
const pairs: VolumePair[] = [];
const observed = sample.rows.filter(row => row.status === "observed");
for (const row of observed) {
  const file = resolve(root, ".consensus/private-opra-volume", sample.session, row.symbol + ".json");
  const pair = await readResearchReceipt<VolumePair & { session: string; expiry: string }>(file);
  if (!pair || digest(pair) !== row.receipt || pair.symbol !== row.symbol || pair.session !== sample.session || pair.expiry !== sample.expiry)
    throw new Error(`The private ${row.symbol} pair does not match its archived evidence identifier`);
  pairs.push(pair);
}
if (!pairs.length) throw new Error("The archived options sample contains no contract pair to compare");
const query = optionVolumeQuery(sample.session, pairs);
const folder = resolve(root, ".consensus/private-opra-volume-comparison", sample.session);
const file = resolve(folder, digest({ method: OPTION_VOLUME_COMPARISON_METHOD, receipts: observed.map(row => row.receipt) }) + ".json");
const cached = await readResearchReceipt<Receipt>(file);
if (!cached && flags.includes("--cached-only")) throw new Error("No complete private comparison has been saved for these archived pairs");
let receipt = cached ?? await acquire(query.sql);
const lastPrimaryCapture = observed.reduce((last, row) => row.capturedAt > last ? row.capturedAt : last, "");
function replay(evidence: Receipt) {
  if (evidence.method !== OPTION_VOLUME_COMPARISON_METHOD || evidence.source !== OPTION_VOLUME_COMPARISON_URL ||
      typeof evidence.text !== "string" || Buffer.byteLength(evidence.text) > 64000 || sha256(evidence.text) !== evidence.sha256 ||
      !Number.isFinite(Date.parse(evidence.capturedAt)) || new Date(evidence.capturedAt).toISOString() !== evidence.capturedAt ||
      evidence.capturedAt < lastPrimaryCapture || evidence.capturedAt > new Date().toISOString())
    throw new Error("Invalid independent options receipt");
  return compareOptionVolume(session, pairs, evidence.text);
}
let results = replay(receipt);
if (!cached && results.every(row => row.status !== "incomplete")) {
  await durableDirectory(folder, 0o700);
  try { await durableJSON(file, receipt, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await readResearchReceipt<Receipt>(file);
    if (!saved) throw error;
    receipt = saved;
    results = replay(receipt);
  }
}
console.log(JSON.stringify({ scope: "private-as-issued-option-volume-agreement", edition: edition.id, session: sample.session,
  expiry: sample.expiry, capturedAt: receipt.capturedAt, observedPairs: pairs.length,
  outsideComparison: sample.rows.filter(row => row.status !== "observed").map(row => ({ symbol: row.symbol, status: row.status })),
  results }, null, 2));
if (flags.includes("--require-agreement") && results.some(row => row.status !== "matched")) process.exitCode = 2;
