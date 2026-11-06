import community from "@/lib/community-current.json";
import { currentCommunity } from "@/lib/community";
import MorningBoard from "@/components/MorningBoard";
import snapshot from "@/lib/consensus/current.json";
import experiments from "@/lib/consensus/experiments.json";
import performance from "@/lib/consensus/performance.json";
import type { PerformanceReport } from "@/lib/consensus/performance-types";
import history from "@/public/consensus/index.json";
import type { Snapshot, HistoryEntry } from "@/lib/consensus/types";
export const metadata = { alternates: { canonical: "/" } };
export default function Page() {
  return (
    <MorningBoard
      communityEnabled={currentCommunity(community) !== null}
      initial={snapshot as Snapshot}
      history={history as HistoryEntry[]}
      performance={performance as PerformanceReport}
      experiments={experiments}
    />
  );
}
