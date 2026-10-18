import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessManifestSchema, parseManifestText } from "@brokkr/core";
import {
  ENV_ALLOWLIST,
  buildCheckEnv,
  expandCommand,
  isSecretEnvName,
  preflightCheck,
  secretEnvValues,
} from "./index.js";
import { tmp } from "../test/helpers.js";

function exe(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

function workspace(scripts: Record<string, string> | null = { test: "x" }): string {
  const ws = tmp();
  if (scripts) writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts }));
  return ws;
}

/** PATH with node and a fake pnpm/npm, but nothing else (no global tsc). */
function pathWith(ws: string): string {
  const bin = join(ws, "..", `bin-${Math.random().toString(36).slice(2)}`);
  for (const tool of ["pnpm", "npm"]) exe(join(bin, tool));
  symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}

describe("buildCheckEnv", () => {
  it("passes only the explicit allowlist plus requested keys", () => {
    const { env, refused } = buildCheckEnv(
      {
        PATH: "/bin",
        HOME: "/home/u",
        LANG: "C",
        TERM: "xterm",
        CI: "1",
        NODE_OPTIONS: "--require evil.js",
        AWS_SECRET_ACCESS_KEY: "x",
        DISPLAY: ":0",
        RANDOM_VAR: "y",
      },
      ["DISPLAY", "GITHUB_TOKEN", "UNSET_VAR"],
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      LANG: "C",
      TERM: "xterm",
      CI: "1",
      DISPLAY: ":0",
    });
    expect(refused).toEqual(["GITHUB_TOKEN"]);
    expect(ENV_ALLOWLIST).not.toContain("NODE_OPTIONS");
  });

  it("recognises secret-looking variable names", () => {
    for (const n of [
      "GITHUB_TOKEN",
      "NPM_AUTH",
      "DB_PASSWORD",
      "API_KEY",
      "MY_SECRET",
      "AWS_ACCESS_KEY_ID",
      "PRIVATE_KEY_PATH",
    ])
      expect(isSecretEnvName(n), n).toBe(true);
    for (const n of ["PATH", "HOME", "DISPLAY", "CI", "KEYBOARD_LAYOUT"])
      expect(isSecretEnvName(n), n).toBe(false);
  });

  it("collects secret values from the caller environment for redaction", () => {
    expect(
      secretEnvValues({
        GITHUB_TOKEN: "ghp_longvalue123",
        SHORT_TOKEN: "abc",
        PATH: "/usr/bin/long",
      }),
    ).toEqual(["ghp_longvalue123"]);
  });
});

describe("expandCommand ({{harnessDir}} placeholder)", () => {
  it("substitutes the harness directory", () => {
    const dir = tmp();
    exe(join(dir, "scripts", "scan.mjs"));
    const result = expandCommand(
      ["node", "{{harnessDir}}/scripts/scan.mjs", "--kind", "secrets"],
      dir,
    );
    expect(result).toEqual({
      ok: true,
      command: ["node", join(dir, "scripts/scan.mjs"), "--kind", "secrets"],
    });
  });

  it("rejects substituted paths that leave the harness directory", () => {
    const dir = tmp();
    const result = expandCommand(["node", "{{harnessDir}}/../../etc/passwd"], dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/outside the harness directory/);
  });

  it("rejects symlinks inside the harness that point outside it", () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "evil.mjs"), "");
    symlinkSync(join(outside, "evil.mjs"), join(dir, "evil.mjs"));
    const result = expandCommand(["node", "{{harnessDir}}/evil.mjs"], dir);
    expect(result.ok).toBe(false);
  });

  it("rejects unknown placeholders and a missing harness directory", () => {
    expect(expandCommand(["echo", "{{secret}}"], tmp()).ok).toBe(false);
    expect(expandCommand(["node", "{{harnessDir}}/x.mjs"], undefined).ok).toBe(false);
    expect(expandCommand(["pnpm", "test"], undefined)).toEqual({
      ok: true,
      command: ["pnpm", "test"],
    });
  });
});

