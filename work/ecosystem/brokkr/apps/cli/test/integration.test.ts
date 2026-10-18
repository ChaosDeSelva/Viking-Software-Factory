import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { cli, reactRepo } from "./helpers.js";

/** Spec Phase 2 acceptance: React repo + frontend task → harness, skills, explanations, usable Claude Code bundle. */
describe("React repo end to end: init → prepare (claude-code) → cleanup", () => {
  it("recommends frontend-react, prepares a Claude Code bundle and cleans it up", async () => {
    const repo = reactRepo();

    const init = await cli(["init", "--yes", "--json", "--cwd", repo]);
    expect(init.code).toBe(0);
    expect(
      init.json<{ recommended: Array<{ name: string }> }>().recommended.map((r) => r.name),
    ).toEqual(["frontend-react"]);

    const prepare = await cli([
      "prepare",
      "--provider",
      "claude-code",
      "--task",
      "task.json",
      "--json",
      "--cwd",
      repo,
    ]);
    expect(prepare.code).toBe(0);
    const out = prepare.json<{
      rootDir: string;
      files: Array<{ relativePath: string }>;
      skills: Array<{ name: string; reason: string }>;
    }>();
    const bundle = join(repo, ".brokkr/generated/task-context/UI-142/claude");
    expect(out.rootDir).toBe(bundle);
    expect(out.files.map((f) => f.relativePath).sort()).toEqual(
      [
        "CLAUDE.md",
        ".claude/skills/accessibility/SKILL.md",
        ".claude/skills/component-design/SKILL.md",
        ".claude/skills/react-architecture/SKILL.md",
        ".claude/skills/responsive-design/SKILL.md",
        ".claude/skills/typescript/SKILL.md",
      ]
        .map((f) => `.brokkr/generated/task-context/UI-142/claude/${f}`)
        .sort(),
    );
    expect(out.skills.every((s) => s.reason.length > 0)).toBe(true);

    const claudeMd = readFileSync(join(bundle, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# Task UI-142: Build analytics dashboard");
    expect(claudeMd).toContain("frontend-react@1.0.0");
    expect(claudeMd).toContain("`typecheck` (required): `pnpm exec tsc --noEmit`");
    const skillMd = readFileSync(join(bundle, ".claude/skills/accessibility/SKILL.md"), "utf8");
    const fm = parse(/^---\n([\s\S]*?)\n---\n/.exec(skillMd)![1]!) as Record<string, string>;
    expect(fm.name).toBe("accessibility");
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
    expect(skillMd).toContain("WCAG 2.2 AA");

    // The project's own instructions were not touched.
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(repo, ".claude"))).toBe(false);

    const cleanup = await cli([
      "prepare",
      "--provider",
      "claude-code",
      "--task",
      "task.json",
      "--cleanup",
      "--cwd",
      repo,
    ]);
    expect(cleanup.code).toBe(0);
    expect(existsSync(join(bundle, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(repo, ".brokkr/generated"))).toBe(false);
    expect(existsSync(join(repo, ".brokkr/config.yaml"))).toBe(true);
  });
});
