import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { collectCtaReference } from "../lib/consensus/cta-reference.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";

const [day, flag, file, ...extra] = process.argv.slice(2);
if (!day || (flag !== undefined && (flag !== "--file" || !file || !isAbsolute(file))) || extra.length)
  throw new Error("Usage: npm run consensus:research-cta-reference -- YYYY-MM-DD [--file /absolute/private/summary.csv]");
const session = exchangeSession(day);
if (!session || Date.parse(session.closeAt) >= Date.now())
  throw new Error("CTA reconciliation requires a completed reviewed exchange session");

let cachedBytes: Uint8Array | undefined;
if (file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || !metadata.size || metadata.size > 80_000_000)
    throw new Error("The cached CTA summary must be a file under 80 MB");
  cachedBytes = await readFile(file);
}
const cutoff = new Date(Date.parse(day) + 86400000 + 13 * 3600000).toISOString();
const [{ reference }, kibot] = await Promise.all([
  collectCtaReference(day, { cachedBytes }),
  collectKibotPrices(day, cutoff, fetch, true),
]);
const comparisons = reference.rows.map(row => {
  const price = kibot.evidence.find(item => item.instrument === row.symbol)?.sessions.find(item => item.session === day);
  if (!price) throw new Error("Missing raw Kibot reference session: " + row.symbol);
  const openBps = (row.open / price.open - 1) * 10_000;
  const closeBps = (row.close / price.close - 1) * 10_000;
  return {
    symbol: row.symbol,
    openDifferenceBps: Number(openBps.toFixed(3)),
    closeDifferenceBps: Number(closeBps.toFixed(3)),
    openPass: Math.abs(openBps) <= 3,
    closePass: Math.abs(closeBps) <= 15,
    sameSessionDirection: Math.sign(row.close - row.open) === Math.sign(price.close - price.open),
  };
});
console.log(JSON.stringify({
  scope: reference.scope,
  session: day,
  source: reference.source,
  sha256: reference.sha256,
  comparisons,
  notCovered: ["QQQ", "TLT"],
}, null, 2));
if (comparisons.some(row => !row.openPass || !row.closePass || !row.sameSessionDirection)) process.exitCode = 2;
