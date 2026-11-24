import { createHash } from "node:crypto";
import { sourceChunk, sourceResponse } from "./source-failure.ts";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const HOSTS = new Set([
  "fred.stlouisfed.org",
  "publicreporting.cftc.gov",
  "www.ecb.europa.eu",
  "data-api.ecb.europa.eu",
  "www.federalreserve.gov",
  "www.newyorkfed.org",
  "markets.newyorkfed.org",
  "home.treasury.gov",
  "www.mof.go.jp",
  "www.census.gov",
  "www.bea.gov",
  "www.oregon.gov",
  "www.boj.or.jp",
  "www.bankofengland.co.uk",
  "www.bankofcanada.ca",
  "www.bls.gov",
  "www.ons.gov.uk",
  "data.sec.gov",
  "www.sec.gov",
  "ticdata.treasury.gov",
  "www.treasurydirect.gov",
  "www.optionseducation.org",
  "openapi.twse.com.tw",
  "www.quantisnow.com",
  "etfiq.com",
  "www.dolthub.com",
]);

export function safeURL(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    !HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    /(?:token|api_key|secret|password)/i.test(url.search)
  )
    throw new Error("Source URL outside public allowlist");
  return url.href;
}
export async function publicBytes(
  url: string,
  fetcher: Fetcher = fetch,
  maxBytes = 2_000_000,
  accept = "application/json,text/csv,application/xml,text/xml,text/html",
): Promise<{ bytes: Buffer; sha256: string; retrievedAt: string }> {
  safeURL(url);
  const response = await sourceResponse(fetcher, url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent":
        "The Daily Consensus public research https://thedailyconsensus.com",
      Accept: accept,
    },
  });
  const reader = response.body!.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error(`Source exceeds ${maxBytes / 1_000_000} MB limit`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    retrievedAt: new Date().toISOString(),
  };
}
export async function publicText(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<{ text: string; sha256: string; retrievedAt: string }> {
  const { bytes, sha256, retrievedAt } = await publicBytes(url, fetcher);
  return { text: bytes.toString("utf8"), sha256, retrievedAt };
}
