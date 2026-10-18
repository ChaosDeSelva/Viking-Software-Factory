import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrokkrError,
  BundleWriter,
  HarnessManifestSchema,
  LEDGER_FILE,
  PolicyLayerSchema,
  canonicalJson,
  cleanupBundle,
  createLogger,
  formatIssues,
  isSafeRelativePath,
  listTreeFiles,
  parseManifestText,
  treeDigest,
  validateWith,
} from "./index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "brokkr-core-edge-"));
}

describe("digest edge cases", () => {
  it("lists nested files in sorted order", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "b", "c"), { recursive: true });
    writeFileSync(join(dir, "z.txt"), "z");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b", "c", "d.txt"), "d");
    writeFileSync(join(dir, "b", "a.txt"), "a");
    expect(await listTreeFiles(dir)).toEqual(["a.txt", "b/a.txt", "b/c/d.txt", "z.txt"]);
  });

  it("refuses symlinks", async () => {
    const dir = tmp();
    symlinkSync("/etc/hosts", join(dir, "link"));
    await expect(treeDigest(dir)).rejects.toThrow(/refusing to hash symlink/);
  });

  it("canonicalJson sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }, null], e: "x" })).toBe(
      '{"a":[{"d":1},null],"b":1,"e":"x"}',
    );
  });
});

describe("validation edge cases", () => {
  it("parses JSON documents and reports JSON syntax errors", () => {
    const ok = parseManifestText('{"a":1}', HarnessManifestSchema, "h.json");
    expect(ok.ok).toBe(false);
    const bad = parseManifestText("{", HarnessManifestSchema, "h.json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.message).toMatch(/^JSON parse error/);
    const yaml = parseManifestText("a: [", HarnessManifestSchema, "h.yaml");
    if (!yaml.ok) expect(yaml.issues[0]?.message).toMatch(/^YAML parse error/);
  });

  it("formatIssues prints file and root paths", () => {
    expect(
      formatIssues([
        { path: "", message: "bad", file: "x.yaml" },
        { path: "a.b", message: "worse" },
      ]),
    ).toBe("x.yaml: (root): bad\na.b: worse");
  });

  it("reports unrecognized keys with their names", () => {
    const result = validateWith(PolicyLayerSchema, { network: "deny", surprise: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/surprise$/);
  });
});

describe("schemas edge cases", () => {
  it("isSafeRelativePath rejects NUL, backslashes, absolute and drive paths", () => {
    for (const p of ["", "a\0b", "a\\b", "/etc", "C:x", "..", "../x", "a/../../x"])
      expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
    for (const p of ["a", "a/b", "./a", "a/../b"]) expect(isSafeRelativePath(p), p).toBe(true);
  });

  it("rejects duplicate check ids and skills listed twice", () => {
    const m = {
      apiVersion: "brokkr.dev/v1alpha1",
      kind: "Harness",
      metadata: { name: "h", version: "1.0.0", description: "d" },
      compatibility: { platforms: ["linux"], taskTypes: [] },
      skills: { required: ["a"], optional: ["a"] },
      workflow: { stages: [] },
      checks: [
        { id: "t", command: ["x"], required: true, timeoutSeconds: 1 },
        { id: "t", command: ["y"], required: true, timeoutSeconds: 1 },
      ],
      policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: [] },
      evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: true },
    };
    const result = validateWith(HarnessManifestSchema, m);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((i) => i.message).join()).toMatch(
        /duplicate check id.*both required and optional/,
      );
  });
});

describe("logger and errors", () => {
  const saved = process.env.BROKKR_LOG_LEVEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.BROKKR_LOG_LEVEL;
    else process.env.BROKKR_LOG_LEVEL = saved;
  });

  it("createLogger honours explicit level, env level and the default", () => {
    expect(createLogger({ level: "error", name: "x" }).level).toBe("error");
    process.env.BROKKR_LOG_LEVEL = "debug";
    expect(createLogger().level).toBe("debug");
    delete process.env.BROKKR_LOG_LEVEL;
    expect(createLogger().level).toBe("warn");
  });

  it("BrokkrError keeps its cause and details", () => {
    const cause = new Error("root");
    const e = new BrokkrError("infra", "wrapped", { cause, details: { a: 1 } });
    expect(e.cause).toBe(cause);
    expect(e.details).toEqual({ a: 1 });
    expect(new BrokkrError("infra", "plain").cause).toBeUndefined();
  });
});

