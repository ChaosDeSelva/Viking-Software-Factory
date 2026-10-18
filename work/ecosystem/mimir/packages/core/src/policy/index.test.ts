import { describe, expect, it } from "vitest";
import * as core from "../index.js";

describe("@mimir/core policy exports", () => {
  it.each([
    "PRIVILEGED_ACTIONS",
    "DEFAULT_EFFECTS",
    "isPrivilegedAction",
    "evaluate",
    "rulesFromPolicy",
    "ApprovalService",
    "policyDeniedEvent",
    "POLICY_EVENT_TYPES",
    "classifyCommand",
    "parseShell",
    "DEFAULT_PROTECTED_BRANCHES",
    "instructionsFromUntrustedText",
    "UNTRUSTED_INSTRUCTION_PATTERNS",
  ])("exports %s", (name) => {
    expect(core).toHaveProperty(name);
  });
});
