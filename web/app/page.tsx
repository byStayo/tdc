import community from "@/lib/community-current.json";
import { currentCommunity } from "@/lib/community";
import MorningBoard from "@/components/MorningBoard";
import { publishedSnapshot } from "@/lib/consensus/published-snapshot";
import experiments from "@/lib/consensus/experiments.json";
import performance from "@/lib/consensus/performance.json";
import type { PerformanceReport } from "@/lib/consensus/performance-types";
import { validateKibotResearch } from "@/lib/consensus/kibot-research";
import history from "@/public/consensus/index.json";
import outcomes from "@/public/consensus/outcomes.json";
import { recentDailySettlements } from "@/lib/consensus/outcome-coverage-audit";
import { validateOutcomeIndex } from "@/lib/consensus/outcome-ledger";
import kibotResearch from "@/public/consensus/kibot-research.json";
import type { HistoryEntry } from "@/lib/consensus/types";
export const metadata = { alternates: { canonical: "/" } };
export default function Page() {
  validateKibotResearch(kibotResearch, history[0]);
  validateOutcomeIndex(outcomes);
  return (
    <MorningBoard
      communityEnabled={currentCommunity(community) !== null}
      initial={publishedSnapshot()}
      history={history as HistoryEntry[]}
      dailySettlements={recentDailySettlements(history as HistoryEntry[], outcomes, performance.generatedAt)}
      performance={performance as PerformanceReport}
      experiments={experiments}
      kibotResearch={kibotResearch}
    />
  );
}
