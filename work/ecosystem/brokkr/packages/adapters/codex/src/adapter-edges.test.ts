import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "./index.js";
import { makeContext } from "../test/context.js";

describe("codex adapter edges", () => {
  it("validateEnvironment accepts a prepared context and warns in isolated mode", async () => {
    const { ctx } = makeContext();
    expect(await createCodexAdapter().validateEnvironment(ctx)).toEqual({
      compatible: true,
      issues: [],
      warnings: [
        "bundle is isolated: start Codex in the bundle directory or point it at the generated AGENTS.md",
      ],
    });
    expect(
      await createCodexAdapter().validateEnvironment({ ...ctx, modifyProjectInstructions: true }),
    ).toEqual({ compatible: true, issues: [], warnings: [] });
  });

  it("validateEnvironment reports a missing cwd, a cwd that is a file and a missing required skill", async () => {
    const { ctx } = makeContext();
    const file = join(ctx.cwd, "file");
    writeFileSync(file, "x");
    const missing = join(ctx.cwd, "nope");
    const ghost = { ...ctx.composed, skills: { required: ["ghost"], optional: [] } };
    expect(
      (await createCodexAdapter().validateEnvironment({ ...ctx, cwd: missing })).issues,
    ).toEqual([`working directory ${missing} does not exist`]);
    const result = await createCodexAdapter().validateEnvironment({
      ...ctx,
      cwd: file,
      composed: ghost,
    });
    expect(result.compatible).toBe(false);
    expect(result.issues).toEqual([
      `working directory ${file} does not exist`,
      "required skill 'ghost' is missing from the skill catalog",
    ]);
  });

  it("refuses a selected skill missing from the catalog", async () => {
    const { ctx, skills } = makeContext();
    await expect(
      createCodexAdapter().prepare([{ ...skills[0]!, name: "ghost" }], ctx),
    ).rejects.toThrow("skill 'ghost' is not in the skill catalog");
  });

  it("lists (none) when no skill was selected", async () => {
    const { ctx } = makeContext();
    const prepared = await createCodexAdapter().prepare([], ctx);
    expect(readFileSync(prepared.entrypoint, "utf8")).toMatch(/## Skills\n[\s\S]*\n\(none\)\n/);
  });
});
