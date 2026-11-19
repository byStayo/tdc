import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { outcomeWindowSessions } from "./evaluation.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";
import type { HistoryEntry, Snapshot } from "./types.ts";

export const PUBLIC_ORIGIN = "https://thedailyconsensus.com";
type Receipt = {
  version: 1; origin: string; session: string; edition: string; observedAt: string;
  archiveSha256: string; indexText: string;
};

function file(root: string, session: string, edition: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(session) || !/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(edition))
    throw new Error("Invalid pre-open receipt identity");
  return resolve(root, ".consensus/private-preopen", session, edition + ".json");
}

function verify(receipt: Receipt, session: string, edition: string, archive: Buffer, asOf: string) {
  const market = exchangeSession(session);
  const snapshot = JSON.parse(archive.toString("utf8")) as Snapshot;
  const index = JSON.parse(receipt.indexText) as HistoryEntry[];
  const last = index.at(-1);
  if (!market || receipt.version !== 1 || receipt.origin !== PUBLIC_ORIGIN || receipt.session !== session ||
      receipt.edition !== edition || snapshot.id !== edition || last?.id !== edition ||
      last.issuedAt !== snapshot.issuedAt || last.sha256 !== digest(snapshot) ||
      last.engineVersion !== snapshot.engineVersion ||
      receipt.archiveSha256 !== createHash("sha256").update(archive).digest("hex"))
    throw new Error("Pre-open receipt differs from the selected public edition");
  if (!Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf ||
      !Number.isFinite(Date.parse(receipt.observedAt)) || new Date(receipt.observedAt).toISOString() !== receipt.observedAt ||
      receipt.observedAt < snapshot.issuedAt || receipt.observedAt > asOf || receipt.observedAt >= market.openAt)
    throw new Error("No public observation within the pre-open window");
  const dates = exchangeSessions(newYorkDate(snapshot.issuedAt), session);
  if (outcomeWindowSessions(snapshot.issuedAt, "daily", dates)[0] !== session)
    throw new Error("Pre-open archive targets another trading session");
  return { observedAt: receipt.observedAt, edition, archiveSha256: receipt.archiveSha256 };
}

export async function verifyPreopenReceipt(root: string, session: string, edition: string, archive: Buffer, asOf: string) {
  const receipt = await readResearchReceipt<Receipt>(file(root, session, edition));
  if (!receipt) throw new Error("No pre-open public archive receipt for the selected edition");
  return verify(receipt, session, edition, archive, asOf);
}

/** Called after live archive, index and forecast views match the release checkout. */
export async function recordPreopenReceipt(root: string, session: string, edition: string, archive: Buffer, index: Buffer, observedAt: string) {
  const path = file(root, session, edition);
  const prior = await readResearchReceipt<Receipt>(path);
  if (prior) return verify(prior, session, edition, archive, observedAt);
  const receipt: Receipt = { version: 1, origin: PUBLIC_ORIGIN, session, edition, observedAt,
    archiveSha256: createHash("sha256").update(archive).digest("hex"), indexText: index.toString("utf8") };
  verify(receipt, session, edition, archive, observedAt);
  await durableDirectory(resolve(root, ".consensus/private-preopen", session), 0o700);
  try { await durableJSON(path, receipt, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return verifyPreopenReceipt(root, session, edition, archive, new Date().toISOString());
}
