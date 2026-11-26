import { getPublicWorkspace } from "@/lib/public-market";
import { getPublishedBrief } from "@/lib/published-brief";
import ResearchDesk from "@/components/ResearchDesk";
export const metadata = {
  title: "Research Desk | The Daily Consensus",
  alternates: { canonical: "/research-desk" },
};
export default async function Page() {
  const workspace = await getPublicWorkspace("SPY");
  return <ResearchDesk initialWorkspace={workspace} initialBrief={getPublishedBrief()} />;
}
