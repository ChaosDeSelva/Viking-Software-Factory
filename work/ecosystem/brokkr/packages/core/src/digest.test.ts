import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, fileDigest, sha256Digest, treeDigest, treeManifest } from "./index.js";

function makeTree(files: Record<string, string>, order: string[] = Object.keys(files)): string {
  const dir = mkdtempSync(join(tmpdir(), "brokkr-digest-"));
  for (const rel of order) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, files[rel]!);
  }
  return dir;
}

describe("treeDigest", () => {
  const files = {
    "harness.yaml": "a: 1\n",
    "skills/x/skill.yaml": "b: 2\n",
    "skills/x/body.md": "# X\n",
  };

  it("is deterministic regardless of file creation order", async () => {
    const a = makeTree(files);
    const b = makeTree(files, Object.keys(files).reverse());
    const da = await treeDigest(a);
    expect(da).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await treeDigest(b)).toBe(da);
    expect(await treeDigest(a)).toBe(da);
  });

  it("changes when a single byte changes", async () => {
    const a = makeTree(files);
    const b = makeTree({ ...files, "skills/x/body.md": "# Y\n" });
    expect(await treeDigest(b)).not.toBe(await treeDigest(a));
  });

  it("changes when a file is renamed (paths are hashed)", async () => {
    const a = makeTree(files);
    const b = makeTree({
      "harness.yaml": "a: 1\n",
      "skills/x/skill.yaml": "b: 2\n",
      "skills/x/BODY.md": "# X\n",
    });
    expect(await treeDigest(b)).not.toBe(await treeDigest(a));
  });

  it("has no implicit skips: .DS_Store, node_modules and .git bytes are all covered", async () => {
    const base = {
      ...files,
      "node_modules/x/body.md": "one",
      ".git/HEAD": "ref",
      ".DS_Store": "a",
    };
    const a = makeTree(base);
    for (const changed of ["node_modules/x/body.md", ".git/HEAD", ".DS_Store"]) {
      const b = makeTree({ ...base, [changed]: base[changed as keyof typeof base] + "!" });
      expect(await treeDigest(b)).not.toBe(await treeDigest(a));
    }
  });

  it("refuses a symlink hidden under node_modules", async () => {
    const a = makeTree({ ...files, "node_modules/keep.txt": "x" });
    symlinkSync("/etc/hosts", join(a, "node_modules/body.md"));
    await expect(treeDigest(a)).rejects.toThrow(/symlink/);
  });

  it("a .brokkrignore is just another hashed file: nothing it lists is excluded", async () => {
    const base = { ...files, ".brokkrignore": "harness.yaml\nskills/\n" };
    const a = makeTree(base);
    const m = await treeManifest(a);
    expect(m.files).toEqual([
      ".brokkrignore",
      "harness.yaml",
      "skills/x/body.md",
      "skills/x/skill.yaml",
    ]);
    expect(Object.keys(m)).not.toContain("excluded");
    for (const changed of ["harness.yaml", "skills/x/body.md", ".brokkrignore"] as const) {
      const b = makeTree({ ...base, [changed]: `${base[changed]}!` });
      expect(await treeDigest(b)).not.toBe(m.digest);
    }
  });

  it("refuses FIFOs and other special files", async () => {
    const a = makeTree(files);
    execFileSync("mkfifo", [join(a, "skills/pipe")]);
    await expect(treeDigest(a)).rejects.toThrow(/special file/);
  });

  it("refuses symlinks so content cannot be swapped outside the tree", async () => {
    const a = makeTree(files);
    symlinkSync("/etc/hosts", join(a, "link"));
    await expect(treeDigest(a)).rejects.toThrow(/symlink/);
  });
});

describe("digest helpers", () => {
  it("sha256Digest and fileDigest agree", async () => {
    const dir = makeTree({ "f.txt": "hello" });
    expect(await fileDigest(join(dir, "f.txt"))).toBe(sha256Digest("hello"));
    expect(sha256Digest("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});
