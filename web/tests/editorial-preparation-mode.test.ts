import test from "node:test";
import assert from "node:assert/strict";
import { editorialPreparationMode } from "../lib/editorial-preparation-mode.ts";

test("weekday capture enables the free price account and leaves the following digest to the publisher", () => {
  assert.deepEqual(editorialPreparationMode(["--weekday"]), { following: false, freePriceAccount: true });
  assert.deepEqual(editorialPreparationMode(["--public-only"]), { following: false, freePriceAccount: false });
  assert.deepEqual(editorialPreparationMode([]), { following: true, freePriceAccount: true });
  for (const args of [["--weekday", "--public-only"], ["--paid"]])
    assert.throws(() => editorialPreparationMode(args), /Usage/);
});
