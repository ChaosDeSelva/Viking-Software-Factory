/**
 * readGeneratedBundles against a workspace that changes between listing and
 * reading. The swaps are simulated by intercepting `node:fs/promises` so that
 * one path's listing (lstat) or resolution (realpath) disagrees with the disk.
 */
import { execFileSync } from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp as tempDir } from "../test/helpers.js";

const hooks = vi.hoisted(() => ({
  lstat: undefined as undefined | ((path: string) => unknown),
  realpath: undefined as undefined | ((path: string) => unknown),
  open: undefined as undefined | ((path: string, handle: unknown) => unknown),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    lstat: async (path: string) => (await hooks.lstat?.(path)) ?? real.lstat(path),
    realpath: async (path: string) => (await hooks.realpath?.(path)) ?? real.realpath(path),
    open: async (path: string, flags: number) => {
      const handle = await real.open(path, flags);
      return (await hooks.open?.(path, handle)) ?? handle;
    },
  };
});

const { lstat: realLstat } = await vi.importActual<typeof FsPromises>("node:fs/promises");
const { readGeneratedBundles } = await import("./bundles.js");

afterEach(() => {
  hooks.lstat = hooks.realpath = hooks.open = undefined;
});

function ws(): { dir: string; g: string } {
  const dir = tempDir("brokkr-bundle-races-");
  const g = join(dir, ".brokkr", "generated");
  mkdirSync(join(g, "sub"), { recursive: true });
  writeFileSync(join(g, "keep.md"), "kept\n");
  return { dir, g };
}

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

describe("readGeneratedBundles when the tree changes after listing", () => {
  it("refuses a file that became a symlink between lstat and open", async () => {
    const { dir, g } = ws();
    symlinkSync(join(g, "keep.md"), join(g, "swapped.md"));
    hooks.lstat = (p) => (p === join(g, "swapped.md") ? realLstat(join(g, "keep.md")) : undefined);
    const r = await readGeneratedBundles(dir);
    expect(r.files.map((f) => f.file)).toEqual([join(g, "keep.md")]);
    expect(r.warnings).toEqual([
      "refused to scan .brokkr/generated/swapped.md: it is a symlink (swapped after listing)",
    ]);
  });

  it("refuses a file that became a FIFO between lstat and open", async () => {
    const { dir, g } = ws();
    execFileSync("mkfifo", [join(g, "pipe.md")]);
    hooks.lstat = (p) => (p === join(g, "pipe.md") ? realLstat(join(g, "keep.md")) : undefined);
    const r = await readGeneratedBundles(dir);
    expect(r.warnings).toEqual([
      "refused to scan .brokkr/generated/pipe.md: it is not a regular file (swapped after listing)",
    ]);
  });

  it("refuses a file replaced by another inode after listing", async () => {
    const { dir, g } = ws();
    writeFileSync(join(g, "other.md"), "other\n");
    hooks.lstat = (p) => (p === join(g, "other.md") ? realLstat(join(g, "keep.md")) : undefined);
    const r = await readGeneratedBundles(dir);
    expect(r.files.map((f) => f.file)).toEqual([join(g, "keep.md")]);
    expect(r.warnings).toEqual([
      "refused to scan .brokkr/generated/other.md: it was replaced after listing",
    ]);
  });

  it("refuses a file whose directory resolves outside the workspace when opened", async () => {
    const { dir, g } = ws();
    writeFileSync(join(g, "sub", "inner.md"), "inner\n");
    const outside = tempDir("brokkr-bundle-outside-");
    // join() normalises "<file>/..": the first realpath of sub/ is the walk entering it,
    // the second the file's own parent check after open.
    let calls = 0;
    hooks.realpath = (p) => (p === join(g, "sub") && ++calls === 2 ? outside : undefined);
    const r = await readGeneratedBundles(dir);
    expect(r.files.map((f) => f.file)).toEqual([join(g, "keep.md")]);
    expect(r.warnings).toEqual([
      "refused to scan .brokkr/generated/sub/inner.md: it resolves outside the workspace",
    ]);
  });

  it("refuses a directory that resolves outside the workspace", async () => {
    const { dir, g } = ws();
    writeFileSync(join(g, "sub", "inner.md"), "inner\n");
    const outside = tempDir("brokkr-bundle-outside-");
    hooks.realpath = (p) => (p === join(g, "sub") ? outside : undefined);
    const r = await readGeneratedBundles(dir);
    expect(r.files.map((f) => f.file)).toEqual([join(g, "keep.md")]);
    expect(r.warnings).toEqual([
      "refused to scan .brokkr/generated/sub: it resolves outside the workspace",
    ]);
  });

  it("skips entries that vanish between readdir and lstat, and between the two lstats", async () => {
    const { dir, g } = ws();
    writeFileSync(join(g, "gone-early.md"), "x");
    writeFileSync(join(g, "gone-late.md"), "y");
    const seen = new Map<string, number>();
    hooks.lstat = (p) => {
      const n = (seen.get(p) ?? 0) + 1;
      seen.set(p, n);
      if (p === join(g, "gone-early.md")) throw enoent();
      if (p === join(g, "gone-late.md") && n === 2) throw enoent();
      return undefined;
    };
    const r = await readGeneratedBundles(dir);
    expect(r.files.map((f) => f.file)).toEqual([join(g, "keep.md")]);
    expect(r.warnings).toEqual([]);
  });

  it("reads only what is there when a file shrinks after fstat", async () => {
    const { dir, g } = ws();
    hooks.open = (p, handle) => {
      if (p !== join(g, "keep.md")) return undefined;
      const h = handle as FsPromises.FileHandle;
      return new Proxy(h, {
        get(target, key) {
          if (key === "stat")
            return async () => {
              const st = await target.stat();
              return new Proxy(st, {
                get: (s, k) => (k === "size" ? s.size + 100 : Reflect.get(s, k, s)),
              });
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const r = await readGeneratedBundles(dir);
    expect(r.files).toEqual([{ file: join(g, "keep.md"), text: "kept\n" }]);
  });
});

describe("readGeneratedBundles without a generated directory", () => {
  it("reads nothing from a .brokkr that has no generated bundles", async () => {
    const dir = tempDir("brokkr-bundle-races-");
    mkdirSync(join(dir, ".brokkr"));
    expect(await readGeneratedBundles(dir)).toEqual({ files: [], warnings: [] });
  });
});
