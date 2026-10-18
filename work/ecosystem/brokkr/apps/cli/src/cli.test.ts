import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { treeDigest } from "@brokkr/core";
import { EXIT_CODES } from "@brokkr/core";
import { exitWith } from "./exit.js";
import { cli, emptyRepo, reactRepo, REPO_ROOT, tmp } from "../test/helpers.js";

describe("exitWith", () => {
  it.each(Object.entries(EXIT_CODES))(
    "passes contract code %s (%i) to the process",
    (_name, code) => {
      const exit = vi.fn();
      exitWith(code, exit as never);
      expect(exit).toHaveBeenCalledWith(code);
    },
  );

  it("refuses codes outside the public contract and exits 3 instead", () => {
    const exit = vi.fn();
    exitWith(42, exit as never);
    expect(exit).toHaveBeenCalledWith(3);
  });
});

describe("exit code contract per command outcome", () => {
  it("0: successful operation", async () => {
    expect((await cli(["harness", "list", "--json"])).code).toBe(0);
  });

  it("1: verification failed (lock integrity check fails)", async () => {
    const repo = reactRepo();
    expect((await cli(["init", "--yes", "--cwd", repo])).code).toBe(0);
    const lock = JSON.parse(readFileSync(join(repo, ".brokkr/harness.lock.json"), "utf8"));
    lock.harnesses[0].digest = `sha256:${"f".repeat(64)}`;
    writeFileSync(join(repo, ".brokkr/harness.lock.json"), JSON.stringify(lock));
    const result = await cli(["harness", "lock", "--verify", "--json", "--cwd", repo]);
    expect(result.code).toBe(1);
  });

  it("2: invalid configuration (invalid manifest)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "harness.yaml"), "apiVersion: brokkr.dev/v1alpha1\nkind: Harness\n");
    expect((await cli(["harness", "validate", dir])).code).toBe(2);
  });

  it("3: infrastructure error (run storage cannot be created)", async () => {
    const repo = emptyRepo();
    mkdirSync(join(repo, ".brokkr"));
    writeFileSync(join(repo, ".brokkr", "config.yaml"), "version: 1\nharnesses: []\n");
    // Run storage lives in the Brokkr home; make it unwritable.
    const home = tmp("brokkr-home-");
    mkdirSync(join(home, ".brokkr"), { mode: 0o555 });
    const verify = await cli(["verify", "--cwd", repo], { home });
    expect(verify.code).toBe(3);
    expect(verify.stderr).toMatch(/EACCES|permission denied/i);
  });

  it("verify and report need configuration or runs (exit 2)", async () => {
    expect((await cli(["verify", "--cwd", emptyRepo()])).code).toBe(2);
    expect((await cli(["report", "--json", "--cwd", emptyRepo()])).code).toBe(2);
    expect((await cli(["verify", "--executor", "mimir", "--cwd", emptyRepo()])).code).toBe(2);
    expect((await cli(["report", "--run", "../../etc", "--cwd", emptyRepo()])).code).toBe(2);
    expect((await cli(["report", "--format", "pdf", "--cwd", emptyRepo()])).code).toBe(2);
  });

  it("4: policy denied (adding a harness from an untrusted source)", async () => {
    const repo = emptyRepo();
    const vendor = join(repo, "vendor");
    mkdirSync(vendor);
    const { writeFileSync: w } = await import("node:fs");
    const src = join(REPO_ROOT, "harnesses/backend-node");
    const { cpSync } = await import("node:fs");
    cpSync(src, join(vendor, "backend-node"), { recursive: true });
    const manifest = readFileSync(join(vendor, "backend-node/harness.yaml"), "utf8").replace(
      "name: backend-node",
      "name: vendor-node",
    );
    w(join(vendor, "backend-node/harness.yaml"), manifest);
    const digest = await treeDigest(vendor);
    mkdirSync(join(repo, ".brokkr"));
    w(
      join(repo, ".brokkr/config.yaml"),
      `version: 1\nharnesses: []\nsources:\n  - path: vendor\n    digest: "${digest}"\n    trusted: false\n`,
    );
    const result = await cli(["harness", "add", "vendor-node", "--cwd", repo]);
    expect(result.code).toBe(4);
    expect(result.stderr).toMatch(/untrusted/);
    expect(result.stderr).toMatch(/brokkr trust add/);
  });

  it("130: interrupted (aborted while waiting for approval)", async () => {
    const controller = new AbortController();
    const pending = cli(["init", "--cwd", reactRepo()], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).code).toBe(130);
  });

  it("unknown commands and bad options are invalid invocations (2)", async () => {
    expect((await cli(["nope"])).code).toBe(2);
    expect((await cli(["prepare", "--task", "x.json"])).code).toBe(2);
  });
});

