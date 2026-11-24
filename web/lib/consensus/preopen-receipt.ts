import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { outcomeWindowSessions } from "./evaluation.ts";
import { exchangeSession, exchangeSessions, hasReviewedCalendar } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";
import type { HistoryEntry, Snapshot } from "./types.ts";

export const PUBLIC_ORIGIN = "https://thedailyconsensus.com";
type Receipt = {
  version: 1; origin: string; session: string; edition: string; observedAt: string;
  archiveSha256: string; indexText: string;
};
type MorningReceipt = Receipt & { firstReceiptSha256: string; confirmedAt: string };

/** The weekday job checks the website only if its saved edition targets today's still-future open. */
export function scheduledPreopenSession(issuedAt: string, now: string) {
  if (issuedAt > now) throw Error("Local edition is dated after the publishing clock");
  const session = newYorkDate(now), issueDay = newYorkDate(issuedAt);
  if (!hasReviewedCalendar(session) || !hasReviewedCalendar(issueDay)) return null;
  const clock = exchangeSession(session);
  if (!clock || now >= clock.openAt) return null;
  return outcomeWindowSessions(issuedAt, "daily", exchangeSessions(issueDay, session))[0] === session ? session : null;
}

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

function morningFile(path: string, edition: string) {
  return resolve(dirname(path), "same-day", edition + ".json");
}

function verifyMorning(morning: MorningReceipt, prior: Receipt, session: string, edition: string, archive: Buffer) {
  const proof = verify(morning, session, edition, archive, morning.confirmedAt);
  const clock = exchangeSession(session)!;
  if (morning.firstReceiptSha256 !== digest(prior) || morning.archiveSha256 !== prior.archiveSha256 ||
      !isDeepStrictEqual(JSON.parse(morning.indexText), JSON.parse(prior.indexText)) ||
      newYorkDate(prior.observedAt) >= session || newYorkDate(morning.observedAt) !== session ||
      newYorkDate(morning.confirmedAt) !== session || morning.confirmedAt >= clock.openAt ||
      morning.observedAt <= prior.observedAt)
    throw new Error("Same-day public confirmation differs from the first witness or the pre-open window");
  // The first morning check becomes eligible only when the verifier actually completed it.
  return { ...proof, observedAt: morning.confirmedAt };
}

/** Prefer an independently verified morning recheck where a target was first observed the prior evening. */
export async function verifyPreopenWithMorningConfirmation(root: string, session: string, edition: string, archive: Buffer, asOf: string) {
  const path = file(root, session, edition);
  const prior = await readResearchReceipt<Receipt>(path);
  if (!prior) throw new Error("No pre-open public archive receipt for the selected edition");
  const first = verify(prior, session, edition, archive, asOf);
  if (newYorkDate(first.observedAt) === session) return first;
  const morning = await readResearchReceipt<MorningReceipt>(morningFile(path, edition));
  if (!morning) return first;
  const confirmed = verifyMorning(morning, prior, session, edition, archive);
  return confirmed.observedAt <= asOf ? confirmed : first;
}

async function confirmMorning(path: string, prior: Receipt, session: string, edition: string, archive: Buffer, index: Buffer, observedAt: string) {
  if (newYorkDate(prior.observedAt) === session || newYorkDate(observedAt) !== session) return;
  const confirmedAt = new Date().toISOString();
  const open = exchangeSession(session)!.openAt;
  if (newYorkDate(confirmedAt) !== session || confirmedAt >= open || observedAt >= open) return;
  const current: MorningReceipt = { version: 1, origin: PUBLIC_ORIGIN, session, edition,
    observedAt, archiveSha256: createHash("sha256").update(archive).digest("hex"), indexText: index.toString("utf8"),
    firstReceiptSha256: digest(prior), confirmedAt };
  // Recheck the freshly supplied live index and archive even when an earlier observation exists.
  verifyMorning(current, prior, session, edition, archive);
  const destination = morningFile(path, edition);
  await durableDirectory(dirname(destination), 0o700);
  const checkedAt = new Date().toISOString();
  if (checkedAt < confirmedAt) throw new Error("Public confirmation clock moved backwards");
  if (checkedAt >= open) return;
  current.confirmedAt = checkedAt;
  try { await durableJSON(destination, current, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const saved = await readResearchReceipt<MorningReceipt>(destination);
  if (!saved) throw new Error("Confirmed public archive receipt disappeared");
  const proof = verifyMorning(saved, prior, session, edition, archive);
  if (proof.observedAt > new Date().toISOString()) throw new Error("Same-day public confirmation has a future clock");
}

/** Called after live archive, index and forecast views match the release checkout. */
export async function recordPreopenReceipt(root: string, session: string, edition: string, archive: Buffer, index: Buffer, observedAt: string) {
  const path = file(root, session, edition);
  const prior = await readResearchReceipt<Receipt>(path);
  if (prior) {
    const first = verify(prior, session, edition, archive, observedAt);
    await confirmMorning(path, prior, session, edition, archive, index, observedAt);
    return first;
  }
  const receipt: Receipt = { version: 1, origin: PUBLIC_ORIGIN, session, edition, observedAt,
    archiveSha256: createHash("sha256").update(archive).digest("hex"), indexText: index.toString("utf8") };
  verify(receipt, session, edition, archive, observedAt);
  await durableDirectory(resolve(root, ".consensus/private-preopen", session), 0o700);
  try { await durableJSON(path, receipt, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = await readResearchReceipt<Receipt>(path);
    if (!concurrent) throw new Error("Original pre-open receipt disappeared");
    verify(concurrent, session, edition, archive, observedAt);
    await confirmMorning(path, concurrent, session, edition, archive, index, observedAt);
  }
  return verifyPreopenReceipt(root, session, edition, archive, new Date().toISOString());
}
