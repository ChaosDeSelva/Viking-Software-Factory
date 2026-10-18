import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "packages/protocol/openapi.json"), "utf8"));

describe("docs/api.md", () => {
  it("is exactly what generate-api-docs.mjs produces from openapi.json", () => {
    const generated = execFileSync(
      "node",
      [join(root, "scripts/generate-api-docs.mjs"), "--stdout"],
      {
        encoding: "utf8",
      },
    );
    expect(readFileSync(join(root, "docs/api.md"), "utf8")).toBe(generated);
  });

  it("documents every operation in the spec", () => {
    const doc = readFileSync(join(root, "docs/api.md"), "utf8");
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        expect(doc).toContain(`### ${method.toUpperCase()} ${path}`);
      }
    }
  });

  it("mentions every /v1 route literal the server registers", () => {
    const doc = readFileSync(join(root, "docs/api.md"), "utf8");
    const dir = join(root, "apps/server/src/routes");
    const registered = new Set();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/"(\/v1\/[^"]*)"/g)) {
        registered.add(m[1].replace(/:(\w+)/g, "{$1}"));
      }
    }
    expect(registered.size).toBeGreaterThan(20);
    for (const path of registered) expect(doc).toContain(`${path}\``);
  });

  it("documents the mission pause and resume routes", () => {
    const doc = readFileSync(join(root, "docs/api.md"), "utf8");
    expect(doc).toContain("`POST /v1/missions/{id}/pause`");
    expect(doc).toContain("`POST /v1/missions/{id}/resume`");
  });
});
