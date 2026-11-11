// Synthetic credential shapes are assembled at runtime for redaction tests.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKnowledge, type Knowledge } from "./knowledge.js";

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `Filler line ${i + 1} about general setup and context.`);

const guideLines = [
  ...filler(24),
  "The flux capacitor requires exactly 1.21 gigawatts.",
  ...filler(20),
];
const FLUX_LINE = 25;

const FIXTURE: Record<string, string | Buffer> = {
  "README.md": "# Demo\n\nA demo project for Sindri bootstrap.\n",
  ".gitignore": "dist/\nnode_modules/\n",
  ".sindriignore": "docs/private/\n",
  ".env": "STRIPE_KEY=sk" + "_live_fakeSecretValue123\n",
  "config/aws-credentials.json": '{"secret":"hunter2credentialvalue"}\n',
  "certs/server.pem": "-----BEGIN PRIVATE KEY-----\npemsecretmaterial\n",
  "dist/bundle.md": "compiled artefact mentioning quasarbundle\n",
  "node_modules/left-pad/package.json": '{"name":"left-pad"}\n',
  "docs/guide.md": guideLines.join("\n") + "\n",
  "docs/adrs/0001-use-sqlite.md": "# ADR 1: Use SQLite\n\nStatus: accepted\n",
  "docs/private/notes.md": "private planning notes mentioning zebracorn\n",
  "docs/huge.md": "big ".repeat(300_000),
  "docs/blob.md": Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0x00, 0x41]),
  "package.json": JSON.stringify(
    { name: "demo", scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } },
    null,
    2,
  ),
  "packages/foo/package.json": JSON.stringify({ name: "foo", scripts: { "test:unit": "vitest" } }),
  Makefile:
    ".PHONY: test e2e\n\ntest:\n\tpnpm test\n\ne2e: build\n\tplaywright test\n\nclean:\n\trm -rf dist\n",
  justfile: "default:\n  just --list\n\ncheck:\n  pnpm check\n",
  "tailwind.config.js": "export default { theme: { colors: { brand: '#ff6600' } } };\n",
  "src/index.ts": "export const x = 1;\n",
  "src/deep/a/b/c/file.ts": "export {};\n",
};

const EXPECTED_INDEXED = [
  "Makefile",
  "README.md",
  "docs/adrs/0001-use-sqlite.md",
  "docs/guide.md",
  "justfile",
  "package.json",
  "packages/foo/package.json",
  "sindri:structure",
  "sindri:test-commands",
  "tailwind.config.js",
];

