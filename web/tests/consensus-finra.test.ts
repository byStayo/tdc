import test from "node:test";
import assert from "node:assert/strict";
import {
  finraWeeks,
  finraQuery,
  collectFinraPrivate,
} from "../lib/consensus/finra.ts";
const cutoff = "2026-11-03T07:00:00.000Z";
const row = {
  issueSymbolIdentifier: "SPY",
  summaryTypeCode: "ATS_W_SMBL",
  weekStartDate: "2026-10-12",
  totalWeeklyShareQuantity: 100,
  totalWeeklyTradeCount: 10,
  initialPublishedDate: "2026-11-02",
  lastUpdateDate: "2026-11-02",
  tierIdentifier: "T1",
};
const pair = [
  row,
  { ...row, summaryTypeCode: "OTC_W_SMBL", totalWeeklyShareQuantity: 300 },
];
test("FINRA preserves fractional shares while trade counts remain nonnegative integers", () => {
  const fractional = pair.map(r => ({ ...r, totalWeeklyShareQuantity: 100.123456 }));
  assert.equal(finraWeeks(fractional, cutoff)[0].nonAtsShares, 100.123456);
  for (const bad of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, "100.5", null]) {
    assert.equal(finraWeeks(fractional.map(r => ({ ...r, totalWeeklyShareQuantity: bad })), cutoff).length, 0);
  }
  assert.equal(finraWeeks(fractional.map(r => ({ ...r, totalWeeklyTradeCount: 1.5 })), cutoff).length, 0);
});
test("FINRA parser keeps ATS and non-ATS separate, ignores firm totals and refuses missing-side zero fills", () => {
  const parsed = finraWeeks(
    [
      ...pair,
      {
        ...row,
        summaryTypeCode: "ATS_W_SMBL_FIRM",
        totalWeeklyShareQuantity: 5000,
      },
    ],
    cutoff,
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].atsShares, 100);
  assert.equal(parsed[0].nonAtsShares, 300);
  assert.equal(finraWeeks([row], cutoff).length, 0);
  assert.equal(
    finraWeeks(
      pair.map((r) => ({ ...r, lastUpdateDate: "2026-11-04" })),
      cutoff,
    ).length,
    0,
  );
  assert.equal(
    finraWeeks(
      pair.map((r) => ({ ...r, totalWeeklyTradeCount: -1 })),
      cutoff,
    ).length,
    0,
  );
  assert.throws(
    () =>
      finraWeeks([...pair, { ...row, totalWeeklyShareQuantity: 101 }], cutoff),
    /Conflicting/,
  );
});
test("FINRA requests are bounded to five instruments, two aggregate types and90days", () => {
  const q = finraQuery(cutoff);
  assert.equal(q.limit, 500);
  assert.equal(q.dateRangeFilters[0].startDate, "2026-08-05");
  assert.deepEqual(q.domainFilters[0].values, [
    "SPY",
    "QQQ",
    "IWM",
    "DIA",
    "TLT",
  ]);
  assert.deepEqual(q.domainFilters[1].values, ["ATS_W_SMBL", "OTC_W_SMBL"]);
});
test("FINRA private collector authenticates only to FINRA and returns neither token nor raw credentials", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const data = await collectFinraPrivate(
    { clientId: "test-client", clientSecret: "test-secret" },
    async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? Response.json({
            access_token: "test-token",
            token_type: "Bearer",
            expires_in: 3600,
          })
        : Response.json(pair, { headers: { "Record-Total": "2" } });
    },
    () => cutoff,
  );
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).hostname, "ews.fip.finra.org");
  assert.equal(new URL(calls[1].url).hostname, "api.finra.org");
  assert.equal(calls[0].init?.redirect, "error");
  assert.match(
    new Headers(calls[0].init?.headers).get("Authorization")!,
    /^Basic /,
  );
  assert.equal(
    new Headers(calls[1].init?.headers).get("Authorization"),
    "Bearer test-token",
  );
  assert.equal(data.weeks.length, 1);
  assert.doesNotMatch(
    JSON.stringify(data),
    /test-client|test-secret|test-token/,
  );
});
test("FINRA auth failure does not echo provider response or issue a data query", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      collectFinraPrivate(
        { clientId: "test", clientSecret: "secret" },
        async () => {
          calls++;
          return new Response("secret", { status: 401 });
        },
      ),
    /^Error: FINRA HTTP 401$/,
  );
  assert.equal(calls, 1);
  let missingCalls = 0;
  await assert.rejects(() =>
    collectFinraPrivate({ clientId: "", clientSecret: "" }, async () => {
      missingCalls++;
      return Response.json([]);
    }),
  );
  assert.equal(missingCalls, 0);
});
