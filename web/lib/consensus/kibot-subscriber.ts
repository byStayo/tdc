import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SourceMissingError, sourceChunk, sourceResponse } from "./source-failure.ts";
import type { Instrument } from "./types.ts";

const loginSource = "https://api.kibot.com/?action=login";
export const KIBOT_SUBSCRIBER_REQUIRED =
  "Kibot guest access is for evaluation only. A verified subscriber or an independent production price control is required.";
type Credentials = { user: string; password: string };
export type KibotSubscriberProof = { source: string; capturedAt: string; body: string; sha256: string };
export type KibotSubscriber = Credentials & { proof: KibotSubscriberProof };

function validCredentials(value: unknown): value is Credentials {
  const v = value as Partial<Credentials> | null;
  return !!v && [v.user, v.password].every(s => typeof s === "string" && s.trim().length > 0 &&
    s.length <= 512 && !/[\u0000-\u001f\u007f]/.test(s)) && !/^(guest|demo|trial)$/i.test(v.user!.trim());
}

/** An owner-supplied subscriber account. No automatic guest, IP-session or trial fallback. */
export async function kibotSubscriberCredentials(root: string): Promise<Credentials> {
  let value: unknown;
  if (process.env.KIBOT_PRODUCTION_USER !== undefined || process.env.KIBOT_PRODUCTION_PASSWORD !== undefined)
    value = { user: process.env.KIBOT_PRODUCTION_USER, password: process.env.KIBOT_PRODUCTION_PASSWORD };
  else {
    const path = resolve(root, ".consensus/private-kibot/production-credentials.json");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077 || !stat.size || stat.size > 4096)
        throw Error("Invalid private Kibot subscriber file");
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SourceMissingError(KIBOT_SUBSCRIBER_REQUIRED);
      throw new Error("Invalid private Kibot subscriber file");
    }
  }
  if (!validCredentials(value)) throw new SourceMissingError(KIBOT_SUBSCRIBER_REQUIRED);
  return { user: value.user, password: value.password };
}

export function verifyKibotSubscriberProof(proof: KibotSubscriberProof | undefined, asOf = new Date().toISOString(), symbol?: Exclude<Instrument, "MARKET">) {
  if (!proof || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf ||
      proof.source !== loginSource || typeof proof.body !== "string" || Buffer.byteLength(proof.body) > 8192 ||
      !Number.isFinite(Date.parse(proof.capturedAt)) || new Date(proof.capturedAt).toISOString() !== proof.capturedAt ||
      proof.capturedAt > asOf || createHash("sha256").update(proof.body).digest("hex") !== proof.sha256) return false;
  const [header, title, divider, ...rows] = proof.body.trim().split(/\r?\n/).map(line => line.trim());
  if (header !== "200 OK" || title !== "Authorizations" || !/^=+$/.test(divider ?? "") ||
      !rows.length || rows.some(row => !/^[\w .()+&/-]+,\d{1,2}\/\d{1,2}\/\d{4},[01]$/.test(row))) return false;
  // The API enforces symbol and interval rights on each subsequent request. This is the separate purchased-package check.
  return rows.some(row => {
    const match = /^([\w .()+&/-]+),(\d{1,2})\/(\d{1,2})\/(\d{4}),1$/.exec(row);
    if (!match || /\b(guest|free|trial|sample|demo|evaluation)\b/i.test(match[1])) return false;
    const etfs = match[1].toUpperCase().match(/\b(?:SPY|QQQ|IWM|DIA|TLT)\b/g);
    if (etfs ? (symbol && !etfs.includes(symbol)) : !/\b(stocks?|equities|ETFs?)\b/i.test(match[1])) return false;
    const date = match[4] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0");
    return Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date && date <= proof.capturedAt.slice(0, 10);
  });
}

export async function authenticateKibotSubscriber(root: string, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<KibotSubscriber> {
  const credentials = await kibotSubscriberCredentials(root);
  const url = new URL(loginSource);
  url.searchParams.set("user", credentials.user);
  url.searchParams.set("password", credentials.password);
  try {
    const response = await sourceResponse(fetcher, url.href, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12000) });
    const reader = response.body!.getReader(), parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await sourceChunk(reader);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) throw Error("Oversized subscriber response");
        parts.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = Buffer.concat(parts), body = bytes.toString("utf8");
    const proof = { source: loginSource, capturedAt: new Date().toISOString(), body, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (!verifyKibotSubscriberProof(proof) || body.includes(credentials.password)) throw Error("Missing paid package");
    return { ...credentials, proof };
  } catch {
    // Neither a transport exception containing the authenticated URL nor an error page containing account details may enter a receipt.
    throw new SourceMissingError("Kibot did not verify an active purchased data package for the supplied account.");
  }
}
