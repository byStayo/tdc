import { createHash } from "node:crypto";
import { sourceChunk, sourceResponse } from "./source-failure.ts";

const API = "https://getmarkethistory.com/api/v1/";

export async function marketHistoryPreview(path: string, fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const bars = path.startsWith("bars/");
  const response = await sourceResponse(fetcher, API + path, { credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(15000), headers: { Accept: bars ? "application/x-ndjson" : "application/json" } });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const mime = bars ? "application/x-ndjson" : "application/json";
    if (!response.headers.get("content-type")?.toLowerCase().includes(mime) ||
        (response.headers.has("x-bars-charged") && response.headers.get("x-bars-charged") !== "0"))
      throw new Error("Unexpected keyless response");
    for (;;) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 500000) throw new Error("Market History response exceeds the preview limit");
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return { text, sha256: createHash("sha256").update(text).digest("hex"), headers: response.headers };
}
