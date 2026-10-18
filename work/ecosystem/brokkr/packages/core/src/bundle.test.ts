import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BundleWriter, LEDGER_FILE, cleanupBundle, sha256Digest } from "./index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "brokkr-bundle-"));
}

describe("BundleWriter", () => {
  it("records written files with digests and cleanup removes only those files", async () => {
    const cwd = tmp();
    const root = join(cwd, ".brokkr/generated/task-context/T-1/test");
    const writer = new BundleWriter({
      cwd,
      rootDir: root,
      adapterId: "test",
      adapterVersion: "0.0.1",
    });
    await writer.writeFile(join(root, "A.md"), "alpha");
    await writer.writeFile(join(root, "nested/deep/B.md"), "beta");
    const prepared = await writer.commit(join(root, "A.md"));

    expect(prepared.adapterId).toBe("test");
    expect(prepared.files.map((f) => f.relativePath)).toEqual([
      ".brokkr/generated/task-context/T-1/test/A.md",
      ".brokkr/generated/task-context/T-1/test/nested/deep/B.md",
    ]);
    expect(prepared.files[0]?.digest).toBe(sha256Digest("alpha"));
    expect(existsSync(prepared.ledgerPath)).toBe(true);

    writeFileSync(join(root, "nested/user-notes.md"), "mine");
    const { removed, skipped } = await cleanupBundle(root, cwd);
    expect(skipped).toEqual([]);
    expect(removed.sort()).toEqual([
      ".brokkr/generated/task-context/T-1/test/A.md",
      ".brokkr/generated/task-context/T-1/test/nested/deep/B.md",
    ]);
    expect(existsSync(join(root, "A.md"))).toBe(false);
    expect(existsSync(join(root, "nested/deep"))).toBe(false);
    expect(readFileSync(join(root, "nested/user-notes.md"), "utf8")).toBe("mine");
  });

  it("refuses to write outside cwd", async () => {
    const cwd = tmp();
    const writer = new BundleWriter({
      cwd,
      rootDir: join(cwd, "out"),
      adapterId: "t",
      adapterVersion: "1",
    });
    await expect(writer.writeFile(join(cwd, "../escape.md"), "x")).rejects.toThrow(/outside/);
  });

  it("refuses to overwrite a file it did not write", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "out"));
    writeFileSync(join(cwd, "out/existing.md"), "user");
    const writer = new BundleWriter({
      cwd,
      rootDir: join(cwd, "out"),
      adapterId: "t",
      adapterVersion: "1",
    });
    await expect(writer.writeFile(join(cwd, "out/existing.md"), "x")).rejects.toThrow(
      /not written by brokkr/,
    );
    expect(readFileSync(join(cwd, "out/existing.md"), "utf8")).toBe("user");
  });

  it("upserts and removes a marked block in an existing project file", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project rules\n\nKeep me.\n");
    const root = join(cwd, ".brokkr/generated/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "t", adapterVersion: "1" });
    await writer.upsertBlock(join(cwd, "CLAUDE.md"), "brokkr content");
    await writer.commit(join(cwd, "CLAUDE.md"));
    const withBlock = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(withBlock).toContain("Keep me.");
    expect(withBlock).toContain("<!-- brokkr:begin t -->\nbrokkr content\n<!-- brokkr:end t -->");

    await cleanupBundle(root, cwd, { allowProjectFiles: true });
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("# Project rules\n\nKeep me.\n");
  });

  it("deletes a block-only file it created", async () => {
    const cwd = tmp();
    const root = join(cwd, ".brokkr/generated/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "t", adapterVersion: "1" });
    await writer.upsertBlock(join(cwd, "AGENTS.md"), "content");
    await writer.commit(join(cwd, "AGENTS.md"));
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    await cleanupBundle(root, cwd, { allowProjectFiles: true });
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("cleanup of a missing bundle is a no-op", async () => {
    const cwd = tmp();
    expect(await cleanupBundle(join(cwd, "nothing"), cwd)).toEqual({ removed: [], skipped: [] });
  });
});

describe("cleanupBundle security", () => {
  async function prepared(): Promise<{ cwd: string; root: string; outside: string }> {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "victim.txt"), "precious");
    const root = join(cwd, ".brokkr/generated/task-context/T/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "x", adapterVersion: "1" });
    await writer.writeFile(join(root, "A.md"), "alpha");
    await writer.commit(join(root, "A.md"));
    return { cwd, root, outside };
  }

  function tamper(
    root: string,
    mutate: (ledger: { files: Array<Record<string, unknown>>; dirs: string[] }) => void,
  ): void {
    const path = join(root, LEDGER_FILE);
    const ledger = JSON.parse(readFileSync(path, "utf8"));
    mutate(ledger);
    writeFileSync(path, JSON.stringify(ledger));
  }

  it("never deletes a ledger entry that escapes cwd with ../", async () => {
    const { cwd, root, outside } = await prepared();
    const escape = relative(cwd, join(outside, "victim.txt"));
    expect(escape.startsWith("..")).toBe(true);
    tamper(root, (l) =>
      l.files.push({
        relativePath: escape,
        digest: sha256Digest("precious"),
        bytes: 8,
        mode: "created",
      }),
    );
    const { skipped } = await cleanupBundle(root, cwd);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("precious");
    expect(skipped.map((s) => s.path)).toContain(escape);
  });

  it("never follows a symlinked file inside the bundle to a target outside", async () => {
    const { cwd, root, outside } = await prepared();
    symlinkSync(join(outside, "victim.txt"), join(root, "link.md"));
    tamper(root, (l) =>
      l.files.push({
        relativePath: ".brokkr/generated/task-context/T/x/link.md",
        digest: sha256Digest("precious"),
        bytes: 8,
        mode: "created",
      }),
    );
    const { skipped } = await cleanupBundle(root, cwd);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("precious");
    expect(skipped.map((s) => s.path)).toContain(".brokkr/generated/task-context/T/x/link.md");
  });

  it("never follows a symlinked directory inside the bundle to a target outside", async () => {
    const { cwd, root, outside } = await prepared();
    symlinkSync(outside, join(root, "dirlink"));
    tamper(root, (l) =>
      l.files.push({
        relativePath: ".brokkr/generated/task-context/T/x/dirlink/victim.txt",
        digest: sha256Digest("precious"),
        bytes: 8,
        mode: "created",
      }),
    );
    await cleanupBundle(root, cwd);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("precious");
  });

  it("skips (does not delete) a file whose content changed since it was written", async () => {
    const { cwd, root } = await prepared();
    writeFileSync(join(root, "A.md"), "edited by a human");
    const { removed, skipped } = await cleanupBundle(root, cwd);
    expect(removed).toEqual([]);
    expect(skipped).toEqual([
      { path: ".brokkr/generated/task-context/T/x/A.md", reason: expect.stringMatching(/digest/) },
    ]);
    expect(readFileSync(join(root, "A.md"), "utf8")).toBe("edited by a human");
  });

  it("does not rewrite a project file whose brokkr block was edited", async () => {
    const cwd = tmp();
    const root = join(cwd, ".brokkr/generated/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "t", adapterVersion: "1" });
    await writer.upsertBlock(join(cwd, "CLAUDE.md"), "content");
    await writer.commit(join(cwd, "CLAUDE.md"));
    const edited = readFileSync(join(cwd, "CLAUDE.md"), "utf8").replace("content", "human edit");
    writeFileSync(join(cwd, "CLAUDE.md"), edited);
    const { skipped } = await cleanupBundle(root, cwd, { allowProjectFiles: true });
    expect(skipped.map((s) => s.path)).toEqual(["CLAUDE.md"]);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(edited);
  });
});

describe("cleanupBundle boundary", () => {
  it("leaves project files alone unless the caller allows project files", async () => {
    const cwd = tmp();
    const root = join(cwd, ".brokkr/generated/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "t", adapterVersion: "1" });
    await writer.upsertBlock(join(cwd, "CLAUDE.md"), "content");
    await writer.commit(join(cwd, "CLAUDE.md"));
    const { removed, skipped } = await cleanupBundle(root, cwd);
    expect(removed).toEqual([]);
    expect(skipped).toEqual([{ path: "CLAUDE.md", reason: expect.stringMatching(/outside/) }]);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain("content");
  });
});

describe("BundleWriter symlink guard", () => {
  it("refuses to write through a symlinked directory that points outside cwd", async () => {
    const cwd = tmp();
    const outside = tmp();
    mkdirSync(join(cwd, "out"));
    symlinkSync(outside, join(cwd, "out/escape"));
    const writer = new BundleWriter({
      cwd,
      rootDir: join(cwd, "out"),
      adapterId: "t",
      adapterVersion: "1",
    });
    await expect(writer.writeFile(join(cwd, "out/escape/pwned.md"), "x")).rejects.toThrow(
      /outside/,
    );
    expect(existsSync(join(outside, "pwned.md"))).toBe(false);
  });

  it("refuses to upsert a block into a symlinked project file", async () => {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "real.md"), "real");
    symlinkSync(join(outside, "real.md"), join(cwd, "CLAUDE.md"));
    const writer = new BundleWriter({
      cwd,
      rootDir: join(cwd, "out"),
      adapterId: "t",
      adapterVersion: "1",
    });
    await expect(writer.upsertBlock(join(cwd, "CLAUDE.md"), "x")).rejects.toThrow(/symlink/);
    expect(readFileSync(join(outside, "real.md"), "utf8")).toBe("real");
  });
});

