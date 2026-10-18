import { interactiveArgv } from "./terminal-runtime/adapter.js";
import { MimirError, type CrewRole } from "@mimir/protocol";

/** Placeholder replaced (as one whole argv word) by the task brief or shell command. */
export const INSTRUCTION = "{{instruction}}";

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
    "Bash(npm run *),Bash(npm test *),Bash(pnpm run *),Bash(pnpm test *),Bash(node --test *),Bash(node --check *)",
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

/** The agent brief: the role preamble followed by the task's instruction. */
export function briefFor(role: CrewRole, instruction: string): string {
  // HerdR types argv into a terminal and rejects control characters. Preserve one prompt
  // argument while representing line boundaries as spaces.
  return `${ROLE_TEMPLATES[role].preamble} ${instruction}`.replace(/[\r\n\t]+/g, " ");
}

/**
 * Argv for a crew member of `agentKind` and `role` working on `instruction`. Shell members get
 * the instruction verbatim as the `sh -c` command; agent kinds get the role brief.
 */
export function argvFor(agentKind: string, role: CrewRole, instruction: string): string[] {
  const template = AGENT_ARGV_TEMPLATES[agentKind];
  if (template === undefined) {
    throw new MimirError("validation_failed", `no argv template for agent kind ${agentKind}`, {
      agentKind,
      known: Object.keys(AGENT_ARGV_TEMPLATES),
    });
  }
  const text = agentKind === "shell" ? instruction : briefFor(role, instruction);
  return template.map((word) => (word === INSTRUCTION ? text : word));
}
