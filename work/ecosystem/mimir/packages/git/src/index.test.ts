import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@mimir/git", () => {
  it("exports its package name", () => {
    expect(api.PACKAGE_NAME).toBe("@mimir/git");
  });

  it("exposes the worktree API and no push/merge entry points", () => {
    expect(typeof api.GitManager).toBe("function");
    expect(typeof api.runTests).toBe("function");
    expect(typeof api.protectedBranchGuard).toBe("function");
    const names = [
      ...Object.keys(api),
      ...Object.getOwnPropertyNames(api.GitManager.prototype),
    ].map((n) => n.toLowerCase());
    expect(names.filter((n) => /^(push|merge|checkout)/.test(n))).toEqual([]);
  });
});
