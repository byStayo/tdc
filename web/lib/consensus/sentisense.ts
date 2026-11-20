import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sourceChunk, sourceResponse } from "./source-failure.ts";

const ORIGIN = "https://app.sentisense.ai/api/v1/";
const MAX_BODY_BYTES = 2_000_000;

export async function sentisenseCredential(directory: string) {
  const fromEnv = process.env.SENTISENSE_API_KEY;
  if (fromEnv) return { apiKey: fromEnv, access: "configured" };
  for (const access of ["configured", "temporary"] as const) {
    const path = resolve(directory, access === "configured" ? "credentials.json" : "temporary-access.json");
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("SentiSense credentials require an owner-only local file");
    const { apiKey, expiresAt } = JSON.parse(await readFile(path, "utf8"));
    if (access === "temporary" && !(Number.isSafeInteger(expiresAt) && expiresAt > Date.now() / 1000))
      return { access: "temporary-credential-expired" };
    return { access, apiKey };
  }
  return { access: "credential-unavailable" };
}

export async function sentisenseResponse(path: string, apiKey: unknown) {
  if (typeof apiKey !== "string" || !/^ss_live_[a-zA-Z0-9_-]+$/.test(apiKey))
    throw new Error("Invalid SentiSense API credential format");
  const response = await sourceResponse(fetch, ORIGIN + path, {
    headers: { "X-SentiSense-API-Key": apiKey },
    signal: AbortSignal.timeout(15_000), redirect: "error", cache: "no-store",
  });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await sourceChunk(reader);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("SentiSense response exceeds its expected size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, length);
  return { body, retrievedAt: new Date().toISOString(), sha256: createHash("sha256").update(body).digest("hex") };
}
