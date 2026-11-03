import type { HistoryEntry, Snapshot } from "./types.ts";

/** Display-only provenance. Never change an archived edition to annotate a reissue. */
export function editionTiming(snapshot: Snapshot, history: HistoryEntry[]) {
  const checks = snapshot.signals.flatMap(({ source }) => {
    // An unavailable adapter's attempted fetch does not establish collection.
    if (!source.sha256 || !source.observedAt || !Number.isFinite(Date.parse(source.retrievedAt)) ||
        new Date(source.retrievedAt).toISOString() !== source.retrievedAt ||
        source.retrievedAt > snapshot.cutoff) return [];
    return [source.retrievedAt];
  }).sort();
  const latestSourceCheck = checks.at(-1) ?? null;
  const previous = history.filter(entry => entry.issuedAt < snapshot.issuedAt)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
  return {
    latestSourceCheck,
    // Require the last checked evidence to predate the previous edition too:
    // a version bump accompanied by fresh collection is not called a reissue.
    methodologyReissue: Boolean(previous && previous.engineVersion !== snapshot.engineVersion &&
      latestSourceCheck && latestSourceCheck <= previous.issuedAt),
    ruleLabel: snapshot.engineVersion.replace("consensus-rules-", "rules "),
  };
}