describe("bundle edge cases", () => {
  function writer(cwd: string, rootDir = join(cwd, ".brokkr/generated/x")) {
    return new BundleWriter({ cwd, rootDir, adapterId: "t", adapterVersion: "1" });
  }

  it("refuses a bundle directory outside cwd", () => {
    const cwd = tmp();
    expect(() => writer(cwd, tmp())).toThrow(/outside/);
  });

  it("rewrites its own file in place and refuses foreign files", async () => {
    const cwd = tmp();
    const w = writer(cwd);
    const file = join(cwd, ".brokkr/generated/x/a.md");
    await w.writeFile(file, "one");
    await w.writeFile(file, "two");
    const prepared = await w.commit(file);
    expect(prepared.files).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("two");
    writeFileSync(join(cwd, "mine.md"), "user");
    await expect(writer(cwd).writeFile(join(cwd, "mine.md"), "x")).rejects.toThrow(
      /not written by brokkr/,
    );
  });

  it("upserting a block twice replaces it and keeps surrounding text", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.md"), "intro");
    const w = writer(cwd);
    await w.upsertBlock(join(cwd, "CLAUDE.md"), "v1");
    await w.upsertBlock(join(cwd, "CLAUDE.md"), "v2");
    const text = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(text.startsWith("intro\n\n")).toBe(true);
    expect(text).toContain("v2");
    expect(text).not.toContain("v1");

    const created = writer(cwd);
    await created.upsertBlock(join(cwd, "AGENTS.md"), "only");
    await created.commit(join(cwd, "AGENTS.md"));
    const result = await cleanupBundle(join(cwd, ".brokkr/generated/x"), cwd, {
      allowProjectFiles: true,
    });
    expect(result.removed).toEqual(["AGENTS.md"]);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("an unterminated block marker is left alone", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.md"), "x\n<!-- brokkr:begin t -->\nno end\n");
    await writer(cwd).upsertBlock(join(cwd, "CLAUDE.md"), "new");
    const text = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(text).toContain("no end");
    expect(text).toContain("new");
  });

  it("cleanup handles missing paths, foreign roots and odd ledgers", async () => {
    const cwd = tmp();
    expect(await cleanupBundle(join(cwd, "missing"), cwd)).toEqual({ removed: [], skipped: [] });
    const outside = tmp();
    await expect(cleanupBundle(outside, cwd)).rejects.toThrow(/outside/);

    const root = join(cwd, "bundle");
    mkdirSync(root);
    expect(await cleanupBundle(root, cwd)).toEqual({ removed: [], skipped: [] });
    mkdirSync(join(root, LEDGER_FILE));
    await expect(cleanupBundle(root, cwd)).rejects.toThrow(/not a regular file/);
  });

  it("cleanup skips directories and vanished entries, and keeps non-empty or linked dirs", async () => {
    const cwd = tmp();
    const root = join(cwd, "bundle");
    mkdirSync(join(root, "dir"), { recursive: true });
    mkdirSync(join(cwd, "real"));
    symlinkSync(join(cwd, "real"), join(root, "linkdir"));
    writeFileSync(
      join(root, LEDGER_FILE),
      JSON.stringify({
        ledgerVersion: 1,
        adapterId: "t",
        adapterVersion: "1",
        files: [
          {
            relativePath: "bundle/dir",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            bytes: 0,
            mode: "created",
          },
          {
            relativePath: "bundle/gone.md",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            bytes: 0,
            mode: "created",
          },
          {
            relativePath: "bundle/b.md",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            bytes: 0,
            mode: "block",
            blockText: "<!-- brokkr:begin t -->\nx\n<!-- brokkr:end t -->",
          },
        ],
        dirs: ["bundle/linkdir", "bundle/none", "../escape", "bundle/dir"],
      }),
    );
    writeFileSync(join(root, "b.md"), "text");
    const result = await cleanupBundle(root, cwd);
    expect(result.skipped).toEqual([
      { path: "bundle/dir", reason: "is not a regular file" },
      {
        path: "bundle/b.md",
        reason: "digest mismatch: brokkr block modified since it was written",
      },
    ]);
    expect(existsSync(join(root, "dir"))).toBe(false);
    expect(existsSync(join(cwd, "real"))).toBe(true);
  });
});
