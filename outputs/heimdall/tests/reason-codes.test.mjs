// Heimdall keeps a copy of Sindri's reason-code words; this keeps the copy exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeReason } from "../apps/web/src/features/reasonCodes.ts";

// The words table as code → words pairs, whatever the line wrapping (the two repos format
// differently).
const pairs = (path) => {
  const text = readFileSync(new URL(path, import.meta.url), "utf8").replace(
    /\s+/g,
    " ",
  );
  return [...text.matchAll(/["']?([\w:. -]+?)["']?: ["']([^"']+)["']/g)]
    .map((m) => `${m[1]}=${m[2]}`)
    .sort();
};

test("Heimdall's reason-code words are Sindri's", () => {
  const sindri = pairs(
    "../../../work/ecosystem/sindri/apps/web/src/lib/reasonCodes.ts",
  );
  assert.ok(sindri.length > 20, "the table was read");
  assert.deepEqual(pairs("../apps/web/src/features/reasonCodes.ts"), sindri);
});

test("a gate failure reads in words, not JSON", () => {
  const { words } = describeReason("unparseable_review", "review-verdict");
  assert.equal(words.includes("{"), false);
  assert.match(words, /unreadable/i);
});
