import { expect, it } from "vitest";
import { normalizeHook, claudeHookSettings } from "./hooks.js";
it("reports permission and turn-end waits without accepting delivery", () => {
  expect(normalizeHook({ hook_event_name: "PermissionRequest" })?.reason).toBe(
    "harness_permission_request",
  );
  expect(
    normalizeHook({ hook_event_name: "Stop", last_assistant_message: "all tests passed" })?.state,
  ).toBe("waiting");
  expect(normalizeHook({ type: "completed" })).toBe(null);
});
it("does not persist sensitive hook tool inputs or arbitrary reasons", () => {
  const observation = normalizeHook({
    hook_event_name: "PreToolUse",
    tool_input: { password: "do-not-store" },
    reason: "arbitrary",
  });
  expect(JSON.stringify(observation)).not.toMatch(/do-not-store|arbitrary|password/);
  expect(observation?.state).toBe("running");
});
it("quotes paths in hook commands and never grants permissions", () => {
  const settings = claudeHookSettings("/path with spaces/node", "/hook's path", "/private/state");
  expect(settings.hooks.PermissionRequest[0]!.hooks[0]!.command).toContain("'\\''");
  expect(JSON.stringify(settings)).not.toMatch(/allow|approve|bypass/);
});

it.each([null, [], 1, "Stop"])("ignores malformed hook envelopes: %j", (value) => {
  expect(normalizeHook(value as unknown as Record<string, unknown>)).toBeNull();
});
it("maps notifications, errors and quota waits to their lifecycle facts", () => {
  const fact = (event: Record<string, unknown>) => {
    const observation = normalizeHook(event);
    return observation && [observation.state, observation.reason];
  };
  expect(fact({ hook_event_name: "Notification", notification_type: "permission_prompt" })).toEqual(
    ["waiting", "harness_permission_request"],
  );
  expect(fact({ hook_event_name: "Notification", notification_type: "idle_prompt" })).toEqual([
    "waiting",
    "harness_awaiting_input",
  ]);
  expect(fact({ hook_event_name: "Notification", notification_type: "auth_success" })).toBeNull();
  expect(fact({ type: "agent.error" })).toEqual(["blocked", "harness_error"]);
  expect(fact({ type: "quota.wait" })).toEqual(["blocked", "harness_quota_wait"]);
  expect(fact({ type: "turn.start" })).toEqual(["running", "harness_working"]);
});
