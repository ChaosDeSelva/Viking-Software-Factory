import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenericAdapter, GenericManifestSchema } from "./index.js";
import { makeContext } from "../test/context.js";

const BUNDLE = ".brokkr/generated/task-context/UI-142/generic";

describe("generic adapter", () => {
  it("writes INSTRUCTIONS.md and a machine-readable manifest.json", async () => {
    const { ctx, skills } = makeContext();
    const adapter = createGenericAdapter();
    expect(adapter.id).toBe("generic");
    const prepared = await adapter.prepare(skills, ctx);
    expect(prepared.files.map((f) => f.relativePath).sort()).toEqual([
      `${BUNDLE}/INSTRUCTIONS.md`,
      `${BUNDLE}/manifest.json`,
    ]);
    const md = readFileSync(join(ctx.cwd, BUNDLE, "INSTRUCTIONS.md"), "utf8");
    expect(md).toContain("# Task UI-142");
    expect(md).toContain("## Skill: react-architecture (1.0.0)");
    expect(md).toContain("Keep state local.");

    const manifest = GenericManifestSchema.parse(
      JSON.parse(readFileSync(join(ctx.cwd, BUNDLE, "manifest.json"), "utf8")),
    );
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.task.id).toBe("UI-142");
    expect(manifest.skills.map((s) => [s.name, s.reason])).toEqual([
      ["react-architecture", "required by frontend-react@1.0.0"],
      ["accessibility", "keyword 'accessible' in task"],
    ]);
    expect(manifest.checks).toEqual([
      {
        id: "typecheck",
        command: ["pnpm", "exec", "tsc", "--noEmit"],
        required: true,
        timeoutSeconds: 180,
        from: ["frontend-react@1.0.0"],
      },
    ]);
    expect(manifest.policies.network).toBe("deny");
    expect(manifest.harnesses).toEqual([{ name: "frontend-react", version: "1.0.0" }]);

    await adapter.cleanup(ctx);
    expect(existsSync(join(ctx.cwd, BUNDLE, "manifest.json"))).toBe(false);
  });

  it("does not support writing into project instruction files", async () => {
    const { ctx, skills } = makeContext({ modifyProjectInstructions: true });
    const result = await createGenericAdapter().validateEnvironment(ctx);
    expect(result.warnings).toContainEqual(expect.stringMatching(/always isolated/));
    const prepared = await createGenericAdapter().prepare(skills, ctx);
    expect(prepared.rootDir).toBe(join(ctx.cwd, BUNDLE));
  });
});

describe("generic adapter re-checks skill bodies before reading (C1)", () => {
  it("refuses a body that became a symlink to a file outside the skill", async () => {
    const { ctx, skills } = makeContext();
    const skill = ctx.skillCatalog["accessibility"]!;
    const outside = join(mkdtempSync(join(tmpdir(), "brokkr-outside-")), "secret.txt");
    writeFileSync(outside, "TOP SECRET\n");
    rmSync(skill.bodyPath);
    symlinkSync(outside, skill.bodyPath);
    await expect(createGenericAdapter().prepare(skills, ctx)).rejects.toThrow(/symlink/);
  });
});
