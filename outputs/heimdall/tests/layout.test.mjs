import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutGraph,
  NODE_WIDTH,
  NODE_GAP,
} from "../apps/web/src/workers/layout.ts";

test("large dependency chains do not recurse or lose nodes", () => {
  const ids = Array.from({ length: 10000 }, (_, i) => `task-${i}`);
  const dependencies = ids
    .slice(1)
    .map((taskId, i) => ({ taskId, dependsOnId: ids[i] }));
  const result = layoutGraph({ ids, dependencies });
  assert.equal(Object.keys(result.positions).length, ids.length);
  assert.equal(
    result.positions[ids.at(-1)].x,
    30 + 9999 * (NODE_WIDTH + NODE_GAP),
  );
  assert.deepEqual(result.cyclic, []);
});

test("duplicate edges and missing dependencies do not corrupt the layout", () => {
  const edge = { taskId: "b", dependsOnId: "a" };
  const result = layoutGraph({
    ids: ["a", "a", "b", "__proto__"],
    dependencies: [edge, edge, { taskId: "b", dependsOnId: "missing" }],
  });
  assert.equal(Object.keys(result.positions).length, 3);
  assert.ok(result.positions.b.x > result.positions.a.x);
  assert.ok(result.positions.__proto__.x >= 30);
  assert.deepEqual(result.cyclic, []);
});

test("cycles and their blocked descendants remain visible", () => {
  const result = layoutGraph({
    ids: ["a", "b", "c", "free"],
    dependencies: [
      { taskId: "a", dependsOnId: "b" },
      { taskId: "b", dependsOnId: "a" },
      { taskId: "c", dependsOnId: "b" },
    ],
  });
  assert.deepEqual(result.cyclic, ["a", "b", "c"]);
  assert.equal(Object.keys(result.positions).length, 4);
});
