import { interactiveArgv } from "./terminal-runtime/adapter.js";
import { MimirError, type CrewRole, type TaskMode } from "@mimir/protocol";

/** Placeholder replaced (as one whole argv word) by the task brief or shell command. */
export const INSTRUCTION = "{{instruction}}";

/** Tools of a write-access Claude task: file edits (acceptEdits) plus the test commands. */
const CLAUDE_WRITE_TOOLS =
  "Bash(npm run *),Bash(npm test *),Bash(pnpm run *),Bash(pnpm test *),Bash(node --test *),Bash(node --check *)";

/**
 * Tools of a read-access Claude task: reading and git inspection, and writing only under the
 * worktree's `.mimir/artifacts/` (relative to the session's working directory, the worktree).
 */
export const CLAUDE_READ_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status *)",
  "Write(.mimir/artifacts/**)",
  "Edit(.mimir/artifacts/**)",
].join(",");

export const CLAUDE_WEB_TOOLS = "WebSearch,WebFetch";

/** Appended to the brief of a `document` task. */
export const DOCUMENT_CONTRACT =
  "Deliver a document, not a code change: write your deliverable as Markdown in .mimir/artifacts/<name>.md (top level of that directory; a review may write .mimir/artifacts/review.json instead). Do not modify source files: changes outside .mimir/artifacts/ are discarded.";

/**
 * Default argv per agent kind. The instruction always becomes exactly one argv element, so it is
 * never re-split by a shell on Mimir's side. `shell` is for tests and demos: the HerdR adapter runs
 * it by typing the command into the pane with an exit sentinel instead of `agent.start` (T8).
 */
export const AGENT_ARGV_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  claude: [
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
    CLAUDE_WRITE_TOOLS,
    "--output-format",
    "stream-json",
    "--verbose",
    INSTRUCTION,
  ],
  codex: ["codex", "exec", "--sandbox", "workspace-write", "--json", INSTRUCTION],
  opencode: ["opencode", "run", "--format", "json", INSTRUCTION],
  gemini: ["gemini", "--output-format", "json", "-p", INSTRUCTION],
  pi: ["pi", "--print", INSTRUCTION],
  ...Object.fromEntries(
    [
      "pi-signed",
      "grok",
      "kimi",
      "cursor",
      "muse",
      "rovo",
      "omp",
      "agy",
      "devin",
      "commandcode",
    ].map((kind) => [kind, interactiveArgv(kind, INSTRUCTION)]),
  ),
  shell: ["sh", "-c", INSTRUCTION],
};

/** Crew role templates: what each role is asked to do with a task brief (agent kinds only). */
export const ROLE_TEMPLATES: Readonly<Record<CrewRole, { preamble: string }>> = {
  lead: { preamble: "You are the lead of this crew. Plan and coordinate the work for this task." },
  implementer: { preamble: "You are the implementer. Make the change this task describes." },
  reviewer: {
    preamble: "You are the reviewer. Review the change for this task and report findings.",
  },
  qa: { preamble: "You are qa. Test the change for this task and report what fails." },
  investigator: {
    preamble: "You are the investigator. Investigate this task and report what you find.",
  },
};

/**
 * Claude's template adjusted for a task mode: `read` swaps acceptEdits for the default
 * permission mode (anything not allowed is refused in print mode) and narrows the tools; `web`
 * adds the web tools.
 */
function claudeArgv(template: readonly string[], mode: TaskMode | undefined): string[] {
  const read = mode?.access === "read";
  const tools = [read ? CLAUDE_READ_TOOLS : CLAUDE_WRITE_TOOLS];
  if (mode?.network === "web") tools.push(CLAUDE_WEB_TOOLS);
  return template.map((word, i) => {
    if (word === "acceptEdits" && template[i - 1] === "--permission-mode")
      return read ? "default" : word;
    if (template[i - 1] === "--allowedTools") return tools.join(",");
    return word;
  });
}

/** `settings.agent.codexSandbox` of the task's project. */
export interface CodexSandboxOptions {
  writableRoots?: readonly string[] | undefined;
  networkAccess?: boolean | undefined;
}

/**
 * Codex `-c key=value` overrides (the value is TOML) widening the `workspace-write` sandbox.
 * A JSON array of control-character-free strings is also a TOML array of basic strings.
 */
export function codexSandboxArgs(sandbox: CodexSandboxOptions | undefined): string[] {
  const args: string[] = [];
  if (sandbox?.writableRoots?.length) {
    args.push(
      "-c",
      `sandbox_workspace_write.writable_roots=${JSON.stringify(sandbox.writableRoots)}`,
    );
  }
  if (sandbox?.networkAccess === true) {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  return args;
}

/** The agent brief: the role preamble followed by the task's instruction. */
export function briefFor(role: CrewRole, instruction: string): string {
  // HerdR types argv into a terminal and rejects control characters. Preserve one prompt
  // argument while representing line boundaries as spaces.
  return `${ROLE_TEMPLATES[role].preamble} ${instruction}`.replace(/[\r\n\t]+/g, " ");
}

/**
 * Argv for a crew member of `agentKind` and `role` working on `instruction`. Shell members get
 * the instruction verbatim as the `sh -c` command; agent kinds get the role brief. Codex also
 * gets the project's sandbox overrides, placed before the brief. The task `mode` adjusts Claude's
 * tools and Codex's network access, and a `document` brief ends with `DOCUMENT_CONTRACT`. Codex
 * keeps `workspace-write` for read tasks so it can write `.mimir/artifacts/`; their worktree
 * edits are discarded instead (see the orchestrator).
 */
export function argvFor(
  agentKind: string,
  role: CrewRole,
  instruction: string,
  options: {
    codexSandbox?: CodexSandboxOptions | undefined;
    mode?: TaskMode | undefined;
  } = {},
): string[] {
  const template = AGENT_ARGV_TEMPLATES[agentKind];
  if (template === undefined) {
    throw new MimirError("validation_failed", `no argv template for agent kind ${agentKind}`, {
      agentKind,
      known: Object.keys(AGENT_ARGV_TEMPLATES),
    });
  }
  const text =
    agentKind === "shell"
      ? instruction
      : briefFor(
          role,
          options.mode?.deliverable === "document"
            ? `${instruction}\n\n${DOCUMENT_CONTRACT}`
            : instruction,
        );
  const extra =
    agentKind === "codex"
      ? codexSandboxArgs(
          options.mode?.network === "web"
            ? { ...options.codexSandbox, networkAccess: true }
            : options.codexSandbox,
        )
      : [];
  const words = agentKind === "claude" ? claudeArgv(template, options.mode) : template;
  return words.flatMap((word) => (word === INSTRUCTION ? [...extra, text] : [word]));
}
