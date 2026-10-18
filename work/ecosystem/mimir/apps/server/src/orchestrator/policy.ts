import type { PolicyRule } from "@mimir/core";

/**
 * Server defaults on top of core's `DEFAULT_EFFECTS` (deny for every privileged action except
 * trust prompts and unclassified shell commands, which need approval). Operator-initiated force
 * stops and pull requests are allowed with a human approval rather than denied outright, as the
 * API documents. `evaluate` breaks ties toward the stricter effect, so a configured `deny` for
 * the same action still wins.
 */
export const DEFAULT_SERVER_POLICIES: readonly PolicyRule[] = [
  { id: "mimir#force-stop", action: "runtime.force_stop", effect: "require_approval" },
  { id: "mimir#pr-create", action: "pr.create", effect: "require_approval" },
];
