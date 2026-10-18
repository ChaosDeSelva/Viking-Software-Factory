import type { PolicyEffect } from "@mimir/protocol";

/** Every action that Mimir treats as privileged. Each one is deny-by-default. */
export const PRIVILEGED_ACTIONS = [
  "git.push",
  "git.merge_protected",
  "git.force_remove_worktree",
  "git.delete_branch",
  "fs.delete_outside_worktree",
  /** rm -rf, dd, mkfs, shutdown, reboot, sudo and similar shell patterns. */
  "shell.destructive",
  /**
   * A shell command the classifier cannot resolve (dynamic command names, unknown programs,
   * inline interpreter code, opaque runners). Fail-closed: it must be approved.
   */
  "shell.unclassified",
  "secret.read",
  "network.external_write",
  "deploy",
  /**
   * Installs or runs packages from a registry (local `npm i`, `pip install`, `npx`, `pnpm dlx`,
   * `npm init <pkg>`): lifecycle scripts and fetched code run. Requires approval by default.
   */
  "package.install",
  "package.install_global",
  "runtime.force_stop",
  /** An interactive agent is blocked on Claude Code's folder-trust dialog. */
  "runtime.accept_trust_prompt",
  "budget.override",
  "pr.create",
] as const;

export type PrivilegedAction = (typeof PRIVILEGED_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(PRIVILEGED_ACTIONS);

export function isPrivilegedAction(value: string): value is PrivilegedAction {
  return ACTION_SET.has(value);
}

const REQUIRE_APPROVAL_BY_DEFAULT: ReadonlySet<PrivilegedAction> = new Set([
  "runtime.accept_trust_prompt",
  "shell.unclassified",
  "package.install",
]);

/** The effect applied when no policy rule matches. */
export const DEFAULT_EFFECTS: Readonly<Record<PrivilegedAction, PolicyEffect>> = Object.freeze(
  Object.fromEntries(
    PRIVILEGED_ACTIONS.map((action) => [
      action,
      REQUIRE_APPROVAL_BY_DEFAULT.has(action) ? "require_approval" : "deny",
    ]),
  ) as Record<PrivilegedAction, PolicyEffect>,
);
