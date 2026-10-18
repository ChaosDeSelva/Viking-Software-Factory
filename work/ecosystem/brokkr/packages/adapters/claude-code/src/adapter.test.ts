import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brokkr/core";
import { createClaudeCodeAdapter, renderSkillMd, validateSkillFrontmatter } from "./index.js";
import { makeContext } from "../test/context.js";

const BUNDLE = ".brokkr/generated/task-context/UI-142/claude";

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  return parse(match[1]!) as Record<string, unknown>;
}

describe("claude-code adapter", () => {
  it("identifies itself", () => {
    const adapter = createClaudeCodeAdapter();
    expect(adapter.id).toBe("claude-code");
    expect(adapter.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("writes an isolated CLAUDE.md and one SKILL.md per selected skill", async () => {
    const { ctx, skills } = makeContext();
    const prepared = await createClaudeCodeAdapter().prepare(skills, ctx);
    expect(prepared.rootDir).toBe(join(ctx.cwd, BUNDLE));
    expect(prepared.entrypoint).toBe(join(ctx.cwd, BUNDLE, "CLAUDE.md"));
    expect(prepared.files.map((f) => f.relativePath).sort()).toEqual([
      `${BUNDLE}/.claude/skills/accessibility/SKILL.md`,
      `${BUNDLE}/.claude/skills/react-architecture/SKILL.md`,
      `${BUNDLE}/CLAUDE.md`,
    ]);
    for (const f of prepared.files) expect(f.digest).toBe(sha256Digest(readFileSync(f.path)));

    const claudeMd = readFileSync(join(ctx.cwd, BUNDLE, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# Task UI-142: Build analytics dashboard");
    expect(claudeMd).toContain("## Harness execution contract");
    expect(claudeMd).toContain("`typecheck` (required): `pnpm exec tsc --noEmit`");
    expect(claudeMd).toContain("- `react-architecture` 1.0.0 — required by frontend-react@1.0.0");
    expect(claudeMd).toContain(".claude/skills/accessibility/SKILL.md");

    // The project's own instruction files are untouched.
    expect(existsSync(join(ctx.cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(ctx.cwd, ".claude"))).toBe(false);
  });

  it("emits SKILL.md in the format Claude Code loads: YAML frontmatter with name and description, then the body", async () => {
    const { ctx, skills } = makeContext();
    await createClaudeCodeAdapter().prepare(skills, ctx);
    const text = readFileSync(
      join(ctx.cwd, BUNDLE, ".claude/skills/react-architecture/SKILL.md"),
      "utf8",
    );
    expect(text.startsWith("---\n")).toBe(true);
    const fm = frontmatter(text);
    expect(Object.keys(fm).sort()).toEqual(["description", "name"]);
    expect(fm.name).toBe("react-architecture");
    expect(fm.description).toMatch(/^Component boundaries and state ownership/);
    expect(
      validateSkillFrontmatter(
        { name: fm.name as string, description: fm.description as string },
        "react-architecture",
      ),
    ).toEqual([]);
    expect(text).toContain("# React architecture\n\nKeep state local.");
  });

  it("caps descriptions at 1024 characters and strips angle brackets", () => {
    const text = renderSkillMd({ name: "x", description: `${"a".repeat(2000)} <tag>` }, "body");
    const fm = frontmatter(text);
    expect((fm.description as string).length).toBeLessThanOrEqual(1024);
    expect(renderSkillMd({ name: "x", description: "use <b>bold</b>" }, "b")).not.toMatch(/<b>/);
  });

  it("rejects frontmatter Claude Code would not load", () => {
    expect(
      validateSkillFrontmatter({ name: "Bad Name", description: "d" }, "Bad Name"),
    ).not.toEqual([]);
    expect(validateSkillFrontmatter({ name: "a", description: "d" }, "b")).toContainEqual(
      expect.stringMatching(/directory/),
    );
    expect(validateSkillFrontmatter({ name: "synced", description: "d" }, "synced")).toContainEqual(
      expect.stringMatching(/reserved/),
    );
    expect(validateSkillFrontmatter({ name: "a", description: "" }, "a")).toContainEqual(
      expect.stringMatching(/description/),
    );
    expect(
      validateSkillFrontmatter({ name: "a", description: "x".repeat(1025) }, "a"),
    ).toContainEqual(expect.stringMatching(/1024/));
  });

  it("cleanup removes only the files it wrote", async () => {
    const { ctx, skills } = makeContext();
    const adapter = createClaudeCodeAdapter();
    await adapter.prepare(skills, ctx);
    writeFileSync(join(ctx.cwd, BUNDLE, "notes.md"), "user notes");
    await adapter.cleanup(ctx);
    expect(existsSync(join(ctx.cwd, BUNDLE, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(ctx.cwd, BUNDLE, ".claude"))).toBe(false);
    expect(readFileSync(join(ctx.cwd, BUNDLE, "notes.md"), "utf8")).toBe("user notes");
  });

  it("re-preparing replaces the previous bundle", async () => {
    const { ctx, skills } = makeContext();
    const adapter = createClaudeCodeAdapter();
    await adapter.prepare(skills, ctx);
    const second = await adapter.prepare(skills.slice(0, 1), ctx);
    expect(second.files).toHaveLength(2);
    expect(existsSync(join(ctx.cwd, BUNDLE, ".claude/skills/accessibility"))).toBe(false);
  });

  it("writes into the project's CLAUDE.md/.claude only when explicitly approved, and cleans up", async () => {
    const { ctx, skills } = makeContext({ modifyProjectInstructions: true });
    writeFileSync(join(ctx.cwd, "CLAUDE.md"), "# Existing rules\n");
    const adapter = createClaudeCodeAdapter();
    const prepared = await adapter.prepare(skills, ctx);
    expect(prepared.entrypoint).toBe(join(ctx.cwd, "CLAUDE.md"));
    const merged = readFileSync(join(ctx.cwd, "CLAUDE.md"), "utf8");
    expect(merged.startsWith("# Existing rules\n")).toBe(true);
    expect(merged).toContain("<!-- brokkr:begin claude-code -->");
    expect(existsSync(join(ctx.cwd, ".claude/skills/accessibility/SKILL.md"))).toBe(true);
    await adapter.cleanup(ctx);
    expect(readFileSync(join(ctx.cwd, "CLAUDE.md"), "utf8")).toBe("# Existing rules\n");
    expect(existsSync(join(ctx.cwd, ".claude/skills/accessibility/SKILL.md"))).toBe(false);
  });

  it("refuses to overwrite a project skill it did not write", async () => {
    const { ctx, skills } = makeContext({ modifyProjectInstructions: true });
    mkdirSync(join(ctx.cwd, ".claude/skills/accessibility"), { recursive: true });
    writeFileSync(join(ctx.cwd, ".claude/skills/accessibility/SKILL.md"), "mine");
    await expect(createClaudeCodeAdapter().prepare(skills, ctx)).rejects.toThrow(
      /not written by brokkr/,
    );
    expect(readFileSync(join(ctx.cwd, ".claude/skills/accessibility/SKILL.md"), "utf8")).toBe(
      "mine",
    );
  });

  it("validateEnvironment reports a missing cwd and an unknown skill", async () => {
    const adapter = createClaudeCodeAdapter();
    const { ctx } = makeContext();
    expect((await adapter.validateEnvironment(ctx)).compatible).toBe(true);
    const missing = await adapter.validateEnvironment({ ...ctx, cwd: join(ctx.cwd, "nope") });
    expect(missing.compatible).toBe(false);
    const { ctx: c2, skills } = makeContext();
    await expect(
      createClaudeCodeAdapter().prepare([...skills, { ...skills[0]!, name: "ghost" }], c2),
    ).rejects.toThrow(/ghost/);
  });
});

describe("claude-code adapter re-checks skill bodies before reading (C1)", () => {
  it("refuses a body that became a symlink to a file outside the skill", async () => {
    const { ctx, skills } = makeContext();
    const skill = ctx.skillCatalog["accessibility"]!;
    const outside = join(mkdtempSync(join(tmpdir(), "brokkr-outside-")), "secret.txt");
    writeFileSync(outside, "TOP SECRET\n");
    rmSync(skill.bodyPath);
    symlinkSync(outside, skill.bodyPath);
    await expect(createClaudeCodeAdapter().prepare(skills, ctx)).rejects.toThrow(/symlink/);
  });
});

describe("claude-code cleanup only touches the adapter's own project files (review D1)", () => {
  it("skips a forged ledger entry for an unrelated project file", async () => {
    const { ctx, skills } = makeContext({ modifyProjectInstructions: true });
    const adapter = createClaudeCodeAdapter();
    await adapter.prepare(skills, ctx);
    writeFileSync(join(ctx.cwd, "README.md"), "project readme\n");
    const ledgerPath = join(
      ctx.cwd,
      ".brokkr/generated/task-context/UI-142/claude/.brokkr-ledger.json",
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.files.push({
      relativePath: "README.md",
      digest: sha256Digest("project readme\n"),
      bytes: 15,
      mode: "created",
    });
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    await adapter.cleanup(ctx);
    expect(readFileSync(join(ctx.cwd, "README.md"), "utf8")).toBe("project readme\n");
  });
});
