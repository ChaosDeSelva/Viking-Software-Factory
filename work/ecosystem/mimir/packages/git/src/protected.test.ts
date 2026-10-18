import { describe, expect, it } from "vitest";
import { protectedBranchGuard } from "./protected.js";

describe("protectedBranchGuard", () => {
  const guard = protectedBranchGuard("/repo", { protected: ["main", "release/*"] });

  it("flags exact and wildcard matches, with or without refs/heads/", () => {
    expect(guard.isProtected("main")).toBe(true);
    expect(guard.isProtected("refs/heads/main")).toBe(true);
    expect(guard.isProtected("release/1.2")).toBe(true);
    expect(guard.isProtected("mimir/core/tsk_x-y")).toBe(false);
    expect(guard.isProtected("mainline")).toBe(false);
  });

  it("assertNotProtected throws policy_denied for protected branches", () => {
    expect(() => guard.assertNotProtected("main")).toThrow(
      expect.objectContaining({ code: "policy_denied" }),
    );
    expect(() => guard.assertNotProtected("feature/x")).not.toThrow();
  });

  it("exposes the repo path and a copy of the rules", () => {
    expect(guard.repoPath).toBe("/repo");
    expect(guard.rules.protected).toEqual(["main", "release/*"]);
  });
});
