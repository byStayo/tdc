import community from "@/lib/community-current.json";
import { currentCommunity } from "@/lib/community";
import MorningBoard from "@/components/MorningBoard";
import { publishedSnapshot } from "@/lib/consensus/published-snapshot";
import experiments from "@/lib/consensus/experiments.json";
import performance from "@/lib/consensus/performance.json";
import type { PerformanceReport } from "@/lib/consensus/performance-types";
import { validateKibotResearch } from "@/lib/consensus/kibot-research";
import history from "@/public/consensus/index.json";
import kibotResearch from "@/public/consensus/kibot-research.json";
import type { HistoryEntry } from "@/lib/consensus/types";
export const metadata = { alternates: { canonical: "/" } };
export default function Page() {
  validateKibotResearch(kibotResearch, history[0]);
  return (
    <MorningBoard
      communityEnabled={currentCommunity(community) !== null}
      initial={publishedSnapshot()}
      history={history as HistoryEntry[]}
      performance={performance as PerformanceReport}
      experiments={experiments}
      kibotResearch={kibotResearch}
    />
  );
}
