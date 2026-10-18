import { randomUUID } from "node:crypto";
export type HookObservation = {
  id: string;
  state: "running" | "waiting" | "blocked";
  reason: string;
  observedAt: string;
};
/** Harness-reported observations are evidence of waiting, never delivery approval. */
export function normalizeHook(event: Record<string, unknown>): HookObservation | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const name = event["hook_event_name"] ?? event["type"];
  let state: HookObservation["state"] = "running",
    reason: string;
  if (
    name === "PermissionRequest" ||
    (name === "Notification" && event["notification_type"] === "permission_prompt")
  ) {
    state = "waiting";
    reason = "harness_permission_request";
  } else if (
    ["Stop", "StopFailure", "AfterAgent", "SessionEnd", "agent-turn-complete"].includes(
      String(name),
    ) ||
    name === "turn.end" ||
    (name === "Notification" &&
      ["idle_prompt", "agent_needs_input"].includes(String(event["notification_type"])))
  ) {
    state = "waiting";
    reason = "harness_awaiting_input";
  } else if (name === "agent.error") {
    state = "blocked";
    reason = "harness_error";
  } else if (name === "quota.wait") {
    state = "blocked";
    reason = "harness_quota_wait";
  } else if (
    [
      "BeforeAgent",
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "SessionStart",
      "turn.start",
      "tool.start",
      "tool.end",
    ].includes(String(name))
  )
    reason = "harness_working";
  else return null;
  return { id: randomUUID(), state, reason, observedAt: new Date().toISOString() };
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function claudeHookSettings(node: string, hook: string, file: string) {
  const command = `${quote(node)} ${quote(hook)} ${quote(file)}`;
  const entry = { hooks: [{ type: "command", command, timeout: 5 }] };
  return {
    hooks: {
      SessionStart: [entry],
      UserPromptSubmit: [entry],
      PreToolUse: [{ matcher: "*", ...entry }],
      PostToolUse: [{ matcher: "*", ...entry }],
      PermissionRequest: [{ matcher: "*", ...entry }],
      Notification: [{ matcher: "permission_prompt|idle_prompt|agent_needs_input", ...entry }],
      Stop: [entry],
    },
  };
}