describe("brokkr init", () => {
  it("recommends frontend-react for a React repo and writes config + lock with --yes", async () => {
    const repo = reactRepo();
    const result = await cli(["init", "--yes", "--json", "--cwd", repo]);
    expect(result.code).toBe(0);
    const out = result.json<{
      signals: { frameworks: string[] };
      recommended: Array<{ name: string; reason: string; requiredChecks: string[] }>;
      configPath: string;
      lockPath: string;
      next: string;
    }>();
    expect(out.signals.frameworks).toEqual(["react", "vite"]);
    expect(out.recommended.map((r) => r.name)).toEqual(["frontend-react"]);
    expect(out.recommended[0]?.requiredChecks).toEqual([
      "typecheck",
      "unit",
      "screenshot-desktop",
      "screenshot-mobile",
      "axe",
    ]);
    expect(parse(readFileSync(join(repo, ".brokkr/config.yaml"), "utf8"))).toEqual({
      version: 1,
      harnesses: [{ name: "frontend-react", version: "^1.0.0" }],
    });
    const lock = JSON.parse(readFileSync(join(repo, ".brokkr/harness.lock.json"), "utf8"));
    expect(lock.harnesses.map((h: { name: string }) => h.name)).toEqual(["frontend-react"]);
    expect(lock.adapters.map((a: { id: string }) => a.id)).toEqual([
      "claude-code",
      "codex",
      "generic",
    ]);
    expect(out.next).toBe("brokkr prepare --provider claude-code --task task.json");
  });

  it("explains each harness and asks for approval when interactive", async () => {
    const repo = reactRepo();
    const result = await cli(["init", "--cwd", repo], { stdinText: "y\n" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("frontend-react@1.0.0");
    expect(result.stdout).toMatch(
      /Required checks: typecheck, unit, screenshot-desktop, screenshot-mobile, axe/,
    );
    expect(result.stdout).toMatch(/Write \.brokkr\/config\.yaml/);
    expect(result.stdout).toContain("Next: brokkr prepare --provider claude-code --task task.json");
    expect(existsSync(join(repo, ".brokkr/config.yaml"))).toBe(true);
  });

  it("writes nothing and reports policy denied when approval is declined", async () => {
    const repo = reactRepo();
    const result = await cli(["init", "--cwd", repo], { stdinText: "n\n" });
    expect(result.code).toBe(4);
    expect(existsSync(join(repo, ".brokkr"))).toBe(false);
  });

  it("refuses to re-initialise an initialised repo", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    expect((await cli(["init", "--yes", "--cwd", repo])).code).toBe(2);
  });

  it("succeeds without writing anything when nothing matches", async () => {
    const repo = emptyRepo();
    const result = await cli(["init", "--yes", "--json", "--cwd", repo]);
    expect(result.code).toBe(0);
    expect(result.json<{ recommended: unknown[] }>().recommended).toEqual([]);
    expect(existsSync(join(repo, ".brokkr"))).toBe(false);
  });
});

describe("brokkr harness", () => {
  it("lists built-in harnesses with source and trust", async () => {
    const result = await cli(["harness", "list", "--json"]);
    const list = result.json<{
      harnesses: Array<{ name: string; source: string; trust: string }>;
    }>().harnesses;
    expect(list).toContainEqual(
      expect.objectContaining({ name: "frontend-react", source: "builtin", trust: "trusted" }),
    );
    expect((await cli(["harness", "list"])).stdout).toMatch(
      /frontend-react\s+1\.0\.0\s+builtin\s+trusted/,
    );
  });

  it("inspects a harness and fails cleanly for unknown names", async () => {
    const result = await cli(["harness", "inspect", "frontend-react", "--json"]);
    expect(result.code).toBe(0);
    const out = result.json<{
      manifest: { metadata: { name: string } };
      skills: Array<{ name: string }>;
      digest: string;
    }>();
    expect(out.manifest.metadata.name).toBe("frontend-react");
    expect(out.skills.map((s) => s.name)).toContain("accessibility");
    expect(out.digest).toMatch(/^sha256:/);
    const text = await cli(["harness", "inspect", "frontend-react"]);
    expect(text.stdout).toMatch(/typecheck \(required\): pnpm exec tsc --noEmit/);
    const missing = await cli(["harness", "inspect", "nope", "--json"]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout).error.code).toBe("not-found");
  });

  it("validates a directory and reports issues with paths", async () => {
    expect(
      (await cli(["harness", "validate", join(REPO_ROOT, "harnesses/frontend-react")])).code,
    ).toBe(0);
    const dir = tmp();
    writeFileSync(
      join(dir, "harness.yaml"),
      readFileSync(join(REPO_ROOT, "harnesses/frontend-react/harness.yaml"), "utf8").replace(
        "    command:\n      - pnpm\n      - exec\n      - tsc\n      - --noEmit",
        "    command: pnpm exec tsc --noEmit",
      ),
    );
    const result = await cli(["harness", "validate", dir, "--json"]);
    expect(result.code).toBe(2);
    const issues = result.json<{ issues: Array<{ path: string }> }>().issues.map((i) => i.path);
    expect(issues).toContain("checks.0.command");
    expect(issues).toContain("skills.required.0");
  });

  it("adds a harness with a range, updates config and lock", async () => {
    const repo = emptyRepo();
    const result = await cli(["harness", "add", "backend-node@^1.0.0", "--json", "--cwd", repo]);
    expect(result.code).toBe(0);
    expect(parse(readFileSync(join(repo, ".brokkr/config.yaml"), "utf8")).harnesses).toEqual([
      { name: "backend-node", version: "^1.0.0" },
    ]);
    expect(existsSync(join(repo, ".brokkr/harness.lock.json"))).toBe(true);
    expect((await cli(["harness", "add", "ghost", "--cwd", repo])).code).toBe(2);
    expect((await cli(["harness", "add", "backend-node@^7", "--cwd", repo])).code).toBe(2);
  });

  it("lock writes the lockfile and --verify passes on an untouched tree", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    expect((await cli(["harness", "lock", "--cwd", repo])).code).toBe(0);
    const verify = await cli(["harness", "lock", "--verify", "--json", "--cwd", repo]);
    expect(verify.code).toBe(0);
    expect(verify.json<{ ok: boolean }>().ok).toBe(true);
    expect((await cli(["harness", "lock", "--cwd", emptyRepo()])).code).toBe(2);
  });
});

