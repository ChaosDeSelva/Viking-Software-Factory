import { describe, expect, it } from "vitest";
import { ApprovalAuthority } from "./approval.js";
import { ApiError } from "./errors.js";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e);
  }
  return "ok";
};

describe("ApprovalAuthority (review m3, m4)", () => {
  it("locks minting for a growing window after wrong codes instead of until restart", () => {
    let t = 0;
    const a = new ApprovalAuthority({ pairingCode: "ABCDE-FGH23", now: () => new Date(t) });
    for (let i = 0; i < 5; i++)
      expect(codeOf(() => a.mint("WRONG", "web"))).toBe("approval_pairing_failed");
    expect(codeOf(() => a.mint("ABCDE-FGH23", "web"))).toBe("approval_locked");
    t += 60_000;
    expect(codeOf(() => a.mint("ABCDE-FGH23", "web"))).toBe("ok");
    for (let i = 0; i < 5; i++) codeOf(() => a.mint("WRONG", "web"));
    t += 60_000;
    expect(codeOf(() => a.mint("ABCDE-FGH23", "web"))).toBe("approval_locked");
    t += 60_000;
    expect(codeOf(() => a.mint("ABCDE-FGH23", "web"))).toBe("ok");
  });

  it("prunes expired sessions when minting", () => {
    let t = 0;
    const a = new ApprovalAuthority({
      pairingCode: "ABCDE-FGH23",
      ttlMs: 1000,
      now: () => new Date(t),
    });
    a.mint("ABCDE-FGH23", "web");
    a.mint("ABCDE-FGH23", "cli");
    expect(a.activeSessions()).toBe(2);
    t += 2000;
    a.mint("ABCDE-FGH23", "web");
    expect(a.activeSessions()).toBe(1);
  });
});
