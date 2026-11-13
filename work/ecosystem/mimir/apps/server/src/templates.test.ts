import { describe, expect, it } from "vitest";
import { MimirError, type TaskMode } from "@mimir/protocol";
import {
  AGENT_ARGV_TEMPLATES,
  DOCUMENT_CONTRACT,
  ROLE_TEMPLATES,
  argvFor,
  briefFor,
} from "./templates.js";

describe("argv templates", () => {
  it("has the default argv per agent kind", () => {
    expect(argvFor("claude", "implementer", "Fix the bug")).toEqual([
      "claude",
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
      "--disable-slash-commands",
      "--allowedTools",
      "Bash(npm run *),Bash(npm test *),Bash(pnpm run *),Bash(pnpm test *),Bash(node --test *),Bash(node --check *)",
      "--output-format",
      "stream-json",
      "--verbose",
      briefFor("implementer", "Fix the bug"),
    ]);
    expect(argvFor("codex", "implementer", "Fix it")).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      briefFor("implementer", "Fix it"),
    ]);
    expect(Object.keys(AGENT_ARGV_TEMPLATES).sort()).toEqual([
      "agy",
      "claude",
      "codex",
      "commandcode",
      "cursor",
      "devin",
      "gemini",
      "grok",
      "kimi",
      "muse",
      "omp",
      "opencode",
      "pi",
      "pi-signed",
      "rovo",
      "shell",
    ]);
  });

  it("passes a shell instruction through verbatim as the command (no role preamble)", () => {
    expect(argvFor("shell", "qa", "npm test && echo ok")).toEqual([
      "sh",
      "-c",
      "npm test && echo ok",
    ]);
  });

  it("covers every crew role with a preamble that names the role", () => {
    expect(Object.keys(ROLE_TEMPLATES).sort()).toEqual([
      "implementer",
      "investigator",
      "lead",
      "qa",
      "reviewer",
    ]);
    for (const role of Object.keys(ROLE_TEMPLATES) as (keyof typeof ROLE_TEMPLATES)[]) {
      const brief = briefFor(role, "do X");
      expect(brief).toContain("do X");
      expect(brief.toLowerCase()).toContain(role);
    }
  });

  it("rejects an agent kind without a template", () => {
    expect(() => argvFor("unsupported-agent", "implementer", "x")).toThrow(MimirError);
    try {
      argvFor("unsupported-agent", "implementer", "x");
    } catch (e) {
      expect((e as MimirError).code).toBe("validation_failed");
    }
  });

  it("renders multiline agent briefs without terminal control characters", () => {
    expect(argvFor("codex", "implementer", "First line\nSecond\tline").at(-1)).not.toMatch(
      /[\r\n\t]/,
    );
    expect(argvFor("codex", "implementer", "First line\nSecond\tline").at(-1)).toContain(
      "First line Second line",
    );
  });

  it("never splits the instruction into several argv words", () => {
    const argv = argvFor("claude", "lead", "a; rm -rf / && echo $HOME");
    expect(argv.at(-1)).toBe(briefFor("lead", "a; rm -rf / && echo $HOME"));
    expect(argv.filter((word) => word.includes("rm -rf"))).toHaveLength(1);
  });

  it("puts a project's Codex sandbox overrides before the brief, for codex only", () => {
    const codexSandbox = { writableRoots: ["/var/cache/go", '/tmp/a "b"'], networkAccess: true };
    expect(argvFor("codex", "implementer", "Fix it", { codexSandbox })).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      "-c",
      'sandbox_workspace_write.writable_roots=["/var/cache/go","/tmp/a \\"b\\""]',
      "-c",
      "sandbox_workspace_write.network_access=true",
      briefFor("implementer", "Fix it"),
    ]);
    expect(argvFor("codex", "implementer", "Fix it", { codexSandbox: {} })).toEqual(
      argvFor("codex", "implementer", "Fix it"),
    );
    expect(
      argvFor("codex", "implementer", "x", { codexSandbox: { networkAccess: false } }),
    ).not.toContain("-c");
    expect(argvFor("claude", "implementer", "Fix it", { codexSandbox })).toEqual(
      argvFor("claude", "implementer", "Fix it"),
    );
  });
});