describe("brokkr skills", () => {
  it("lists skills", async () => {
    const result = await cli(["skills", "list", "--json"]);
    const skills = result.json<{ skills: Array<{ name: string; providedBy: string[] }> }>().skills;
    expect(skills.find((s) => s.name === "typescript")?.providedBy).toEqual([
      "backend-node@1.0.0",
      "frontend-react@1.0.0",
    ]);
  });

  it("resolves skills for a task with reasons and rationale", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    const result = await cli(["skills", "resolve", "--task", "task.json", "--json", "--cwd", repo]);
    expect(result.code).toBe(0);
    const out = result.json<{
      skills: Array<{ name: string; reason: string }>;
      rationale: Array<{ name: string }>;
    }>();
    expect(out.skills.map((s) => s.name)).toEqual([
      "accessibility",
      "react-architecture",
      "responsive-design",
      "typescript",
      "component-design",
    ]);
    expect(out.rationale.map((r) => r.name)).toEqual([
      "component-reuse",
      "performance",
      "playwright",
      "tailwind",
      "visual-qa",
    ]);
    const text = await cli(["skills", "resolve", "--task", "task.json", "--cwd", repo]);
    expect(text.stdout).toMatch(/component-design.*keyword 'component'/);
    expect(text.stdout).toMatch(/not selected: tailwind/);
  });

  it("applies --budget", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    const result = await cli([
      "skills",
      "resolve",
      "--task",
      "task.json",
      "--budget",
      "2000",
      "--json",
      "--cwd",
      repo,
    ]);
    expect(result.json<{ budget: { limit: number } }>().budget.limit).toBe(2000);
  });

  it("rejects an invalid task file with exit 2", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    writeFileSync(
      join(repo, "bad.json"),
      JSON.stringify({ id: "../../etc", title: "x", description: "" }),
    );
    const result = await cli(["skills", "resolve", "--task", "bad.json", "--cwd", repo]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/id/);
    expect((await cli(["skills", "resolve", "--task", "missing.json", "--cwd", repo])).code).toBe(
      2,
    );
  });
});

describe("brokkr prepare", () => {
  it.each([
    ["claude-code", "claude/CLAUDE.md"],
    ["codex", "codex/AGENTS.md"],
    ["generic", "generic/INSTRUCTIONS.md"],
  ])("prepares a %s bundle", async (provider, entry) => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    const result = await cli([
      "prepare",
      "--provider",
      provider,
      "--task",
      "task.json",
      "--json",
      "--cwd",
      repo,
    ]);
    expect(result.code).toBe(0);
    const out = result.json<{
      entrypoint: string;
      files: Array<{ relativePath: string; digest: string }>;
    }>();
    expect(out.entrypoint).toBe(join(repo, ".brokkr/generated/task-context/UI-142", entry));
    expect(existsSync(out.entrypoint)).toBe(true);
    expect(out.files.every((f) => f.digest.startsWith("sha256:"))).toBe(true);
  });

  it("rejects an unknown provider", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    expect(
      (await cli(["prepare", "--provider", "cursor", "--task", "task.json", "--cwd", repo])).code,
    ).toBe(2);
  });
});

