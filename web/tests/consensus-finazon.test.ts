import assert from "node:assert/strict";
import test from "node:test";
import { checkFinazonSeries } from "../lib/consensus/finazon.ts";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";

const sessions = ["2026-10-30", "2026-11-02"].map((day) => exchangeSession(day)!);
const raw = sessions.map((row, i) => ({ t: Date.parse(row.openAt) / 1_000, o: 90 + i, c: 92 + i }));
const reference = {
  timestampBasis: "session-open" as const,
  sessions: sessions.map((row, i) => ({ ...row, open: raw[i].o, close: raw[i].c })),
  distributions: [{ session: "2026-11-02", amount: 0.343177 }],
  splits: [],
};
const factor = (92 - 0.343177) / 92;
const adjusted = [
  { ...raw[0], o: raw[0].o * factor * 0.8, c: raw[0].c * factor * 0.8 },
  { ...raw[1], o: raw[1].o * 0.8, c: raw[1].c * 0.8 },
];

test("matches independent open and close prints and their issuer adjustment on a common scale", () => {
  assert.deepEqual(checkFinazonSeries({ data: raw }, { data: adjusted }, reference), {
    sessions: 2, cashDistributions: 1, splits: 0,
  });
});
test("rejects a missing session, wrong timestamp, misselected open or omitted dividend", () => {
  assert.throws(() => checkFinazonSeries({ data: raw.slice(1) }, { data: adjusted }, reference), /session coverage/);
  assert.throws(() => checkFinazonSeries({ data: [{ ...raw[0], t: raw[0].t - 60 }, raw[1]] }, { data: adjusted }, reference), /timestamp/);
  assert.throws(() => checkFinazonSeries({ data: [{ ...raw[0], o: raw[0].o + 0.01 }, raw[1]] }, { data: adjusted }, reference), /open price/);
  assert.throws(() => checkFinazonSeries({ data: [raw[0], { ...raw[1], c: raw[1].c - 0.01 }] }, { data: adjusted }, reference), /close price/);
  assert.throws(() => checkFinazonSeries({ data: raw }, { data: raw }, reference), /adjustment/);
});
