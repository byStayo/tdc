import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { RETAIL_READY, RETAIL_SCRIPT, retailWidgetCSP, retailWidgetDocument } from "../lib/retail-widget.ts";
import { retailFrameStatus } from "../lib/retail-lifecycle.ts";

test("retail lifecycle rejects other frames, origins and malformed messages", () => {
  const source = {} as Window;
  const event = { source, origin: "null", data: { type: "tdc-retail-frame", version: 1, status: "ready" } };
  assert.equal(retailFrameStatus(event, source), "ready");
  assert.equal(retailFrameStatus({ ...event, data: { ...event.data, status: "error" } }, source), "error");
  assert.equal(retailFrameStatus(event, null), null);
  assert.equal(retailFrameStatus({ ...event, source: {} as Window }, source), null);
  for (const origin of ["https://thedailyconsensus.com", "https://widgets.mfbcdn.net", "https://evil.test", ""]) {
    assert.equal(retailFrameStatus({ ...event, origin }, source), null);
  }
  for (const data of [null, "ready", {}, { ...event.data, version: 2 }, { ...event.data, type: "tdc-widget-frame" }, { ...event.data, status: "<script>" }]) {
    assert.equal(retailFrameStatus({ ...event, data }, source), null);
  }
});

test("retail wrapper has a hash-bound bootstrap, opaque origin and no arbitrary provider URL", () => {
  const html = retailWidgetDocument(), csp = retailWidgetCSP();
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert.equal(inline, RETAIL_READY);
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(inline).digest("base64")}'`));
  assert.match(csp, /sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
  assert.ok(!csp.includes("allow-same-origin"));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.ok(!csp.match(/script-src[^;]*unsafe-/));
  assert.equal(new URL(RETAIL_SCRIPT).host, "widgets.mfbcdn.net");
  assert.ok(html.includes("Powered by Myfxbook.com"));
  assert.equal((html.match(/<script/g) ?? []).length, 2);
});

test("bootstrap reports only frame insertion or failure and never provider values", () => {
  function execute(mode: "inserted" | "absent" | "throws") {
    const messages: unknown[] = [], timers: Array<() => void> = [];
    let disconnected = false;
    runInNewContext(RETAIL_READY, {
      parent: { postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))) },
      showOutlookWidget: () => { if (mode === "throws") throw new Error("private provider detail"); },
      document: { body: {}, querySelector: () => mode === "inserted" ? {} : null },
      MutationObserver: class { observe() {} disconnect() { disconnected = true; } },
      setTimeout: (callback: () => void) => timers.push(callback),
    });
    timers.forEach(callback => callback());
    return { messages, disconnected };
  }
  assert.deepEqual(execute("inserted").messages, [{ type: "tdc-retail-frame", version: 1, status: "ready" }]);
  assert.deepEqual(execute("absent").messages, [{ type: "tdc-retail-frame", version: 1, status: "error" }]);
  assert.deepEqual(execute("throws").messages, [{ type: "tdc-retail-frame", version: 1, status: "error" }]);
  assert.equal(execute("inserted").disconnected, true);
  assert.ok(!/innerText|textContent|contentDocument|localStorage|cookie|fetch\(/.test(RETAIL_READY));
});
