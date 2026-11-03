import current from "@/lib/community-current.json";
import { currentCommunity, COMMUNITY_CONTACT } from "@/lib/community";
export const dynamic = "force-dynamic";
export async function GET() {
  let sample = null;
  try { sample = currentCommunity(current); } catch { /* Invalid data stays unavailable. */ }
  return Response.json({ status: sample ? "available" : "unavailable", sample, contact: COMMUNITY_CONTACT }, { headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } });
}
