import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter, validateSkillFrontmatter } from "./index.js";
import { makeContext } from "../test/context.js";

describe("claude-code adapter edges", () => {
  it("rejects a description with angle brackets", () => {
    expect(validateSkillFrontmatter({ name: "a", description: "use <b>" }, "a")).toEqual([
      "description must not contain XML tags or angle brackets",
    ]);
  });

  it("validateEnvironment reports a missing required skill, a cwd that is a file, and warns only in isolated mode", async () => {
    const adapter = createClaudeCodeAdapter();
    const { ctx } = makeContext();
    const file = join(ctx.cwd, "file");
    writeFileSync(file, "x");
    const result = await adapter.validateEnvironment({
      ...ctx,
      cwd: file,
      composed: { ...ctx.composed, skills: { required: ["ghost"], optional: [] } },
    });
    expect(result).toEqual({
      compatible: false,
      issues: [
        `working directory ${file} does not exist`,
        "required skill 'ghost' is missing from the skill catalog",
      ],
      warnings: [
        "bundle is isolated: start Claude Code in the bundle directory or pass it with --add-dir",
      ],
    });
    const project = await adapter.validateEnvironment({ ...ctx, modifyProjectInstructions: true });
    expect(project).toEqual({ compatible: true, issues: [], warnings: [] });
  });

  it("refuses to write a skill whose name Claude Code reserves", async () => {
    const { ctx, skills } = makeContext();
    ctx.skillCatalog["synced"] = ctx.skillCatalog["accessibility"]!;
    await expect(
      createClaudeCodeAdapter().prepare([{ ...skills[1]!, name: "synced" }], ctx),
    ).rejects.toThrow("skill 'synced': name 'synced' is reserved by Claude Code");
  });

  it("lists (none) when no skill was selected", async () => {
    const { ctx } = makeContext();
    const prepared = await createClaudeCodeAdapter().prepare([], ctx);
    expect(readFileSync(prepared.entrypoint, "utf8")).toContain("## Skills\n");
    expect(readFileSync(prepared.entrypoint, "utf8")).toMatch(/\n\(none\)\n/);
    expect(prepared.files.map((f) => f.relativePath)).toEqual([
      ".brokkr/generated/task-context/UI-142/claude/CLAUDE.md",
    ]);
  });
});
