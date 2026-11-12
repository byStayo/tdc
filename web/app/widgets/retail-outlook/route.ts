import { retailWidgetDocument, retailWidgetCSP } from "@/lib/retail-widget";
export async function GET(request: Request) {
  if (new URL(request.url).search) return new Response("Invalid widget parameters", { status: 400 });
  return new Response(retailWidgetDocument(), { headers: {
    "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff", "X-Frame-Options":"SAMEORIGIN",
    "Referrer-Policy":"strict-origin-when-cross-origin", "Content-Security-Policy":retailWidgetCSP(),
  } });
}