describe("argv per task mode", () => {
  const mode = (
    access: TaskMode["access"],
    network: TaskMode["network"],
    deliverable: TaskMode["deliverable"] = "document",
  ): TaskMode => ({ deliverable, access, network });
  const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
  const tools = (argv: string[]) => flag(argv, "--allowedTools")!.split(",");
  const hardening = [
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  const keepsHardening = (argv: string[]) => {
    const at = argv.indexOf("--setting-sources");
    expect(argv.slice(at, at + hardening.length)).toEqual(hardening);
  };
  const writeTools = tools(argvFor("claude", "implementer", "x"));
  const documentBrief = (role: Parameters<typeof briefFor>[0], text: string) =>
    briefFor(role, `${text}\n\n${DOCUMENT_CONTRACT}`);

  it("leaves claude and codex unchanged for a default (write, no network) mode", () => {
    for (const kind of ["claude", "codex"]) {
      expect(argvFor(kind, "implementer", "x", { mode: mode("write", "none", "diff") })).toEqual(
        argvFor(kind, "implementer", "x"),
      );
    }
  });

  it("claude write + web: acceptEdits, the test commands and the web tools", () => {
    const argv = argvFor("claude", "investigator", "x", { mode: mode("write", "web") });
    expect(flag(argv, "--permission-mode")).toBe("acceptEdits");
    expect(tools(argv)).toEqual([...writeTools, "WebSearch", "WebFetch"]);
    keepsHardening(argv);
  });

  it("claude read: default permission mode, read and git tools, writes only to artifacts", () => {
    const argv = argvFor("claude", "reviewer", "x", { mode: mode("read", "none") });
    expect(flag(argv, "--permission-mode")).toBe("default");
    expect(argv).not.toContain("acceptEdits");
    expect(tools(argv)).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git status *)",
      "Write(.mimir/artifacts/**)",
      "Edit(.mimir/artifacts/**)",
    ]);
    expect(tools(argv).some((t) => t.startsWith("Bash(npm") || t.startsWith("Bash(pnpm"))).toBe(
      false,
    );
    keepsHardening(argv);
    expect(argv.at(-1)).toBe(documentBrief("reviewer", "x"));
  });

  it("claude read + web: the read tools plus the web tools", () => {
    const argv = argvFor("claude", "investigator", "x", { mode: mode("read", "web") });
    expect(flag(argv, "--permission-mode")).toBe("default");
    expect(tools(argv).slice(-2)).toEqual(["WebSearch", "WebFetch"]);
    expect(tools(argv)).toContain("Read");
    expect(tools(argv)).not.toContain(writeTools[0]);
  });

  it("codex read keeps workspace-write (artifacts must be writable)", () => {
    const argv = argvFor("codex", "reviewer", "x", { mode: mode("read", "none") });
    expect(argv.slice(0, -1)).toEqual(argvFor("codex", "reviewer", "x").slice(0, -1));
    expect(flag(argv, "--sandbox")).toBe("workspace-write");
  });

  it.each([
    ["write", undefined],
    ["read", { networkAccess: false }],
    ["read", { writableRoots: ["/cache"] }],
  ] as const)("codex %s + web turns network access on (project sandbox %o)", (access, sb) => {
    const argv = argvFor("codex", "investigator", "x", {
      mode: mode(access, "web"),
      codexSandbox: sb,
    });
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    if (sb && "writableRoots" in sb)
      expect(argv).toContain('sandbox_workspace_write.writable_roots=["/cache"]');
    expect(argv.at(-1)).toBe(documentBrief("investigator", "x"));
  });

  it("codex without web follows the project's network setting", () => {
    expect(
      argvFor("codex", "implementer", "x", {
        mode: mode("read", "none"),
        codexSandbox: { networkAccess: false },
      }),
    ).not.toContain("sandbox_workspace_write.network_access=true");
  });

  it("changes only the brief of other agent kinds, and nothing for shell", () => {
    for (const kind of ["gemini", "opencode"]) {
      expect(argvFor(kind, "implementer", "x", { mode: mode("read", "web") })).toEqual(
        argvFor(kind, "implementer", `x\n\n${DOCUMENT_CONTRACT}`),
      );
    }
    expect(argvFor("shell", "implementer", "x", { mode: mode("read", "web") })).toEqual(
      argvFor("shell", "implementer", "x"),
    );
  });

  it("ends a document task's brief with the document contract, for agent kinds only", () => {
    for (const kind of ["claude", "codex"]) {
      const argv = argvFor(kind, "investigator", "Answer it", { mode: mode("read", "none") });
      expect(argv.at(-1)).toBe(briefFor("investigator", `Answer it\n\n${DOCUMENT_CONTRACT}`));
      expect(argv.at(-1)).toContain(".mimir/artifacts/<name>.md");
    }
    expect(
      argvFor("claude", "implementer", "x", { mode: mode("write", "none", "diff") }).at(-1),
    ).not.toContain(DOCUMENT_CONTRACT);
    expect(argvFor("shell", "implementer", "echo x", { mode: mode("read", "none") })).toEqual([
      "sh",
      "-c",
      "echo x",
    ]);
  });
});
