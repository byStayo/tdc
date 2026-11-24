import { fileURLToPath } from "node:url";
import { registerMarketParquetDaily } from "../lib/consensus/marketparquet-daily.ts";

if (process.argv.length !== 3 || process.argv[2] !== "--register-market-history")
  throw new Error("Use --register-market-history to select the free comparison source before future sessions open");
const root = fileURLToPath(new URL("../", import.meta.url));
const policy = await registerMarketParquetDaily(root);
console.log(JSON.stringify({ registeredAt: policy.registeredAt, comparator: policy.control, funds: ["SPY", "QQQ", "IWM", "DIA", "TLT"],
  scope: "Ordinary exchange sessions opening after registration", purchases: 0, authenticatedPriceRequests: 0 }, null, 2));
