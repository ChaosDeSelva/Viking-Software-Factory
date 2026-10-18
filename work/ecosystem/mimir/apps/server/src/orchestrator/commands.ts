import { createHash } from "node:crypto";
import {
  DEFAULT_PROTECTED_BRANCHES,
  defaultAllowlist,
  type AllowlistEntry,
  type ClassifyOptions,
} from "@mimir/core";
import {
  ProjectSettingsSchema,
  type CrewMember,
  type Project,
  type ProjectSettings,
} from "@mimir/protocol";
import type { ReadModel } from "../readmodel.js";

/** The command Mimir runs to verify a task when the project configures none. */
export const DEFAULT_TEST_COMMAND: readonly string[] = ["npm", "test"];

/** Known project settings; an invalid stored value (an older store) yields `{}` for that key. */
export function projectSettings(project: Project | undefined): ProjectSettings {
  const parsed = ProjectSettingsSchema.safeParse(project?.settings ?? {});
  return parsed.success ? parsed.data : {};
}

/** Project entries extend the defaults; validated test argv is allowed exactly. */
export function allowlistOf(project: Project | undefined): readonly AllowlistEntry[] {
  const settings = projectSettings(project);
  const command = settings.testCommand;
  return [
    ...defaultAllowlist(),
    ...((settings.allowedCommands ?? []) as AllowlistEntry[]),
    ...(command?.[0] && !/^(?:.*\/)?(?:sh|bash|zsh|dash|fish|cmd|powershell|pwsh)$/.test(command[0])
      ? [{ argv0: command[0], args: { exact: command.slice(1) } }]
      : []),
  ];
}

/** `classifyCommand` options for a command run in `worktree` on `branch` of `project`. */
export function classifyOptions(
  project: Project | undefined,
  worktree: string,
  branch: string | undefined,
): ClassifyOptions {
  return {
    worktree,
    cwd: worktree,
    ...(branch !== undefined ? { currentBranch: branch } : {}),
    protectedBranches: projectSettings(project).protectedBranches ?? DEFAULT_PROTECTED_BRANCHES,
    allowlist: allowlistOf(project),
  };
}

/**
 * The project's test command as argv. Settings are argv arrays (validated at project creation);
 * a legacy string is treated as `sh -c <string>` so that it is classified (and gated) rather than
 * trusted.
 */
export function testCommandOf(project: Project | undefined): string[] {
  const raw = project?.settings["testCommand"];
  if (Array.isArray(raw) && raw.length > 0 && raw.every((w) => typeof w === "string")) {
    return raw as string[];
  }
  if (typeof raw === "string") return ["sh", "-c", raw];
  return [...DEFAULT_TEST_COMMAND];
}

/** Plain words separated by single spaces: `sh -c` runs exactly these words as argv. */
const PLAIN_WORDS = /^[A-Za-z0-9_./:=@%+,-]+(?: [A-Za-z0-9_./:=@%+,-]+)*$/;

/**
 * What the policy gate classifies for a session's argv:
 * - explicit task argv: exec argv for shell members; non-template agent flags need approval;
 * - a `shell` member's `sh -c <cmd>`: the words of `cmd` when it is plain words (no quoting,
 *   expansion, redirection or separators, so `sh` runs exactly that argv), else the full
 *   `sh -c` argv (which the exact allowlist never matches, so it needs approval);
 * - an agent kind's template argv: nothing (the brief is prompt text, `runtime.start` is not a
 *   privileged action).
 */
export function classifiedArgv(
  argv: readonly string[],
  explicit: boolean,
  agentKind: string,
  template?: readonly string[],
): string[] | null {
  if (explicit && agentKind !== "shell") {
    if (template && JSON.stringify(argv) === JSON.stringify(template)) return null;
    // Empty command heads can never be allowlisted. Agent arguments are not exec argv.
    return ["", ...argv];
  }
  if (explicit) return [...argv];
  if (agentKind !== "shell") return null;
  const cmd = argv[2];
  if (argv.length === 3 && argv[0] === "sh" && argv[1] === "-c" && cmd !== undefined) {
    return PLAIN_WORDS.test(cmd) ? cmd.split(" ") : [...argv];
  }
  return [...argv];
}

/** Short stable digest of an argv (binds an approval to the exact command). */
export function argvDigest(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 16);
}

/** The member that runs a crew's tasks: the implementer, else the first member. */
export function memberOf(rm: ReadModel, crewId: string): CrewMember | undefined {
  const members = [...rm.crewMembers.values()]
    .filter((m) => m.crewId === crewId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return members.find((m) => m.role === "implementer") ?? members[0];
}
