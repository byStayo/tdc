/** Only explicit transport failures may revive last-known observations. */
export class SourceTransportError extends Error {}
export class SourceMissingError extends Error {}
/** An access challenge is still a validation failure. A source may check a separate documented delivery. */
export class SourceChallengeError extends Error {}
export const sourceFailureKind = (error: unknown): "transport" | "validation" =>
  error instanceof SourceTransportError ? "transport" : "validation";

export async function sourceResponse(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  allowNotModified = false,
): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, init); }
  catch (cause) { throw new SourceTransportError("Source connection failed", {cause}); }
  if (allowNotModified && response.status === 304) return response;
  if (!response.ok) {
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge" &&
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/html")
      throw new SourceChallengeError("Source HTTP 403 challenge");
    if (response.status === 408 || response.status === 429 || response.status >= 500)
      throw new SourceTransportError(`Source HTTP ${response.status}`);
    if (response.status === 404) throw new SourceMissingError("Source HTTP 404");
    // Forbidden/missing sources may indicate revoked access or a removed dataset.
    throw new Error(`Source HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Empty source body");
  return response;
}

export async function sourceChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try { return await reader.read(); }
  catch (cause) { throw new SourceTransportError("Source connection interrupted", {cause}); }
}
