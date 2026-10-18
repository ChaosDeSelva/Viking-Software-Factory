import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");

async function lint(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: PKG });
  const [result] = await eslint.lintText(code, { filePath: join(PKG, "src", "probe.ts") });
  return (result?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`);
}

describe("SDK dependency boundary (no Mimir, Sindri or HerdR; only @brokkr/* from the ecosystem)", () => {
  it.each([
    'import { MimirClient } from "@mimir/sdk";',
    'import type { Plan } from "@sindri/planner";',
    'import { connect } from "herdr-client";',
    'import { x } from "../../../../mimir/packages/sdk/src/index.js";',
    'import { y } from "../../registry/src/index.js";',
    'const m = await import("@mimir/protocol");',
  ])("rejects %s", async (code) => {
    const messages = await lint(`${code}\nexport {};\n`);
    expect(messages.some((m) => /^no-restricted-(imports|syntax):/.test(m))).toBe(true);
  });

  it("allows @brokkr/* packages and node built-ins", async () => {
    const messages = await lint(
      'import { BrokkrError } from "@brokkr/core";\nimport { join } from "node:path";\nexport const a = [BrokkrError, join];\n',
    );
    expect(messages).toEqual([]);
  });

  it("package.json depends on nothing from Mimir, Sindri or HerdR", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    expect(deps.filter((d) => /mimir|sindri|herdr/i.test(d))).toEqual([]);
    for (const f of readdirSync(join(PKG, "src")).filter((n) => !n.endsWith(".test.ts")))
      expect(readFileSync(join(PKG, "src", f), "utf8")).not.toMatch(/from "@(mimir|sindri)\//);
  });
});
