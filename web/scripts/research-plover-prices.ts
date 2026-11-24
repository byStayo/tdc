import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { digest } from "../lib/consensus/history.ts";
import { boundaryClock } from "../lib/consensus/market-history-boundaries.ts";
import { capturePlover, comparePloverTlt, decodePlover, ploverDays, ploverDelayPassed, type PloverCapture, type TltResearchControls } from "../lib/consensus/plover-price-research.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const [from, through, ...options] = process.argv.slice(2);
const flags = options.filter(a => a !== "--refresh");
if (!from || !through || options.filter(a => a === "--refresh").length > 1 ||
    (flags.length && (flags.length !== 2 || flags[0] !== "--reuse-controls" || !/^[a-f0-9]{64}$/.test(flags[1]))))
  throw new Error("Use FROM THROUGH [--reuse-controls SHA256] [--refresh] for a private comparison");
const days = ploverDays(from, through);
if (Date.parse(boundaryClock(days.at(-1)!)!.closeAt) >= Date.now()) throw new Error("Use completed exchange sessions");
const cutoff = new Date().toISOString();
const sourceThrough = days.filter(day => ploverDelayPassed(day, cutoff)).at(-1);
if (!sourceThrough) throw new Error("Awaiting the publisher's 24-hour release delay");
const root = fileURLToPath(new URL("../", import.meta.url));
const dir = resolve(root, ".consensus/private-plover");
await durableDirectory(dir, 0o700);
const index = resolve(dir, "captures", from + "-" + sourceThrough);
await durableDirectory(index, 0o700);

async function pin<T>(value: T) {
  const id = digest(value), file = resolve(dir, id + ".json");
  const existing = await readResearchReceipt<T>(file);
  if (!existing) {
    try { await durableJSON(file, value, true); }
    catch (error) {
      const parallel = await readResearchReceipt<T>(file);
      if (!parallel || digest(parallel) !== id) throw error;
    }
  } else if (digest(existing) !== id) throw new Error("Plover evidence differs from its private receipt");
  return id;
}

const prior = (await readdir(index)).filter(file => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z_[a-f0-9]{64}\.json$/.test(file)).sort().at(-1);
let original: PloverCapture | null = null;
let stillDelivering = false;
if (prior) {
  const id = prior.split("_")[1].slice(0, 64);
  original = await readResearchReceipt<PloverCapture>(resolve(dir, id + ".json"));
  const pointer = await readResearchReceipt<{ capture: string }>(resolve(index, prior));
  if (!original || pointer?.capture !== id || digest(original) !== id ||
      original.capturedAt.replaceAll(":", "-") !== prior.split("_")[0]) throw new Error("Missing or altered pinned Plover observation");
  const retained = decodePlover(original, "TLT", from, sourceThrough, new Date().toISOString());
  // A provider-lagged range is retried on a later run, while an immediate replay uses the pinned evidence.
  stillDelivering = retained.length < ploverDays(from, sourceThrough).length && Date.now() - Date.parse(original.capturedAt) >= 3_600_000;
}
if (!original || stillDelivering || options.includes("--refresh")) original = await capturePlover("TLT", from, sourceThrough);
const bars = decodePlover(original, "TLT", from, sourceThrough, new Date().toISOString());
const capture = await pin(original);
const filename = original.capturedAt.replaceAll(":", "-") + "_" + capture + ".json";
const pointer = resolve(index, filename);
if (!await readResearchReceipt(pointer)) {
  try { await durableJSON(pointer, { capture }, true); }
  catch (error) { if ((await readResearchReceipt<{ capture: string }>(pointer))?.capture !== capture) throw error; }
}

let controlsHash = flags[1];
if (!controlsHash) {
  // This mode of the existing witness collector reads only public price/cash references, without signed hourly requests.
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types",
    resolve(root, "scripts/research-market-history-boundaries.ts"), from, through, "--controls"], { cwd: root, timeout: 180_000 });
  controlsHash = JSON.parse(stdout).receipt;
}
if (!/^[a-f0-9]{64}$/.test(controlsHash)) throw new Error("Invalid research control receipt");
const controls = await readResearchReceipt<TltResearchControls>(resolve(root, ".consensus/private-market-history/tlt-settlement", controlsHash + ".json"));
if (!controls || digest(controls) !== controlsHash) throw new Error("The original private comparison receipt changed");
const comparison = comparePloverTlt(bars, controls, from, through);
const result = { ...comparison, sourceThrough, capture, controls: controlsHash, issuer: controls.issuer,
  source: original.source, reviewedSourceBytes: original.sha256, capturedAt: original.capturedAt };
const receipt = await pin(result);
console.log(JSON.stringify({ ...comparison, sourceThrough, receipt }, null, 2));
