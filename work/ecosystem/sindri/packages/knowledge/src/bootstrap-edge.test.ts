import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { listCandidateFiles } from "./bootstrap.js";
import { openKnowledge, type Knowledge } from "./knowledge.js";

// Permission bits do not stop root, so the unreadable cases only mean something as a user.
const asRoot = process.getuid?.() === 0;

describe("bootstrapProject edge cases", { timeout: 30_000 }, () => {
  let repo: TempRepo | undefined;
  let k: Knowledge | undefined;
  const locked: string[] = [];

  afterEach(() => {
    for (const p of locked.splice(0)) chmodSync(p, 0o755);
    k?.close();
    repo?.cleanup();
    k = undefined;
    repo = undefined;
  });

  const bootstrap = (files: Record<string, string | Buffer>) => {
    repo = createTempRepo(files);
    k = openKnowledge(":memory:");
    const id = k.projects.create({ name: "d", repoPath: repo.path }).id;
    return { k, id, run: () => (k as Knowledge).bootstrapProject(id, { repoPath: repo!.path }) };
  };
  const testCommands = (kn: Knowledge) =>
    (
      kn.db
        .prepare(
          `SELECT c.text FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE d.path = 'sindri:test-commands'`,
        )
        .all() as { text: string }[]
    )
      .map((r) => r.text)
      .join("\n");

  it.skipIf(asRoot)("skips an unreadable directory instead of failing the whole bootstrap", () => {
    const b = bootstrap({ "README.md": "# Demo\n", "private/README.md": "# hidden\n" });
    const dir = join(repo!.path, "private");
    chmodSync(dir, 0o000);
    locked.push(dir);
    const res = b.run();
    expect(res.indexed).toContain("README.md");
    expect(res.skipped).toContainEqual({ path: "private/", reason: "unreadable" });
    expect(listCandidateFiles(repo!.path)).toEqual(["README.md"]);
  });

  it.skipIf(asRoot)("reports an unreadable directory with an unsafe name as unsafe_name", () => {
    const evil = "docs\u202Etxt";
    const b = bootstrap({ "README.md": "# Demo\n", [`${evil}/README.md`]: "# hidden\n" });
    const dir = join(repo!.path, evil);
    chmodSync(dir, 0o000);
    locked.push(dir);
    expect(b.run().skipped).toEqual([{ path: `${evil}/`, reason: "unsafe_name" }]);
  });

  it.skipIf(asRoot)("fails, keeping the previous index, when the repo root is unreadable", () => {
    const b = bootstrap({ "README.md": "# Demo\n" });
    expect(b.run().indexed).toContain("README.md");
    chmodSync(repo!.path, 0o000);
    locked.push(repo!.path);
    expect(() => b.run()).toThrow(/EACCES/);
    const paths = b.k.db.prepare("SELECT path FROM documents").all() as { path: string }[];
    expect(paths.map((r) => r.path)).toContain("README.md");
  });

  it.skipIf(asRoot)("skips an unreadable classified file as unreadable", () => {
    const b = bootstrap({ "README.md": "# Demo\n", "docs/guide.md": "# Guide\n" });
    const file = join(repo!.path, "docs/guide.md");
    chmodSync(file, 0o000);
    locked.push(file);
    const res = b.run();
    expect(res.indexed).toContain("README.md");
    expect(res.skipped).toContainEqual({ path: "docs/guide.md", reason: "unreadable" });
  });

  it("skips oversized and binary classified files", () => {
    const res = bootstrap({
      "README.md": "x".repeat(1024 * 1024 + 1),
      "docs/blob.md": Buffer.from([0x23, 0x00, 0x01]),
    }).run();
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { path: "README.md", reason: "too-large" },
        { path: "docs/blob.md", reason: "binary" },
      ]),
    );
  });

  it.each([
    ["yarn", { "yarn.lock": "" }],
    ["bun", { "bun.lockb": "" }],
    ["bun", { "bun.lock": "" }],
    ["npm", {}],
    // An ignored lockfile is not listed, but its presence still decides the package manager.
    ["pnpm", { "pnpm-lock.yaml": "", ".sindriignore": "pnpm-lock.yaml\n" }],
  ])("names %s as the package manager", (pm, extra: Record<string, string>) => {
    const b = bootstrap({
      ...extra,
      "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc", lint: 1 } }),
    });
    b.run();
    const doc = testCommands(b.k);
    expect(doc).toContain(`\`${pm} run test\` -> vitest run`);
    expect(doc).not.toContain("build");
    expect(doc).not.toContain("lint");
  });

  it("tolerates manifests without scripts or with invalid JSON", () => {
    const b = bootstrap({
      "package.json": "{ not json",
      "pkg/package.json": JSON.stringify({ name: "x" }),
      "tools/package.json": JSON.stringify({ scripts: { check: "tsc --noEmit" } }),
    });
    const res = b.run();
    expect(res.indexed).toEqual(expect.arrayContaining(["package.json", "pkg/package.json"]));
    expect(testCommands(b.k)).toBe(
      "# Test commands\n\n- `npm run check` (in tools) -> tsc --noEmit",
    );
  });

  it("lists only test-like make targets and just recipes", () => {
    const b = bootstrap({
      Makefile: "build:\n\tcc\n.PHONY: test\ntest: build\n\t./run\nX := 1\n",
      "sub/justfile": "default:\n  just --list\n@e2e target:\n  ./e2e {{target}}\n",
    });
    b.run();
    const doc = testCommands(b.k);
    expect(doc).toContain("- `make test` (Makefile)");
    expect(doc).toContain("- `just e2e` (in sub) (sub/justfile)");
    expect(doc).not.toMatch(/build|default|PHONY|`make X`/);
  });

  it("stops at an empty repo without a test-commands document", () => {
    mkdirSync(join((repo = createTempRepo({})).path, "empty"));
    k = openKnowledge(":memory:");
    const id = k.projects.create({ name: "d", repoPath: repo.path }).id;
    const res = k.bootstrapProject(id, { repoPath: repo.path });
    expect(res.indexed).toEqual(["sindri:structure"]);
  });
});
