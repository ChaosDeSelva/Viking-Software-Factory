import { MimirError } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { AGENT_ARGV_TEMPLATES, ROLE_TEMPLATES, argvFor, briefFor } from "./templates.js";

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
});