describe.each([
  { mode: "git repo", git: true },
  { mode: "plain directory", git: false },
])("bootstrapProject ($mode)", ({ git }) => {
  let repo: TempRepo;
  let k: Knowledge;
  let projectId: string;

  beforeEach(() => {
    repo = createTempRepo(FIXTURE, { git });
    k = openKnowledge(":memory:");
    projectId = k.projects.create({ name: "demo", repoPath: repo.path }).id;
  });
  afterEach(() => {
    k.close();
    repo.cleanup();
  });

  const indexedPaths = () =>
    (
      k.db
        .prepare("SELECT path FROM documents WHERE project_id = ? ORDER BY path")
        .all(projectId) as {
        path: string;
      }[]
    ).map((r) => r.path);

  it("indexes the right files and skips secrets, ignored, large and binary files", () => {
    const res = k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(indexedPaths()).toEqual(EXPECTED_INDEXED);
    expect(res.indexed.sort()).toEqual(EXPECTED_INDEXED);
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { path: ".env", reason: "secret" },
        { path: "certs/server.pem", reason: "secret" },
        { path: "config/aws-credentials.json", reason: "secret" },
        { path: "docs/huge.md", reason: "too-large" },
        { path: "docs/blob.md", reason: "binary" },
      ]),
    );
    const all = (k.db.prepare("SELECT text FROM chunks").all() as { text: string }[])
      .map((r) => r.text)
      .join("\n");
    for (const secret of [
      "sk" + "_live_fakeSecretValue123",
      "hunter2credentialvalue",
      "pemsecretmaterial",
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toContain("quasarbundle");
    expect(all).not.toContain("zebracorn");
  });

  it("classifies documents by kind", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const kinds = Object.fromEntries(
      (
        k.db.prepare("SELECT path, kind FROM documents").all() as { path: string; kind: string }[]
      ).map((r) => [r.path, r.kind]),
    );
    expect(kinds).toMatchObject({
      "README.md": "readme",
      "docs/guide.md": "doc",
      "docs/adrs/0001-use-sqlite.md": "adr",
      "package.json": "manifest",
      "tailwind.config.js": "design-system",
      Makefile: "build-script",
      "sindri:test-commands": "test-commands",
      "sindri:structure": "structure",
    });
  });

  it("derives test commands from package.json scripts, Makefile targets and justfile", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const hits = k.search(projectId, "vitest", { limit: 20 });
    const doc = hits.find((h) => h.path === "sindri:test-commands");
    expect(doc).toBeDefined();
    expect(doc?.text).toContain("npm run test");
    expect(doc?.text).toContain("npm run lint");
    expect(doc?.text).toContain("packages/foo");
    expect(doc?.text).toContain("make test");
    expect(doc?.text).toContain("make e2e");
    expect(doc?.text).toContain("just check");
    expect(doc?.text).not.toContain("make clean");
    expect(doc?.text).not.toContain("npm run build");
  });

  it("summarises directory structure to depth 3 without ignored dirs", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const text = (
      k.db
        .prepare(
          "SELECT group_concat(c.text, '\n') AS t FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'sindri:structure'",
        )
        .get() as { t: string }
    ).t;
    expect(text).toContain("src/deep/a/");
    expect(text).not.toContain("src/deep/a/b/");
    expect(text).not.toMatch(/^dist\//m);
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("docs/private");
  });

  it("searches with FTS5 and returns path plus line range of the match", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const hits = k.search(projectId, "flux capacitor gigawatts", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top?.path).toBe("docs/guide.md");
    expect(top?.text).toContain("flux capacitor");
    expect(top?.startLine).toBeLessThanOrEqual(FLUX_LINE);
    expect(top?.endLine).toBeGreaterThanOrEqual(FLUX_LINE);
    expect(top?.startLine).toBeGreaterThan(1);
    const lines = guideLines.slice((top?.startLine ?? 1) - 1, top?.endLine).join("\n");
    expect(top?.text).toBe(lines);
  });

  it("treats query text literally (no FTS syntax injection) and respects limit", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(() => k.search(projectId, 'flux" OR NEAR(* "', { limit: 5 })).not.toThrow();
    expect(k.search(projectId, "", { limit: 5 })).toEqual([]);
    expect(k.search(projectId, "filler", { limit: 1 })).toHaveLength(1);
    expect(k.search(projectId, "sk" + "_live_fakeSecretValue123")).toEqual([]);
  });

  it("re-bootstrap is incremental: unchanged, updated and removed documents", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const again = k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(again.indexed).toEqual([]);
    expect(again.unchanged.sort()).toEqual(EXPECTED_INDEXED);

    writeFileSync(join(repo.path, "README.md"), "# Demo\n\nNow mentions hyperdrive.\n");
    rmSync(join(repo.path, "docs/adrs/0001-use-sqlite.md"));
    const third = k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(third.indexed).toContain("README.md");
    expect(third.removed).toContain("docs/adrs/0001-use-sqlite.md");
    expect(k.search(projectId, "hyperdrive")[0]?.path).toBe("README.md");
    expect(k.search(projectId, "SQLite").map((h) => h.path)).not.toContain(
      "docs/adrs/0001-use-sqlite.md",
    );
  });

  it("lets knowledge entries cite indexed document lines", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const hit = k.search(projectId, "flux capacitor")[0];
    if (!hit) throw new Error("expected a hit");
    const e = k.knowledge.add({
      projectId,
      claim: "The flux capacitor needs 1.21 GW",
      sourceRefs: [{ documentId: hit.documentId, startLine: FLUX_LINE, endLine: FLUX_LINE }],
      confidence: 0.95,
      createdBy: "director",
    });
    expect(e.sourceRefs).toHaveLength(1);
  });
});
