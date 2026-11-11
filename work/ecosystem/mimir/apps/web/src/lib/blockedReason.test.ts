import { describe, expect, it } from "vitest";
import { describeBlockedReason } from "./blockedReason.js";

describe("describeBlockedReason", () => {
  it("maps every reason Mimir writes to plain words, keeping the raw value", () => {
    expect(describeBlockedReason("budget_exceeded")).toEqual({
      words: "Budget used up",
      raw: "budget_exceeded",
      known: true,
    });
    const known = [
      "budget_uncertain",
      "approval_required",
      "policy_denied",
      "unknown_after_restart",
      "blocked:trust_prompt",
      "blocked",
      "harness_error",
      "harness_quota_wait",
      "runtime_blocked",
      "approval_needed",
    ];
    for (const raw of known) {
      const r = describeBlockedReason(raw);
      expect(r.known, raw).toBe(true);
      expect(r.words).not.toBe(raw);
      expect(r.raw).toBe(raw);
    }
  });

  it("shows unknown values raw, including inherited object keys", () => {
    expect(describeBlockedReason("waiting on a person")).toEqual({
      words: "waiting on a person",
      raw: "waiting on a person",
      known: false,
    });
    expect(describeBlockedReason("toString").known).toBe(false);
  });

  it("never throws on empty input", () => {
    expect(describeBlockedReason("")).toEqual({ words: "", raw: "", known: false });
    expect(describeBlockedReason(undefined)).toEqual({ words: "", raw: "", known: false });
  });
});
