import * as realFs from "node:fs";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKnowledge, type Knowledge } from "./knowledge.js";

// The repo can change between the walk and the read (a file deleted, a symlink swapped in).
// These tests inject that change at one fs call for one path; every other call is real.

type Hook = (path: string) => unknown;
const hooks = new Map<string, Hook>();

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      const hook = hooks.get(name);
      if (hook && typeof a[0] === "string") {
        const r = hook(a[0]);
        if (r !== undefined) return r as R;
      }
      return fn(...a);
    };
  return {
    ...fs,
    lstatSync: wrap("lstatSync", fs.lstatSync),
    realpathSync: wrap("realpathSync", fs.realpathSync),
    openSync: wrap("openSync", fs.openSync),
    fstatSync: (fd: number) => {
      const r = hooks.get("fstatSync")?.(String(fd));
      return r === undefined ? fs.fstatSync(fd) : r;
    },
    readFileSync: (p: realFs.PathOrFileDescriptor, o?: never) => {
      const r = typeof p === "number" ? hooks.get("readFileSync")?.(String(p)) : undefined;
      return r === undefined ? fs.readFileSync(p, o) : r;
    },
  };
});

const errno = (code: string) => Object.assign(new Error(code), { code });

/** Make `fn` misbehave once for paths ending in `suffix`. */
const once = (fn: string, suffix: string, act: () => unknown) => {
  let done = false;
  hooks.set(fn, (p) => {
    if (done || !p.endsWith(suffix)) return undefined;
    done = true;
    return act();
  });
};

describe("bootstrapProject: files changing under the walk", () => {
  let repo: TempRepo;
  let k: Knowledge;
  let projectId: string;

  beforeEach(() => {
    repo = createTempRepo({ "README.md": "# Demo\n", "docs/guide.md": "# Guide\n" });
    k = openKnowledge(":memory:");
    projectId = k.projects.create({ name: "d", repoPath: repo.path }).id;
  });
  afterEach(() => {
    hooks.clear();
    k.close();
    repo.cleanup();
  });

  const run = () => k.bootstrapProject(projectId, { repoPath: repo.path });

  it.each([
    ["deleted after the symlink check", "lstatSync"],
    ["deleted before realpath", "realpathSync"],
  ])("silently drops a file %s", (_name, fn) => {
    // The symlink check lstats each path once; readContained lstats it a second time.
    let calls = 0;
    hooks.set(fn, (p) => {
      if (!p.endsWith("docs/guide.md")) return undefined;
      calls++;
      if (fn === "lstatSync" && calls === 1) return undefined;
      throw errno("ENOENT");
    });
    const res = run();
    expect(res.indexed).toContain("README.md");
    expect(res.indexed).not.toContain("docs/guide.md");
    expect(res.skipped.map((s) => s.path)).not.toContain("docs/guide.md");
  });

  it("drops a file that vanished between listing and the symlink check", () => {
    once("lstatSync", "docs/guide.md", () => {
      throw errno("ENOENT");
    });
    const res = run();
    expect(res.indexed).not.toContain("docs/guide.md");
    expect(res.skipped).toEqual([]);
  });

  it("reports symlink_escape when realpath leaves the root", () => {
    once("realpathSync", "docs/guide.md", () => "/etc/passwd");
    expect(run().skipped).toContainEqual({ path: "docs/guide.md", reason: "symlink_escape" });
  });

  it("reports symlink_escape when a symlink is swapped in before open (ELOOP)", () => {
    once("openSync", "docs/guide.md", () => {
      throw errno("ELOOP");
    });
    expect(run().skipped).toContainEqual({ path: "docs/guide.md", reason: "symlink_escape" });
  });

  it("reports special_file when the opened file is not regular", () => {
    let fd = -1;
    hooks.set("openSync", (p) => {
      if (!p.endsWith("docs/guide.md")) return undefined;
      hooks.delete("openSync");
      fd = realFs.openSync(p, "r");
      return fd;
    });
    hooks.set("fstatSync", (f) => (f === String(fd) ? { isFile: () => false } : undefined));
    expect(run().skipped).toContainEqual({ path: "docs/guide.md", reason: "special_file" });
  });

  it("reports unreadable when the read itself fails", () => {
    let fd = -1;
    hooks.set("openSync", (p) => {
      if (!p.endsWith("docs/guide.md")) return undefined;
      hooks.delete("openSync");
      fd = realFs.openSync(p, "r");
      return fd;
    });
    hooks.set("readFileSync", (f) => {
      if (f === String(fd)) throw errno("EIO");
      return undefined;
    });
    expect(run().skipped).toContainEqual({ path: "docs/guide.md", reason: "unreadable" });
  });
});
