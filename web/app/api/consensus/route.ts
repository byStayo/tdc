import snapshot from "@/lib/consensus/current.json";
import { asIssuedConsensus } from "@/lib/consensus/as-issued";
import { INSTRUMENTS, HORIZONS } from "@/lib/consensus/types";
import type { Snapshot, Instrument, Horizon } from "@/lib/consensus/types";
export async function GET(request: Request) {
  const url = new URL(request.url),
    symbol = url.searchParams.get("symbol") ?? "MARKET",
    horizon = url.searchParams.get("horizon") ?? "daily";
  if (
    !INSTRUMENTS.includes(symbol as Instrument) ||
    !HORIZONS.includes(horizon as Horizon)
  )
    return Response.json(
      { error: "Unsupported instrument or horizon" },
      { status: 400 },
    );
  const data = snapshot as Snapshot;
  const consensus = asIssuedConsensus(data, symbol as Instrument, horizon as Horizon);
  return Response.json(
    {
      edition: data.id,
      issuedAt: data.issuedAt,
      cutoff: data.cutoff,
      engineVersion: data.engineVersion,
      runtimeGeneration: false,
      consensusBasis: "as-issued",
      directional: !consensus.abstain,
      scoreMeaning: consensus.abstain ? "partial-input-balance" : "heuristic-directional-balance",
      performanceBasis: symbol === "MARKET" ? "unscored-context" : "instrument-outcomes",
      consensus,
      snapshot: `/consensus/${data.id}.json`,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
