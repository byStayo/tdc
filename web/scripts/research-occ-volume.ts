import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession } from "../lib/consensus/kibot.ts";
import { PROSPECTIVE_MINIMUM } from "../lib/consensus/learning-audit.ts";
import {
  collectOccVolume, occCapturePrecedesOutcome, OCC_VOLUME_SYMBOLS, previousOccSession,
  validateOccVolumeCapture,
} from "../lib/consensus/occ-volume.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import type { OccVolumeCapture } from "../lib/consensus/occ-volume.ts";
import type { Outcome } from "../lib/consensus/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-occ-volume");
const args = process.argv.slice(2);
const probeOnly = args[0] === "--probe-only";
if (probeOnly) args.shift();
if (args.length && (args.length !== 2 || args[0] !== "--kibot-web-root" || !isAbsolute(args[1])))
  throw new Error("Usage: research-occ-volume.ts [--probe-only] [--kibot-web-root /absolute/web/root]");
const ledgerRoot = args[1] ?? root;
const activityDate = previousOccSession(new Date().toISOString());
const capturePath = (day: string) => resolve(directory, day + ".json");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function loadCapture(day: string): Promise<OccVolumeCapture | undefined> {
  try {
    return validateOccVolumeCapture(JSON.parse(await readFile(capturePath(day), "utf8")), day);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function saveCapture(capture: OccVolumeCapture) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, randomUUID() + ".tmp");
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(capture, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, capturePath(capture.activityDate));
      return { capture, status: "captured" };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await loadCapture(capture.activityDate);
      if (!existing) throw new Error("Concurrent OCC receipt disappeared");
      return { capture: existing, status: "retained" };
    }
  } finally {
    await unlink(temporary);
  }
}

async function countPairedSessions() {
  let ledger: { schemaVersion: number; outcomes: Outcome[] };
  try {
    ledger = JSON.parse(await readFile(resolve(ledgerRoot, ".consensus/private-kibot/evaluation.json"), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "private-kibot-ledger-unavailable" };
    throw error;
  }
  const { snapshots } = await verifyPublicationTree(ledgerRoot);
  const byId = new Map(snapshots.map(row => [row.id, row]));
  if (ledger?.schemaVersion !== 2 || !Array.isArray(ledger.outcomes) ||
      ledger.outcomes.some((row) => {
        const snapshot = byId.get(row?.snapshotId);
        if (!snapshot || row.horizon !== "daily" || row.engineVersion !== snapshot.engineVersion ||
            row.issuedAt !== snapshot.issuedAt ||
            !OCC_VOLUME_SYMBOLS.some(symbol => symbol === row.instrument)) return true;
        const session = exchangeSession(newYorkDate(row.entryAt));
        return row.entryAt !== session?.openAt || row.exitAt !== session?.closeAt;
      }))
    throw new Error("Private Kibot ledger differs from the verified editions or session calendar");

  const captures = new Map<string, OccVolumeCapture>();
  for (const file of await readdir(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const day = file.slice(0, 10);
    const capture = await loadCapture(day);
    if (capture) captures.set(day, capture);
  }
  const { policy, selected } = selectScoredOutcomes(ledger.outcomes
    .filter(row => isFullKibotSession(row.entryAt, row.exitAt)));
  const groups = OCC_VOLUME_SYMBOLS.map((symbol) => {
    const sessions = selected.filter(row => row.instrument === symbol);
    const matchedDays = new Set<string>();
    for (const outcome of sessions) {
      const day = previousOccSession(outcome.entryAt);
      const capture = captures.get(day);
      const cutoff = byId.get(outcome.snapshotId)!.cutoff;
      if (capture && occCapturePrecedesOutcome(capture, cutoff, outcome.entryAt))
        matchedDays.add(day);
    }
    return { symbol, selectedSessions: sessions.length, pairedDistinctDates: matchedDays.size };
  });
  return {
    status: groups.every(row => row.pairedDistinctDates >= PROSPECTIVE_MINIMUM)
      ? "count-threshold-met" : "insufficient-prospective-pairs",
    policy, minimumDistinctDates: PROSPECTIVE_MINIMUM, groups,
  };
}

// The source explicitly documents these narrow scripted queries. The only
// retained evidence is private research totals and the receipt for each query.
// No source CSV, public artifacts, model weights or holdouts are changed.
const existing = probeOnly ? undefined : await loadCapture(activityDate);
const result = existing ? { capture: existing, status: "retained" } : probeOnly
  ? { capture: await collectOccVolume(activityDate), status: "checked-without-retaining" }
  : await saveCapture(await collectOccVolume(activityDate));
console.log(JSON.stringify({
  scope: "private-research-only", status: result.status,
  activityDate, capturedAt: result.capture.capturedAt,
  reports: result.capture.reports.map(({ symbol, rows, customerCalls, customerPuts }) =>
    ({ symbol, rows, customerCalls, customerPuts })),
  pairing: probeOnly ? { status: "not-requested" } : await countPairedSessions(),
}, null, 2));
