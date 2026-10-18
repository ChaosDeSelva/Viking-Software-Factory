import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GhPrRunner, LocalDeliveryRunner, PR_ENV_ALLOWLIST, type ExecFn } from "./pr.js";

const dirs: string[] = [];
it("defaults to local delivery without probing or calling a remote service", async () => {
  const runner = new LocalDeliveryRunner();
  expect(await runner.available()).toBe(false);
  await expect(runner.create()).rejects.toThrow(/Remote delivery is disabled/);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-pr-")));
  dirs.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

function recorder(stdout = "") {
  const calls: { file: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] =
    [];
  const exec: ExecFn = (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd, env: opts.env });
    return Promise.resolve({ stdout, stderr: "" });
  };
  return { calls, exec };
}

describe("GhPrRunner hardening", () => {
  it("runs gh and git from the trusted repoPath with a pinned GIT_DIR and a minimal env", async () => {
    process.env["AWS_SECRET_ACCESS_KEY"] = "nope";
    process.env["GIT_SSH_COMMAND"] = "evil";
    try {
      const r = repo();
      const { calls, exec } = recorder("origin\n");
      const runner = new GhPrRunner({ exec });
      expect(await runner.available(r)).toBe(true);
      await runner.create({
        repoPath: r,
        worktreePath: join(r, "..", "wt"),
        branch: "mimir/solo/x",
        title: "T",
        body: "B",
      });
      expect(calls.map((c) => c.file)).toEqual(["gh", "git", "gh"]);
      for (const c of calls) {
        expect(c.cwd).toBe(r);
        expect(c.env["GIT_DIR"]).toBe(join(r, ".git"));
        expect(c.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
        expect(c.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
        const count = Number(c.env["GIT_CONFIG_COUNT"]);
        const keys = Array.from({ length: count }, (_, i) => c.env[`GIT_CONFIG_KEY_${i}`]);
        expect(keys).toEqual(expect.arrayContaining(["core.hooksPath", "core.fsmonitor"]));
        const extra = Object.keys(c.env).filter(
          (k) => !PR_ENV_ALLOWLIST.includes(k) && !k.startsWith("GIT_CONFIG_") && k !== "GIT_DIR",
        );
        expect(extra).toEqual([]);
        expect(c.env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
        expect(c.env["GIT_SSH_COMMAND"]).toBeUndefined();
      }
      expect(calls[2]?.args).toEqual([
        "pr",
        "create",
        "--head",
        "mimir/solo/x",
        "--title",
        "T",
        "--body",
        "B",
      ]);
    } finally {
      delete process.env["AWS_SECRET_ACCESS_KEY"];
      delete process.env["GIT_SSH_COMMAND"];
    }
  });

  it("is unavailable without a remote or without a .git directory", async () => {
    const { exec } = recorder("");
    expect(await new GhPrRunner({ exec }).available(repo())).toBe(false);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "mimir-pr-")));
    dirs.push(bare);
    expect(await new GhPrRunner({ exec: recorder("origin\n").exec }).available(bare)).toBe(false);
  });
});