describe("brokkr doctor", () => {
  it("reports environment checks and fails on lock integrity problems", async () => {
    const repo = reactRepo();
    await cli(["init", "--yes", "--cwd", repo]);
    const ok = await cli(["doctor", "--json", "--cwd", repo]);
    const checks = ok.json<{ checks: Array<{ id: string; status: string }> }>().checks;
    expect(checks.map((c) => c.id)).toEqual([
      "node",
      "package-manager",
      "git",
      "playwright",
      "harness-lock",
    ]);
    expect(checks.find((c) => c.id === "node")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "harness-lock")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "playwright")?.status).toMatch(/ok|warn/);

    const body = join(repo, ".brokkr/harnesses");
    mkdirSync(body, { recursive: true });
    const lockPath = join(repo, ".brokkr/harness.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.skills[0].digest = `sha256:${"e".repeat(64)}`;
    writeFileSync(lockPath, JSON.stringify(lock));
    const bad = await cli(["doctor", "--json", "--cwd", repo]);
    expect(bad.code).toBe(1);
    expect(
      bad
        .json<{ checks: Array<{ id: string; status: string }> }>()
        .checks.find((c) => c.id === "harness-lock")?.status,
    ).toBe("fail");
  });
});

describe("brokkr trust", () => {
  it("lists sources and adds a trusted pinned source after checking its digest", async () => {
    const repo = emptyRepo();
    const vendor = join(repo, "vendor");
    const { cpSync } = await import("node:fs");
    cpSync(join(REPO_ROOT, "harnesses/backend-node"), join(vendor, "backend-node"), {
      recursive: true,
    });
    const digest = await treeDigest(vendor);

    const wrong = await cli([
      "trust",
      "add",
      "vendor",
      "--digest",
      `sha256:${"0".repeat(64)}`,
      "--cwd",
      repo,
    ]);
    expect(wrong.code).toBe(4);
    expect(wrong.stderr).toMatch(/digest mismatch/);
    expect((await cli(["trust", "add", "vendor", "--cwd", repo])).code).toBe(2);

    const added = await cli([
      "trust",
      "add",
      "vendor",
      "--digest",
      digest,
      "--json",
      "--cwd",
      repo,
    ]);
    expect(added.code).toBe(0);
    expect(parse(readFileSync(join(repo, ".brokkr/config.yaml"), "utf8")).sources).toEqual([
      { path: "vendor", digest, trusted: true },
    ]);
    const list = await cli(["trust", "list", "--json", "--cwd", repo]);
    const sources = list.json<{ sources: Array<{ kind: string; ref: string; trusted: boolean }> }>()
      .sources;
    expect(sources.map((s) => [s.kind, s.trusted])).toEqual([
      ["builtin", true],
      ["user", true],
      ["project", true],
      ["external", true],
    ]);
  });
});

describe("I3: prepare never emits skill text from an untrusted source", () => {
  it("exits 4 with trust_required and writes no bundle", async () => {
    const repo = emptyRepo();
    const vendor = join(repo, "vendor");
    const { cpSync } = await import("node:fs");
    cpSync(join(REPO_ROOT, "harnesses/backend-node"), join(vendor, "backend-node"), {
      recursive: true,
    });
    writeFileSync(
      join(vendor, "backend-node/harness.yaml"),
      readFileSync(join(vendor, "backend-node/harness.yaml"), "utf8").replace(
        "name: backend-node",
        "name: vendor-node",
      ),
    );
    const digest = await treeDigest(vendor);
    mkdirSync(join(repo, ".brokkr"));
    writeFileSync(
      join(repo, ".brokkr/config.yaml"),
      `version: 1\nharnesses:\n  - name: vendor-node\n    version: "*"\nsources:\n  - path: vendor\n    digest: "${digest}"\n    trusted: false\n`,
    );
    writeFileSync(
      join(repo, "task.json"),
      JSON.stringify({ id: "T-1", title: "Add endpoint", description: "api" }),
    );
    const result = await cli([
      "prepare",
      "--provider",
      "claude-code",
      "--task",
      "task.json",
      "--json",
      "--cwd",
      repo,
    ]);
    expect(result.code).toBe(4);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("trust_required");
    expect(existsSync(join(repo, ".brokkr/generated"))).toBe(false);
  });
});

describe("review M4/M7", () => {
  it("M4: init refuses a pre-existing .brokkr symlink (exit 4) and writes nothing through it", async () => {
    const repo = reactRepo();
    const target = tmp("brokkr-target-");
    const { symlinkSync, readdirSync } = await import("node:fs");
    symlinkSync(target, join(repo, ".brokkr"));
    const result = await cli(["init", "--yes", "--cwd", repo]);
    expect(result.code).toBe(4);
    expect(readdirSync(target)).toEqual([]);
  });

  it("M7: usage errors with --json produce a JSON error document", async () => {
    const result = await cli(["nope", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("usage");
  });
});
