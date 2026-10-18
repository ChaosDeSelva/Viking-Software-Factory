import { test } from "node:test";
import assert from "node:assert/strict";
import { countLabel } from "../src/label.mjs";

test("countLabel pluralises", () => {
  assert.equal(countLabel(1), "1 item");
  assert.equal(countLabel(3), "3 items");
});
