import { describe, expect, it } from "vitest";
import { matchesAllowlist, type AllowlistEntry } from "./allowlist.js";
import { isLoopback } from "./http.js";
import { locate } from "./paths.js";

const ctx = { worktree: "/wt", cwd: [] as string[] };

describe("matchesAllowlist shapes", () => {
  const allowlist: AllowlistEntry[] = [
    {
      argv0: "mytool",
      args: {
        shape: {
          maxArgs: 2,
          forbidFlags: ["--exec"],
          pathArgsMustBeInsideWorktreeAndNonSensitive: false,
        },
      },
    },
  ];

  it("refuses a forbidden flag, exactly or with a value, and accepts other flags", () => {
    expect(matchesAllowlist(["mytool", "--exec"], allowlist, ctx)).toBe(false);
    expect(matchesAllowlist(["mytool", "--exec=x"], allowlist, ctx)).toBe(false);
    expect(matchesAllowlist(["mytool", "--execute"], allowlist, ctx)).toBe(true);
    expect(matchesAllowlist(["mytool", "--", "--exec"], allowlist, ctx)).toBe(true);
  });
});

describe("locate", () => {
  it("treats a path that climbs above the worktree root as outside", () => {
    expect(locate("../x", ctx)).toEqual({ kind: "outside" });
    expect(locate("/wt/../etc/passwd", ctx)).toEqual({ kind: "outside" });
    expect(locate("a/../b", ctx)).toEqual({ kind: "inside", rel: ["b"] });
  });
});

describe("isLoopback", () => {
  it("is false for a target that is not a parseable URL", () => {
    expect(isLoopback("http://[::1")).toBe(false);
    expect(isLoopback("localhost:8080")).toBe(true);
  });
});
