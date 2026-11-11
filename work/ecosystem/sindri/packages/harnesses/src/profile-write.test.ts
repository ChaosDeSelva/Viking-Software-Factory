import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProfileHarness, profileHarnessManifest, type ExecutionProfile } from "./profile.js";

// A concurrent writer can create the harness between the existence check and the rename.
// `beforeRename` injects that at the rename; every other fs call is real.
let beforeRename: ((to: string) => void) | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: realFs.PathLike, to: realFs.PathLike) => {
      beforeRename?.(String(to));
      fs.renameSync(from, to);
    },
  };
});

const PROFILE: ExecutionProfile = { checks: [{ id: "test", command: ["make", "test"] }] };

describe("ensureProfileHarness write races", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = realFs.mkdtempSync(join(tmpdir(), "sindri-brokkr-home-"));
    root = join(home, ".brokkr", "harnesses");
  });
  afterEach(() => {
    beforeRename = undefined;
    realFs.rmSync(home, { recursive: true, force: true });
  });

  const leftovers = () => realFs.readdirSync(root).filter((n) => n.startsWith("."));

  it("keeps the harness another writer finished first and removes its own temp dir", () => {
    const { name } = profileHarnessManifest("P", PROFILE)!;
    beforeRename = (to) => {
      realFs.mkdirSync(to);
      realFs.writeFileSync(join(to, "harness.json"), "{\"winner\":true}\n");
    };
    expect(ensureProfileHarness(root, "P", PROFILE)).toEqual({ name, version: "1.0.0" });
    expect(realFs.readFileSync(join(root, name, "harness.json"), "utf8")).toBe(
      "{\"winner\":true}\n",
    );
    expect(leftovers()).toEqual([]);
  });

  it("throws when the target is an unrelated non-empty directory, leaving no temp dir", () => {
    const { name } = profileHarnessManifest("P", PROFILE)!;
    realFs.mkdirSync(join(root, name), { recursive: true });
    realFs.writeFileSync(join(root, name, "stray.txt"), "x");
    expect(() => ensureProfileHarness(root, "P", PROFILE)).toThrow(/ENOTEMPTY|EEXIST/);
    expect(realFs.existsSync(join(root, name, "harness.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});
