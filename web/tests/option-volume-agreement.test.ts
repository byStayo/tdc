import assert from "node:assert/strict";
import test from "node:test";
import { compareOptionVolume, optionVolumeQuery } from "../lib/consensus/option-volume-agreement.ts";

const session = "2026-11-20";
const pair = { symbol: "SPY", call: { contract: "SPY261218C00500000", volume: 100 }, put: { contract: "SPY261218P00500000", volume: 100 } };
const query = optionVolumeQuery(session, [pair]);
const columns = ["ticker", "minute_rows", "contract_volume", "warehouse_timezone", "first_bar", "last_bar"];
const rows = query.tickers.map(ticker => ({ ticker, minute_rows: 3, contract_volume: 100, warehouse_timezone: "UTC",
  first_bar: "2026-11-20 14:31:00", last_bar: "2026-11-20 21:06:00" }));
const response = { source: "Strasmore Research", sql: query.sql, truncated: false,
  window: { verdict: { outside: false, clipped: false } }, row_count: rows.length, columns, rows };

test("matching shares can conceal disagreement in both legs, while absent series remain unresolved", () => {
  const compare = (data: typeof response) => compareOptionVolume(session, [pair], JSON.stringify(data))[0];
  assert.deepEqual(compare(response), { symbol: "SPY", status: "matched", callStatus: "matched", putStatus: "matched", putShareDifferencePoints: 0 });
  assert.deepEqual(compare({ ...response, rows: rows.map(row => ({ ...row, contract_volume: 150 })) }),
    { symbol: "SPY", status: "different", callStatus: "different", putStatus: "different", putShareDifferencePoints: 0 });
  assert.deepEqual(compare({ ...response, row_count: 1, rows: [rows[0]] }),
    { symbol: "SPY", status: "incomplete", callStatus: "matched", putStatus: "missing", putShareDifferencePoints: null });
});

test("only the pinned contract pair and exact New York day can qualify", () => {
  assert.equal(query.first, "2026-11-20 05:00:00");
  assert.equal(query.end, "2026-11-21 05:00:00");
  assert.equal(optionVolumeQuery("2026-07-09", [pair]).first, "2026-07-09 04:00:00");
  assert.throws(() => optionVolumeQuery(session, [{ ...pair, put: { ...pair.put, contract: "SPY261218P00501000" } }]), /matched options/);
  for (const altered of [
    { truncated: true }, { sql: "another query" }, { row_count: 1 }, { window: { verdict: { clipped: true, outside: false } } },
    { rows: [rows[0], rows[0]] }, { rows: [{ ...rows[0], ticker: "O:DIA261218C00500000" }, rows[1]] },
    { rows: [{ ...rows[0], last_bar: query.end }, rows[1]] }, { rows: [{ ...rows[0], warehouse_timezone: "America/New_York" }, rows[1]] },
  ]) assert.throws(() => compareOptionVolume(session, [pair], JSON.stringify({ ...response, ...altered })));
});
