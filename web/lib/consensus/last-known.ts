import type { Snapshot } from "./types.ts";
import { validateSnapshot } from "./history.ts";

/** Preserve dated evidence through a transient source failure without refreshing its age. */
export function retainLastKnown(
  snapshot: Snapshot,
  previous: Snapshot,
): Snapshot {
  validateSnapshot(previous, "archive");
  if (previous.issuedAt >= snapshot.issuedAt)
    throw new Error("Previous edition must precede collection");
  let retainedNews = false;
  const retainedHoldings = new Set<string>();
  const signals = snapshot.signals.map((signal) => {
    if (signal.status !== "unavailable" || signal.failureKind !== "transport") return signal;
    const prior = previous.signals.find((item) => item.id === signal.id);
    if (
      !prior ||
      prior.status !== "available" ||
      !prior.source.observedAt ||
      (!prior.series.length &&
        !(prior.id === "gdelt-finance-news" && previous.news)) ||
      prior.source.frequency === "scheduled events"
    )
      return signal;
    if (prior.id === "gdelt-finance-news") retainedNews = true;
    if (prior.id.startsWith("sec-holdings-")) {
      const id = prior.id.slice("sec-holdings-".length);
      if (!previous.holdings?.some((item) => item.id === id)) return signal;
      retainedHoldings.add(id);
    }
    return {
      ...prior,
      collectionNote:
        "Refresh unavailable. Showing the last verified observation with its original dates; normal stale-data limits still apply.",
    };
  });
  return {
    ...snapshot,
    signals,
    ...(retainedNews ? { news: previous.news } : {}),
    ...(retainedHoldings.size
      ? {
          holdings: [
            ...(snapshot.holdings ?? []).filter(
              (item) => !retainedHoldings.has(item.id),
            ),
            ...(previous.holdings ?? []).filter((item) =>
              retainedHoldings.has(item.id),
            ),
          ].sort((a, b) => a.id.localeCompare(b.id)),
        }
      : {}),
  };
}