describe("ledger hardening (review M1-M3)", () => {
  it("M1: a malformed ledger is an invalid-config error (exit 2), not a crash", async () => {
    const cwd = tmp();
    const root = join(cwd, ".brokkr/generated/x");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, LEDGER_FILE), JSON.stringify({ files: "nope" }));
    await expect(cleanupBundle(root, cwd)).rejects.toMatchObject({
      code: "invalid-config",
      exitCode: 2,
    });
  });

  it("M2: a block entry without brokkr markers is skipped even when project files are allowed", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "README.md"), "# Readme\nknown text\n");
    const root = join(cwd, ".brokkr/generated/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "t", adapterVersion: "1" });
    await writer.commit(join(root, "x"));
    const ledgerPath = join(root, LEDGER_FILE);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.files.push({
      relativePath: "README.md",
      digest: sha256Digest("known text\n"),
      bytes: 11,
      mode: "block",
      blockText: "known text\n",
      createdFile: true,
    });
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const { skipped } = await cleanupBundle(root, cwd, { allowProjectFiles: true });
    expect(skipped.map((s) => s.path)).toEqual(["README.md"]);
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("# Readme\nknown text\n");
  });

  it("M3: recorded directories outside the boundary are not removed", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "empty-project-dir"));
    const root = join(cwd, ".brokkr/generated/x");
    const writer = new BundleWriter({ cwd, rootDir: root, adapterId: "t", adapterVersion: "1" });
    await writer.commit(join(root, "x"));
    const ledgerPath = join(root, LEDGER_FILE);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.dirs.push("empty-project-dir");
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    await cleanupBundle(root, cwd);
    expect(existsSync(join(cwd, "empty-project-dir"))).toBe(true);
  });
});
