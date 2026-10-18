import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMimirError } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeAbsolutePath,
  assertSlug,
  assertNoSymlinkBelow,
  branchNameFor,
  isInside,
} from "./paths.js";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isMimirError(err) ? err.code : "non-mimir";
  }
  return undefined;
}

describe("assertSafeAbsolutePath", () => {
  it("accepts a normal absolute path and returns it normalized", () => {
    expect(assertSafeAbsolutePath("/a/b//c/", "p")).toBe("/a/b/c");
  });
  it("rejects relative paths", () => {
    expect(code(() => assertSafeAbsolutePath("a/b", "p"))).toBe("validation_failed");
  });
  it("rejects any .. segment, even ones normalization would collapse", () => {
    expect(code(() => assertSafeAbsolutePath("/a/../b", "p"))).toBe("validation_failed");
    expect(code(() => assertSafeAbsolutePath("/a/b/..", "p"))).toBe("validation_failed");
  });
  it("rejects NUL bytes and empty strings", () => {
    expect(code(() => assertSafeAbsolutePath("/a/\0b", "p"))).toBe("validation_failed");
    expect(code(() => assertSafeAbsolutePath("", "p"))).toBe("validation_failed");
  });
  it("allows names that merely contain dots", () => {
    expect(assertSafeAbsolutePath("/a/..b/c..", "p")).toBe("/a/..b/c..");
  });
});

describe("assertSlug", () => {
  it("accepts [a-z0-9-] up to 40 chars", () => {
    expect(() => assertSlug("fix-login-2", "taskSlug")).not.toThrow();
    expect(() => assertSlug("a".repeat(40), "taskSlug")).not.toThrow();
  });
  it.each(["", "A", "a_b", "a/b", "a..b", "a b", "a".repeat(41), "-lead", "trail-"])(
    "rejects %j",
    (s) => {
      expect(code(() => assertSlug(s, "taskSlug"))).toBe("validation_failed");
    },
  );
});

describe("branchNameFor", () => {
  it("builds mimir/<crew>/<taskId>-<taskSlug>", () => {
    expect(branchNameFor("core", "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV", "fix-it")).toBe(
      "mimir/core/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV-fix-it",
    );
  });
});

describe("isInside", () => {
  it("is true for the dir itself and descendants only", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});

describe("assertNoSymlinkBelow", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mimir-git-paths-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when components are real dirs or missing", async () => {
    await mkdir(join(dir, "a"));
    await expect(assertNoSymlinkBelow(dir, join(dir, "a", "b", "c"))).resolves.toBeUndefined();
  });
  it("rejects a symlinked intermediate component", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mimir-git-outside-"));
    try {
      await symlink(outside, join(dir, "a"));
      await expect(assertNoSymlinkBelow(dir, join(dir, "a", "b"))).rejects.toMatchObject({
        code: "validation_failed",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("rejects a symlinked final component", async () => {
    await symlink(dir, join(dir, "link"));
    await expect(assertNoSymlinkBelow(dir, join(dir, "link"))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});