describe("preflightCheck", () => {
  const check = (command: string[], when?: object, cwd?: string) => ({
    id: "c",
    command,
    ...(when ? { when } : {}),
    ...(cwd ? { cwd } : {}),
  });

  it("multi-key when is AND: every condition must hold", async () => {
    const ws = workspace({ "db:migrate:dry-run": "x" });
    const path = pathWith(ws);
    const when = { fileExists: ["migrations"], scriptExists: ["db:migrate:dry-run"] };
    const cmd = ["pnpm", "run", "db:migrate:dry-run"];

    const noDir = await preflightCheck(check(cmd, when), { workspace: ws, path });
    expect(noDir).toMatchObject({ ok: false, reason: "not_applicable" });

    mkdirSync(join(ws, "migrations"));
    expect(await preflightCheck(check(cmd, when), { workspace: ws, path })).toMatchObject({
      ok: true,
    });

    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: {} }));
    const noScript = await preflightCheck(check(cmd, when), { workspace: ws, path });
    expect(noScript).toMatchObject({ ok: false, reason: "not_applicable" });
  });

  it("anyFileExists recognises playwright.config.ts, .js and .mjs", async () => {
    const when = {
      anyFileExists: ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"],
    };
    for (const name of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
      const ws = workspace();
      exe(join(ws, "node_modules", ".bin", "playwright"));
      writeFileSync(join(ws, name), "");
      const result = await preflightCheck(check(["pnpm", "exec", "playwright", "test"], when), {
        workspace: ws,
        path: pathWith(ws),
      });
      expect(result, name).toMatchObject({ ok: true });
    }
    const none = workspace();
    const result = await preflightCheck(check(["pnpm", "exec", "playwright", "test"], when), {
      workspace: none,
      path: pathWith(none),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_applicable" });
  });

  it("the built-in frontend-react harness detects every Playwright config variant", async () => {
    const file = resolve(import.meta.dirname, "../../../harnesses/frontend-react/harness.yaml");
    const parsed = parseManifestText(readFileSync(file, "utf8"), HarnessManifestSchema, file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const browserChecks = parsed.value.checks.filter((c) => c.command.includes("playwright"));
    expect(browserChecks.length).toBeGreaterThan(0);
    for (const c of browserChecks) {
      for (const name of [
        "playwright.config.ts",
        "playwright.config.js",
        "playwright.config.mjs",
      ]) {
        const ws = workspace();
        exe(join(ws, "node_modules", ".bin", "playwright"));
        writeFileSync(join(ws, name), "");
        const result = await preflightCheck(c, { workspace: ws, path: pathWith(ws) });
        expect(result, `${c.id} ${name}`).toMatchObject({ ok: true });
      }
    }
  });

  it("the built-in backend-node migration check needs both the directory and the script", async () => {
    const file = resolve(import.meta.dirname, "../../../harnesses/backend-node/harness.yaml");
    const parsed = parseManifestText(readFileSync(file, "utf8"), HarnessManifestSchema, file);
    if (!parsed.ok) throw new Error("backend-node manifest invalid");
    const migration = parsed.value.checks.find((c) => c.id === "migration-dry-run");
    expect(migration?.when?.fileExists).toBeDefined();
    expect(migration?.when?.scriptExists).toBeDefined();
    const ws = workspace({ "db:migrate:dry-run": "x" });
    expect(await preflightCheck(migration!, { workspace: ws, path: pathWith(ws) })).toMatchObject({
      ok: false,
      reason: "not_applicable",
    });
  });

  it("missing executable on PATH is missing_tool, with a diagnostic", async () => {
    const ws = workspace();
    const result = await preflightCheck(check(["golangci-lint", "run"]), {
      workspace: ws,
      path: pathWith(ws),
    });
    expect(result).toMatchObject({ ok: false, reason: "missing_tool" });
    if (!result.ok) expect(result.message).toMatch(/golangci-lint.*not found on PATH/);
  });

  it("package scripts must exist: missing_script", async () => {
    const ws = workspace({ build: "x" });
    const path = pathWith(ws);
    for (const cmd of [
      ["pnpm", "run", "lint"],
      ["pnpm", "test"],
      ["npm", "run-script", "lint"],
      ["npm", "test"],
    ]) {
      const r = await preflightCheck(check(cmd), { workspace: ws, path });
      expect(r, cmd.join(" ")).toMatchObject({ ok: false, reason: "missing_script" });
    }
    expect(
      await preflightCheck(check(["pnpm", "run", "build"]), { workspace: ws, path }),
    ).toMatchObject({ ok: true });
    const noPkg = workspace(null);
    const r = await preflightCheck(check(["pnpm", "test"]), {
      workspace: noPkg,
      path: pathWith(noPkg),
    });
    expect(r).toMatchObject({ ok: false, reason: "missing_script" });
    if (!r.ok) expect(r.message).toMatch(/no package.json/);
  });

  it("pnpm exec <bin> without installed dependencies is missing_tool with an install hint", async () => {
    const ws = workspace();
    const result = await preflightCheck(check(["pnpm", "exec", "tsc", "--noEmit"]), {
      workspace: ws,
      path: pathWith(ws),
    });
    expect(result).toMatchObject({ ok: false, reason: "missing_tool" });
    if (!result.ok)
      expect(result.message).toMatch(/'tsc' is not installed.*node_modules\/.bin.*install/);
  });

  it("pnpm exec <bin> finds binaries in node_modules/.bin up to the workspace root", async () => {
    const ws = workspace();
    exe(join(ws, "node_modules", ".bin", "tsc"));
    mkdirSync(join(ws, "packages", "a"), { recursive: true });
    writeFileSync(join(ws, "packages", "a", "package.json"), "{}");
    const r = await preflightCheck(check(["pnpm", "exec", "tsc"], undefined, "packages/a"), {
      workspace: ws,
      path: pathWith(ws),
    });
    expect(r).toMatchObject({ ok: true, cwdDir: join(ws, "packages", "a") });
  });

  it("relative executables must exist inside the workspace", async () => {
    const ws = workspace();
    exe(join(ws, "scripts", "check.sh"));
    const path = pathWith(ws);
    expect(
      await preflightCheck(check(["./scripts/check.sh"]), { workspace: ws, path }),
    ).toMatchObject({ ok: true });
    expect(
      await preflightCheck(check(["./scripts/missing.sh"]), { workspace: ws, path }),
    ).toMatchObject({
      ok: false,
      reason: "missing_tool",
    });
  });

  it("rejects a cwd outside the workspace", async () => {
    const ws = workspace();
    const r = await preflightCheck(check(["pnpm", "test"], undefined, "../.."), {
      workspace: ws,
      path: pathWith(ws),
    });
    expect(r).toMatchObject({ ok: false, reason: "cwd_rejected" });
  });

  it("reports invalid placeholders as invalid_command", async () => {
    const ws = workspace();
    const r = await preflightCheck(check(["node", "{{harnessDir}}/../x"]), {
      workspace: ws,
      path: pathWith(ws),
      harnessDir: tmp(),
    });
    expect(r).toMatchObject({ ok: false, reason: "invalid_command" });
  });
});

describe("env injection and secret names (audit M1)", () => {
  it("refuses loader/injection variables and broader secret names even when a harness asks", () => {
    const names = [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "BASH_ENV",
      "ENV",
      "GIT_SSH_COMMAND",
      "GIT_DIR",
      "GH_PAT",
      "OPENAI_KEY",
      "HF_HUB_KEY",
      "SENTRY_DSN",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "RUBYOPT",
    ];
    const base = Object.fromEntries(names.map((n) => [n, "value-123456789"]));
    const { env, refused } = buildCheckEnv({ PATH: "/bin", ...base }, names);
    expect(env).toEqual({ PATH: "/bin" });
    expect(refused.sort()).toEqual([...names].sort());
  });

  it("DATABASE_URL with credentials is treated as a secret value", () => {
    expect(
      secretEnvValues({ DATABASE_URL: "postgres://u:p4ssw0rd@db/x", PLAIN_URL: "https://x" }),
    ).toEqual(["postgres://u:p4ssw0rd@db/x"]);
  });
});

describe("resolved binary identity (fix round 2, C1)", () => {
  it("identifies a binary by realpath and inode, so aliases hit the same rules", async () => {
    const { identifyExecutable } = await import("./index.js");
    const { linkSync } = await import("node:fs");
    const bin = join(tmp(), "bin");
    exe(join(bin, "rm"));
    linkSync(join(bin, "rm"), join(bin, "zap")); // hard link: same inode as rm
    symlinkSync(join(bin, "rm"), join(bin, "myrm"));
    exe(join(bin, "harmless"));
    expect(await identifyExecutable("zap", bin)).toBe("rm");
    expect(await identifyExecutable("myrm", bin)).toBe("rm");
    expect(await identifyExecutable("harmless", bin)).toBe("harmless");
    expect(await identifyExecutable(join(bin, "zap"), bin)).toBe("rm");
    expect(await identifyExecutable("missing-tool", bin)).toBeUndefined();
  });

  it("a check whose binary is an alias of rm is denied before it runs", async () => {
    const { linkSync } = await import("node:fs");
    const ws = workspace();
    const bin = join(tmp(), "bin");
    exe(join(bin, "rm"));
    linkSync(join(bin, "rm"), join(bin, "zap"));
    const r = await preflightCheck(
      { id: "c", command: ["zap", "-rf", "victim"] },
      { workspace: ws, path: bin },
    );
    expect(r).toMatchObject({ ok: false, reason: "policy_denied" });
    if (!r.ok) expect(r.message).toMatch(/resolves to 'rm'.*rm -rf/);
  });
});

describe("pnpm <script> shorthand (fix round 2, minor 7)", () => {
  it("is recognised for the dependency-install guard when the script exists", async () => {
    const { dependencyInstallNeeded } = await import("./index.js");
    const ws = tmp();
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc" }, dependencies: { a: "1" } }),
    );
    expect(await dependencyInstallNeeded(["pnpm", "typecheck"], ws, ws)).toMatch(
      /would install dependencies/,
    );
    expect(await dependencyInstallNeeded(["pnpm", "tsc"], ws, ws)).toBeUndefined();
  });
});
