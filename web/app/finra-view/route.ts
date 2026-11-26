import { decodeFinraDisplay, FINRA_AGREEMENT, FINRA_SYMBOLS, renderFinraView } from "../../lib/finra-display.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control":"private, no-store, max-age=0", "X-Robots-Tag":"noindex, noarchive, nosnippet", "Content-Type":"text/html; charset=utf-8", "Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'", "Vary":"Origin" };
const fail = (status:number, message:string) => new Response(message,{status,headers});
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    const parsed = new URL(origin ?? "");
    sameOrigin = parsed.origin === origin && parsed.host === (request.headers.get("host") ?? new URL(request.url).host) && (parsed.protocol === "https:" || ["localhost", "127.0.0.1"].includes(parsed.hostname));
  } catch { /* Missing/invalid Origin fails closed. */ }
  if (!sameOrigin || request.headers.get("content-type") !== "application/json") return fail(403,"Use the agreement on The Daily Consensus to open this view.");
  try {
    const reader = request.body?.getReader(); if (!reader) return fail(400,"Agreement required.");
    let size=0; const parts:Uint8Array[]=[];
    while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>512){await reader.cancel();return fail(413,"Request too large.");}parts.push(p.value);}
    const input=JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (input.accepted !== true || input.agreement !== FINRA_AGREEMENT || !FINRA_SYMBOLS.includes(input.symbol) || typeof input.dark !== "boolean") return fail(400,"Accept the current agreement and select an ETF.");
    const data=decodeFinraDisplay(process.env.FINRA_DISPLAY_SNAPSHOT);
    if(!data || !data.weeks.some(w=>w.instrument===input.symbol)) return fail(503,"Verified FINRA weekly data is currently unavailable. Please use the official reader link.");
    return new Response(renderFinraView(data,input.symbol,input.dark),{headers:{...headers,"X-Finra-Expires":String(Date.parse(data.retrievedAt)+7*86400000)}});
  } catch { return fail(400,"Could not open the FINRA view."); }
}
export function GET(){return fail(405,"Open the FINRA view through its reader agreement.");}
