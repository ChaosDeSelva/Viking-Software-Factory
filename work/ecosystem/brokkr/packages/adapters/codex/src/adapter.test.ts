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
import { describe, expect, it } from "vitest";
import { sha256Digest } from "@brokkr/core";
import { createCodexAdapter } from "./index.js";
import { makeContext } from "../test/context.js";

const BUNDLE = ".brokkr/generated/task-context/UI-142/codex";

describe("codex adapter", () => {
  it("writes AGENTS.md and instructions/<skill>.md in an isolated bundle", async () => {
    const { ctx, skills } = makeContext();
    const adapter = createCodexAdapter();
    expect(adapter.id).toBe("codex");
    const prepared = await adapter.prepare(skills, ctx);
    expect(prepared.entrypoint).toBe(join(ctx.cwd, BUNDLE, "AGENTS.md"));
    expect(prepared.files.map((f) => f.relativePath).sort()).toEqual([
      `${BUNDLE}/AGENTS.md`,
      `${BUNDLE}/instructions/accessibility.md`,
      `${BUNDLE}/instructions/react-architecture.md`,
    ]);
    for (const f of prepared.files) expect(f.digest).toBe(sha256Digest(readFileSync(f.path)));
    const agents = readFileSync(prepared.entrypoint, "utf8");
    expect(agents).toContain("# Task UI-142: Build analytics dashboard");
    expect(agents).toContain("## Harness execution contract");
    expect(agents).toContain("[react-architecture](instructions/react-architecture.md)");
    const skill = readFileSync(join(ctx.cwd, BUNDLE, "instructions/accessibility.md"), "utf8");
    expect(skill.startsWith("<!-- skill: accessibility@1.0.0 -->\n")).toBe(true);
    expect(skill).toContain("Use semantic elements.");
    expect(existsSync(join(ctx.cwd, "AGENTS.md"))).toBe(false);
  });

  it("cleanup removes only what it wrote", async () => {
    const { ctx, skills } = makeContext();
    const adapter = createCodexAdapter();
    await adapter.prepare(skills, ctx);
    writeFileSync(join(ctx.cwd, BUNDLE, "instructions/mine.md"), "x");
    await adapter.cleanup(ctx);
    expect(existsSync(join(ctx.cwd, BUNDLE, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(ctx.cwd, BUNDLE, "instructions/mine.md"))).toBe(true);
  });

  it("modifies the project AGENTS.md only when approved", async () => {
    const { ctx, skills } = makeContext({ modifyProjectInstructions: true });
    writeFileSync(join(ctx.cwd, "AGENTS.md"), "# Team rules\n");
    const adapter = createCodexAdapter();
    const prepared = await adapter.prepare(skills, ctx);
    expect(prepared.entrypoint).toBe(join(ctx.cwd, "AGENTS.md"));
    const agents = readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Team rules");
    expect(agents).toContain(`(${BUNDLE}/instructions/react-architecture.md)`);
    await adapter.cleanup(ctx);
    expect(readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8")).toBe("# Team rules\n");
  });
});

describe("codex adapter re-checks skill bodies before reading (C1)", () => {
  it("refuses a body that became a symlink to a file outside the skill", async () => {
    const { ctx, skills } = makeContext();
    const skill = ctx.skillCatalog["accessibility"]!;
    const outside = join(mkdtempSync(join(tmpdir(), "brokkr-outside-")), "secret.txt");
    writeFileSync(outside, "TOP SECRET\n");
    rmSync(skill.bodyPath);
    symlinkSync(outside, skill.bodyPath);
    await expect(createCodexAdapter().prepare(skills, ctx)).rejects.toThrow(/symlink/);
  });
});

describe("codex adapter overwrite guard (review M6)", () => {
  it("refuses to overwrite an instruction file it did not write", async () => {
    const { ctx, skills } = makeContext();
    const target = join(ctx.cwd, ".brokkr/generated/task-context/UI-142/codex/instructions");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "accessibility.md"), "mine");
    await expect(createCodexAdapter().prepare(skills, ctx)).rejects.toThrow(
      /not written by brokkr/,
    );
    expect(readFileSync(join(target, "accessibility.md"), "utf8")).toBe("mine");
  });
});

describe("codex cleanup only touches the adapter's own project files (review D1)", () => {
  it("skips a forged ledger entry for an unrelated project file", async () => {
    const { ctx, skills } = makeContext({ modifyProjectInstructions: true });
    const adapter = createCodexAdapter();
    await adapter.prepare(skills, ctx);
    writeFileSync(join(ctx.cwd, "README.md"), "project readme\n");
    const ledgerPath = join(
      ctx.cwd,
      ".brokkr/generated/task-context/UI-142/codex/.brokkr-ledger.json",
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
