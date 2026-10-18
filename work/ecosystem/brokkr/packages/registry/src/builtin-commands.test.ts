import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessManifestSchema, parseManifestText } from "@brokkr/core";

const BUILTIN = resolve(import.meta.dirname, "../../../harnesses");
const PMS = new Set(["npm", "pnpm", "yarn", "bun"]);

const builtins = readdirSync(BUILTIN, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(BUILTIN, e.name, "harness.yaml")))
  .map((e) => {
    const file = join(BUILTIN, e.name, "harness.yaml");
    const parsed = parseManifestText(readFileSync(file, "utf8"), HarnessManifestSchema, file);
    if (!parsed.ok) throw new Error(`${e.name} invalid`);
    return { dir: join(BUILTIN, e.name), manifest: parsed.value };
  });

describe("built-in harness check commands are accepted by their tools (QA smoke)", () => {
  it("never forward extra arguments into a project's own package script", () => {
    // `pnpm test --run` appends --run to whatever the project's `test` script is; with
    // `node --test` that is an invalid flag, so the check could never pass.
    const offenders: string[] = [];
    for (const { manifest } of builtins) {
      for (const check of manifest.checks) {
        const [pm, sub, ...rest] = check.command;
        if (!PMS.has(pm ?? "")) continue;
        const extra =
          sub === "run" || sub === "run-script"
            ? rest.slice(1)
            : sub === "test" || sub === "start"
              ? rest
              : [];
        if (extra.length > 0)
          offenders.push(`${manifest.metadata.name}/${check.id}: ${check.command.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("bundled node scripts parse (node --check)", () => {
    let checked = 0;
    for (const { dir, manifest } of builtins) {
      for (const check of manifest.checks) {
        if (check.command[0] !== "node") continue;
        const script = check.command[1]?.replace("{{harnessDir}}", dir);
        if (!script || !existsSync(script)) continue;
        const result = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
        expect(result.status, `${manifest.metadata.name}/${check.id}: ${result.stderr}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
