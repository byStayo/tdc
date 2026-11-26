import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { authenticateKibotSubscriber, verifyKibotSubscriberProof } from "../lib/consensus/kibot-subscriber.ts";
import { collectKibotSeries } from "../lib/consensus/kibot.ts";
import { collectLicensedControls } from "../lib/consensus/marketparquet-settlement.ts";
import { collectResearchPrices } from "../lib/consensus/research-price-capture.ts";

const response = "200 OK\nAuthorizations\n=====================\nAll Stocks,1/1/1998,1\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const day = "2026-11-19", raw = "11/19/2026,100,103,98,101,2500\n";
test("only a verified subscriber can supply a new production control and receipt replay validates the original basis and bytes", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "kibot-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envUser = process.env.KIBOT_PRODUCTION_USER, envPassword = process.env.KIBOT_PRODUCTION_PASSWORD;
  delete process.env.KIBOT_PRODUCTION_USER; delete process.env.KIBOT_PRODUCTION_PASSWORD;
  t.after(() => {
    if (envUser !== undefined) process.env.KIBOT_PRODUCTION_USER = envUser;
    if (envPassword !== undefined) process.env.KIBOT_PRODUCTION_PASSWORD = envPassword;
  });
  const file = resolve(root, ".consensus/private-kibot/production-credentials.json");
  const fetchOriginal = globalThis.fetch; t.after(() => { globalThis.fetch = fetchOriginal; });
  const requests: string[] = [];
  const password = "fixture-only-password";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), p = url.searchParams, action = p.get("action")!;
    assert.equal(url.hostname, "api.kibot.com");
    assert.equal(init?.redirect, "error");
    requests.push(action);
    if (action === "login") return new Response(response);
    assert.equal(action, "history");
    if (p.get("user") !== "guest") {
      assert.equal(p.get("user"), "fixture-subscriber"); assert.equal(p.get("password"), password);
    }
    return new Response(raw);
  };
  await assert.rejects(authenticateKibotSubscriber(root), /verified subscriber/);
  await collectResearchPrices(root, "QQQ", [day]);
  assert.deepEqual(requests, ["history"]);
  await assert.rejects(collectResearchPrices(root, "QQQ", [day], { productionRoot: root, cachedOnly: true }), /Missing private subscriber/);
  await durableJSON(file, { user: "guest", password: "guest" });
  await assert.rejects(collectResearchPrices(root, "QQQ", [day], { productionRoot: root }), /verified subscriber/);
  assert.deepEqual(requests, ["history"]);
  await durableJSON(file, { user: "fixture-subscriber", password });
  const [verified] = await collectResearchPrices(root, "QQQ", [day], { productionRoot: root });
  assert.deepEqual(requests, ["history", "login", "history"]);
  const paidFile = resolve(root, "subscriber-QQQ-2026-" + day + "-" + day + "-raw.json");
  assert.ok(verifyKibotSubscriberProof(verified.paid!.authorization));
  const stored = await readFile(paidFile, "utf8");
  assert.ok(!stored.includes(password) && !stored.includes("fixture-subscriber"));
  assert.deepEqual(await collectResearchPrices(root, "QQQ", [day], { productionRoot: root, cachedOnly: true }), [verified]);
  const wrong = structuredClone(verified); wrong.paid!.basis = "splits";
  await writeFile(paidFile, JSON.stringify(wrong));
  await assert.rejects(collectResearchPrices(root, "QQQ", [day], { productionRoot: root }), /original response/);
  assert.deepEqual(requests, ["history", "login", "history"]);
  const bad = async () => { throw Error("test authenticated transport " + password); };
  await assert.rejects(authenticateKibotSubscriber(root, bad), error => error instanceof Error &&
    /did not verify/.test(error.message) && !error.message.includes(password));
});

test("inactive, guest, forged, malformed and future purchase responses never authorize production requests", async () => {
  const capturedAt = new Date().toISOString(), proof = { source: "https://api.kibot.com/?action=login", capturedAt, body: response, sha256: hash(response) };
  for (const body of ["403 Login Failed", response.replace("1998,1", "1998,0"), response.replace("All Stocks", "Trial"), response.replace("All Stocks", "All Futures"),
    response.replace("1998", "2100"), response + "an account error\n"]) {
    assert.equal(verifyKibotSubscriberProof({ ...proof, body, sha256: hash(body) }), false);
  }
  let requests = 0;
  const offline = async () => { requests++; throw Error("Unexpected request"); };
  const one = response.replace("All Stocks", "SPY");
  assert.equal(verifyKibotSubscriberProof({ ...proof, body: one, sha256: hash(one) }, capturedAt, "SPY"), true);
  assert.equal(verifyKibotSubscriberProof({ ...proof, body: one, sha256: hash(one) }, capturedAt, "TLT"), false);
  const malformed = { user: "subscriber", password: "fixture", proof: { ...proof, sha256: "0".repeat(64) } };
  await assert.rejects(collectLicensedControls([day], malformed, offline), /verified subscriber/);
  await assert.rejects(collectKibotSeries("QQQ", [day], { subscriber: { ...malformed, user: "guest", proof }, fetcher: offline }), /subscriber proof/);
  assert.equal(requests, 0);
});
