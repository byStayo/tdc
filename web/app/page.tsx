import { readFile } from "node:fs/promises";
import { join } from "node:path";
import community from "@/lib/community-current.json";
import { currentCommunity } from "@/lib/community";
import MorningBoard from "@/components/MorningBoard";
import snapshot from "@/lib/consensus/current.json";
import experiments from "@/lib/consensus/experiments.json";
import performance from "@/lib/consensus/performance.json";
import type { PerformanceReport } from "@/lib/consensus/performance-types";
import { KIBOT_RESEARCH_FILE, validateKibotResearch, type KibotResearch } from "@/lib/consensus/kibot-research";
import history from "@/public/consensus/index.json";
import type { Snapshot, HistoryEntry } from "@/lib/consensus/types";
export const metadata = { alternates: { canonical: "/" } };
export default async function Page() {
  let kibotResearch: KibotResearch | null = null;
  try {
    const report: unknown = JSON.parse(
      await readFile(join(process.cwd(), "public/consensus", KIBOT_RESEARCH_FILE), "utf8"),
    );
    validateKibotResearch(report, history[0]);
    kibotResearch = report;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return (
    <MorningBoard
      communityEnabled={currentCommunity(community) !== null}
      initial={snapshot as Snapshot}
      history={history as HistoryEntry[]}
      performance={performance as PerformanceReport}
      experiments={experiments}
      kibotResearch={kibotResearch}
    />
  );
}
