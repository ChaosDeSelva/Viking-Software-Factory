import { spawn } from "node:child_process";
import {
  appendFileSync,
  symlinkSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { treeDigest, type VerificationReport } from "@brokkr/core";
import { stringify } from "yaml";
import { runsRootFor } from "@brokkr/evidence";
import { Registry, createLock } from "@brokkr/registry";
import { cli, homeFor, tmp } from "./helpers.js";
import { e2eRepo, toolPath } from "./e2e-helpers.js";

const PATH = toolPath();
const env = { PATH };
const BIN = resolve(import.meta.dirname, "../dist/bin.js");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function pids(repo: string): number[] {
  const file = join(repo, "pids");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split(" ").map(Number) : [];
}

function runDir(repo: string, report: VerificationReport): string {
  return join(runsRootFor(repo, homeFor(repo)), report.id);
}

async function verify(repo: string, extra: string[] = [], options: { signal?: AbortSignal } = {}) {
  const result = await cli(["verify", "--json", "--cwd", repo, ...extra], { env, ...options });
  return { ...result, report: result.json<VerificationReport>() };
}

describe("e2e (spec §18.5)", { timeout: 60_000 }, () => {
  it("a valid React project passes all configured checks", async () => {
    const repo = e2eRepo(["e2e-react"]);
    const { code, report } = await verify(repo);
    expect(report.checks.map((c) => [c.id, c.state])).toEqual([
      ["typecheck", "passed"],
      ["unit", "passed"],
    ]);
    expect(report.verdict).toBe("passed");
    expect(code).toBe(0);
    const dir = runDir(repo, report);
    for (const f of ["report.json", "report.md", "evidence-manifest.json", "logs/unit.log"])
      expect(existsSync(join(dir, f)), f).toBe(true);
    expect(report.repository.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.repository.dirtyTreeDigest).toMatch(/^sha256:/);
  });

  it("human output streams per-check timing and the report path", async () => {
    const repo = e2eRepo(["e2e-react"]);
    const result = await cli(["verify", "--cwd", repo], { env });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/BROKKR \/ VERIFY/);
    expect(result.stdout).toMatch(/✓ typecheck\s+\d+(\.\d)?m?s/);
    expect(result.stdout).toMatch(/✓ unit\s+\d+(\.\d)?m?s/);
    expect(result.stdout).toMatch(/PASSED/);
    expect(result.stdout).toMatch(/2\/2 required gates passed/);
    expect(result.stdout).toMatch(/Report: .*report\.md/);
  });

  it("a TypeScript error fails verification", async () => {
    const repo = e2eRepo(["e2e-react"]);
    writeFileSync(join(repo, "src", "broken.ts"), "export const n: number = 'not a number';\n");
    const { code, report } = await verify(repo);
    expect(report.checks.find((c) => c.id === "typecheck")).toMatchObject({
      state: "failed",
      exitCode: 2,
    });
    expect(report.verdict).toBe("failed");
    expect(code).toBe(1);
    const log = readFileSync(join(runDir(repo, report), "logs", "typecheck.log"), "utf8");
    expect(log).toMatch(/TS2322/);
  });

  it("a failing unit test returns a failed verdict", async () => {
    const repo = e2eRepo(["e2e-react"]);
    writeFileSync(
      join(repo, "tests", "broken.test.mjs"),
      "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('fails', () => assert.equal(1, 2));\n",
    );
    const { code, report } = await verify(repo);
    expect(report.checks.find((c) => c.id === "unit")?.state).toBe("failed");
    expect(report.verdict).toBe("failed");
    expect(code).toBe(1);
  });

  it("a required check that cannot execute is incomplete, never a pass", async () => {
    const repo = e2eRepo(["e2e-missing-tool"]);
    const { code, report } = await verify(repo);
    expect(report.checks.find((c) => c.id === "lint")).toMatchObject({
      state: "skipped",
      reason: "missing_tool",
    });
    expect(report.verdict).toBe("incomplete");
    expect(code).toBe(1);
  });

  it("an untrusted harness cannot execute commands without authorization", async () => {
    const repo = e2eRepo([]);
    const vendor = join(repo, "vendor", "harnesses");
    const { cpSync } = await import("node:fs");
    cpSync(
      join(resolve(import.meta.dirname, "../../../tests/fixtures/harnesses/e2e-untrusted")),
      join(vendor, "e2e-untrusted"),
      {
        recursive: true,
      },
    );
    const digest = await treeDigest(vendor);
    writeFileSync(
      join(repo, ".brokkr", "config.yaml"),
      stringify({
        version: 1,
        harnesses: [{ name: "e2e-untrusted", version: "^1.0.0" }],
        sources: [{ path: "vendor/harnesses", digest, trusted: false }],
      }),
    );
    // Resolution refuses untrusted sources first; the runner/policy `untrusted_source`
    // blocked-verdict path remains covered by unit tests as defense in depth.
    const { code, json } = await cli(["verify", "--json", "--cwd", repo], { env });
    expect(code).toBe(4);
    expect(json<{ error: { code: string } }>().error.code).toBe("trust_required");
    expect(existsSync(join(repo, "ran-untrusted"))).toBe(false);

    // After explicit authorization (`brokkr trust add`) the same harness may run.
    const trusted = await cli([
      "trust",
      "add",
      "vendor/harnesses",
      "--digest",
      digest,
      "--cwd",
      repo,
    ]);
    expect(trusted.code).toBe(0);
    const again = await verify(repo);
    expect(again.report.verdict).toBe("passed");
    expect(existsSync(join(repo, "ran-untrusted"))).toBe(true);
  });

  it("a malicious manifest cannot escape its working directory", async () => {
    const repo = e2eRepo(["e2e-escape"]);
    const result = await cli(["verify", "--cwd", repo], { env });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cwd/);
    expect(result.stderr).toMatch(/inside its base directory/);
    expect(existsSync(join(repo, "..", "..", "escaped"))).toBe(false);
  });

  it("an interrupted run preserves partial evidence and kills the check", async () => {
    const repo = e2eRepo(["e2e-slow"]);
    const controller = new AbortController();
    const pending = verify(repo, [], { signal: controller.signal });
    await waitFor(() => pids(repo).length === 2);
    controller.abort();
    const { code, report } = await pending;
    expect(code).toBe(130);
    expect(report.interrupted).toBe(true);
    expect(report.checks.map((c) => [c.id, c.state])).toEqual([
      ["quick", "passed"],
      ["slow", "cancelled"],
    ]);
    const dir = runDir(repo, report);
    expect(readFileSync(join(dir, "logs", "quick.log"), "utf8")).toContain("quick ok");
    expect(readFileSync(join(dir, "logs", "slow.log"), "utf8")).toContain("tree started");
    const tree = pids(repo);
    await waitFor(() => tree.every((p) => !alive(p)));
  });

  it("Ctrl-C on the built bin: cancelled report preserved, exit 130, children gone", async () => {
    const repo = e2eRepo(["e2e-slow"]);
    const child = spawn(process.execPath, [BIN, "verify", "--cwd", repo], {
      env: { PATH, BROKKR_HOME: homeFor(repo), BROKKR_LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    await waitFor(() => pids(repo).length === 2);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code).toBe(130);
    const runs = readdirSync(runsRootFor(repo, homeFor(repo)));
    expect(runs).toHaveLength(1);
    const report = JSON.parse(
      readFileSync(join(runsRootFor(repo, homeFor(repo)), runs[0]!, "report.json"), "utf8"),
    ) as VerificationReport;
    expect(report.interrupted).toBe(true);
    expect(report.checks.find((c) => c.id === "slow")?.state).toBe("cancelled");
    const tree = pids(repo);
    expect(tree).toHaveLength(2);
    await waitFor(() => tree.every((p) => !alive(p)));
    expect(out).toMatch(/interrupted/i);
  });

  it("Ctrl-C with a SIGTERM-ignoring check and a pipe-holding escapee still writes the report", async () => {
    const repo = e2eRepo(["e2e-stubborn"]);
    const child = spawn(process.execPath, [BIN, "verify", "--cwd", repo], {
      env: { PATH, BROKKR_HOME: homeFor(repo), BROKKR_LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(() => pids(repo).length === 2);
    const [main, escapee] = pids(repo);
    const started = Date.now();
    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    const elapsed = Date.now() - started;
    try {
      process.kill(escapee!, "SIGKILL");
    } catch {
      // already gone
    }
    expect(code).toBe(130);
    expect(elapsed).toBeLessThan(10_000);
    const runs = readdirSync(runsRootFor(repo, homeFor(repo)));
    const report = JSON.parse(
      readFileSync(join(runsRootFor(repo, homeFor(repo)), runs[0]!, "report.json"), "utf8"),
    ) as VerificationReport;
    expect(report.interrupted).toBe(true);
    expect(report.checks.find((c) => c.id === "slow")?.state).toBe("cancelled");
    await waitFor(() => !alive(main!));
  });

  it("check output cannot inject terminal escapes into the human output (audit I7)", async () => {
    const repo = e2eRepo(["e2e-ansi"]);
    const result = await cli(["verify", "--cwd", repo], { env });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("PASSED · 9/9 required gates passed");
    // eslint-disable-next-line no-control-regex -- asserting no control characters reach the terminal
    expect(result.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("a timed-out check terminates its owned process tree", async () => {
    const repo = e2eRepo(["e2e-timeout"]);
    const { code, report } = await verify(repo);
    expect(report.checks[0]).toMatchObject({ id: "slow", state: "timed_out", reason: "timeout" });
    expect(report.verdict).toBe("incomplete");
    expect(code).toBe(1);
    const tree = pids(repo);
    expect(tree).toHaveLength(2);
    await waitFor(() => tree.every((p) => !alive(p)));
  });

  it("a missing dependency produces a clear diagnostic", async () => {
    const repo = e2eRepo(["e2e-missing-dep"]);
    // node and pnpm are available, TypeScript is neither installed in the project nor global.
    const result = await cli(["verify", "--cwd", repo], {
      env: { PATH: toolPath({ tsc: false }) },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/typecheck.*skipped.*missing_tool/);
    expect(result.stdout).toMatch(/'tsc' is not installed.*pnpm install/);
  });

  it("a conflicting harness combination is rejected", async () => {
    const repo = e2eRepo(["e2e-conflict-a", "e2e-conflict-b"]);
    const result = await cli(["verify", "--cwd", repo], { env });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/conflict/i);
  });

  it("a modified harness fails lockfile integrity validation", async () => {
    const repo = e2eRepo(["e2e-react"]);
    expect((await cli(["harness", "lock", "--cwd", repo])).code).toBe(0);
    expect((await verify(repo)).report.verdict).toBe("passed");
    appendFileSync(
      join(repo, ".brokkr", "harnesses", "e2e-react", "harness.yaml"),
      "\n# tampered\n",
    );
    const { code, report } = await verify(repo);
    expect(report.verdict).toBe("blocked");
    expect(code).toBe(4);
    expect(report.reasons.join("\n")).toMatch(/lock_integrity: harness e2e-react@1.0.0 modified/);
    expect(report.checks.every((c) => c.state === "skipped")).toBe(true);
  });

  it("a secret in output blocks the run and is redacted in evidence", async () => {
    const repo = e2eRepo(["e2e-secret"]);
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const { code, report, stdout } = await verify(repo);
    expect(report.verdict).toBe("blocked");
    expect(code).toBe(4);
    expect(report.reasons[0]).toMatch(/secret_exposure/);
    const dir = runDir(repo, report);
    const log = readFileSync(join(dir, "logs", "leaky.log"), "utf8");
    expect(log).toContain("[REDACTED:aws-access-key]");
    for (const f of ["logs/leaky.log", "report.json", "report.md"])
      expect(readFileSync(join(dir, f), "utf8"), f).not.toContain(key);
    expect(stdout).not.toContain(key);
  });
});

describe("not-applicable required checks (ruling a)", { timeout: 60_000 }, () => {
  it("built-in frontend-react on a repo without Playwright: browser checks are N/A, shown prominently", async () => {
    const repo = e2eRepo([]);
    writeFileSync(
      join(repo, ".brokkr", "config.yaml"),
      stringify({ version: 1, harnesses: [{ name: "frontend-react", version: "^1.0.0" }] }),
    );
    const { report } = await verify(repo);
    for (const id of ["screenshot-desktop", "screenshot-mobile", "axe"]) {
      expect(
        report.checks.find((c) => c.id === id),
        id,
      ).toMatchObject({
        required: true,
        state: "skipped",
        reason: "not_applicable",
      });
      expect(report.reasons).toContain(
        `required check '${id}' not applicable (excluded from required gates)`,
      );
    }
    const human = await cli(["verify", "--cwd", repo], { env });
    expect(human.stdout).toMatch(/Required checks not applicable \(3\)/);
    expect(human.stdout).toMatch(/axe .*when.anyFileExists/);
    const md = readFileSync(join(runDir(repo, report), "report.md"), "utf8");
    expect(md).toContain("## Required checks not applicable");
  });
});

describe("exception and policy provenance (B2 review I5)", { timeout: 60_000 }, () => {
  const exceptionsYaml = (id: string) =>
    stringify({
      exceptions: [
        {
          id,
          policy: "check:unit",
          scope: {},
          reason: "flaky",
          approvedBy: "someone",
          approvedAt: "2026-01-01T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
          evidence: [],
        },
      ],
    });

  function repoWithWaivableUnit(): string {
    const repo = e2eRepo(["e2e-react"]);
    const file = join(repo, ".brokkr", "harnesses", "e2e-react", "harness.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "      scriptExists: [test]",
        "      scriptExists: [test]\n    waivable: true",
      ),
    );
    writeFileSync(join(repo, ".brokkr", "exceptions.yaml"), exceptionsYaml("from-workspace"));
    return repo;
  }

  it("exceptions read from the workspace are marked workspace_supplied", async () => {
    const repo = repoWithWaivableUnit();
    const { report } = await verify(repo);
    expect(report.policySources).toContainEqual(
      expect.objectContaining({
        kind: "exceptions",
        origin: "workspace_supplied",
        path: ".brokkr/exceptions.yaml",
      }),
    );
    expect(report.exceptions[0]).toMatchObject({
      id: "from-workspace",
      origin: "workspace_supplied",
    });
    const md = readFileSync(join(runDir(repo, report), "report.md"), "utf8");
    expect(md).toMatch(/## Policy sources[\s\S]*workspace_supplied/);
  });

  it("--exceptions and --policy from outside the workspace replace the workspace files", async () => {
    const repo = repoWithWaivableUnit();
    const outside = realpathSync(tmp("brokkr-approvals-"));
    writeFileSync(join(outside, "exceptions.yaml"), exceptionsYaml("from-mimir"));
    writeFileSync(join(outside, "policy.yaml"), stringify({ requiredCheckIds: ["typecheck"] }));
    const { report } = await verify(repo, [
      "--exceptions",
      join(outside, "exceptions.yaml"),
      "--policy",
      join(outside, "policy.yaml"),
    ]);
    expect(report.exceptions.map((e) => e.id)).toEqual(["from-mimir"]);
    expect(report.exceptions[0]!.origin).toBe("external");
    expect(report.policySources).toEqual([
      expect.objectContaining({
        kind: "exceptions",
        origin: "external",
        path: join(outside, "exceptions.yaml"),
      }),
      expect.objectContaining({
        kind: "project-policy",
        origin: "external",
        path: join(outside, "policy.yaml"),
      }),
    ]);
    expect(report.checks.find((c) => c.id === "typecheck")?.requiredBy).toBe("policy");
  });

  it("--exceptions pointing inside the workspace is still workspace_supplied", async () => {
    const repo = repoWithWaivableUnit();
    writeFileSync(join(repo, "approvals.yaml"), exceptionsYaml("sneaky"));
    const { report } = await verify(repo, ["--exceptions", join(repo, "approvals.yaml")]);
    expect(report.policySources).toContainEqual(
      expect.objectContaining({
        kind: "exceptions",
        origin: "workspace_supplied",
        path: "approvals.yaml",
      }),
    );
  });
});

describe(
  "pnpm never installs dependencies behind the check's back (B3b finding)",
  { timeout: 60_000 },
  () => {
    function repoWithDeps(): string {
      const repo = e2eRepo([]);
      mkdirSync(join(repo, ".brokkr", "harnesses", "e2e-pnpm"), { recursive: true });
      writeFileSync(
        join(repo, ".brokkr", "harnesses", "e2e-pnpm", "harness.yaml"),
        readFileSync(
          join(
            resolve(
              import.meta.dirname,
              "../../../tests/fixtures/harnesses/e2e-react/harness.yaml",
            ),
          ),
          "utf8",
        )
          .replace(/e2e-react/g, "e2e-pnpm")
          .replace("command: [node, --test]", "command: [pnpm, test]")
          .replace(/ {2}- id: typecheck[\s\S]*?(?= {2}- id: unit)/, ""),
      );
      writeFileSync(
        join(repo, ".brokkr", "config.yaml"),
        stringify({ version: 1, harnesses: [{ name: "e2e-pnpm", version: "^1.0.0" }] }),
      );
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          name: "x",
          private: true,
          scripts: { test: "echo script-ran" },
          dependencies: { "left-pad": "1.3.0" },
        }),
      );
      return repo;
    }

    it("missing node_modules: the run is blocked with policy_denied quickly instead of hanging", async () => {
      const repo = repoWithDeps();
      const started = Date.now();
      const { report, code } = await verify(repo);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(report.checks[0]).toMatchObject({
        id: "unit",
        state: "skipped",
        reason: "policy_denied",
      });
      expect(report.verdict).toBe("blocked");
      expect(code).toBe(4);
    });

    it("node_modules present but stale: pnpm runs the script without installing (≤5 s)", async () => {
      const repo = repoWithDeps();
      mkdirSync(join(repo, "node_modules"));
      const { report } = await verify(repo);
      const unit = report.checks[0]!;
      expect(unit.state).toBe("passed");
      expect(unit.durationMs).toBeLessThan(5000);
      expect(existsSync(join(repo, "node_modules", "left-pad"))).toBe(false);
    });
  },
);

describe("workspace-untrusted mode (audit C1/C2 repros)", { timeout: 90_000 }, () => {
  const FIX = resolve(import.meta.dirname, "../../../tests/fixtures/harnesses");

  /** repoA: the worktree adds its own always-passing harness and shadows a built-in profile. */
  function repoA(): string {
    const repo = e2eRepo([]);
    cpSync(join(FIX, "e2e-slow"), join(repo, ".brokkr", "harnesses", "noop"), { recursive: true });
    const file = join(repo, ".brokkr", "harnesses", "noop", "harness.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replace(/e2e-slow/g, "noop")
        .replace(/ {2}- id: slow[\s\S]*?(?=policies:)/, ""),
    );
    writeFileSync(
      join(repo, ".brokkr", "config.yaml"),
      stringify({
        version: 1,
        harnesses: [{ name: "noop", version: "^1.0.0" }],
        profiles: [{ name: "frontend-strict", harnesses: [{ name: "noop", version: "^1.0.0" }] }],
      }),
    );
    return repo;
  }

  /** Caller-side inputs: e2e-react installed as a user harness, config and lock outside the repo. */
  async function callerInputs(repo: string) {
    const home = homeFor(repo);
    cpSync(join(FIX, "e2e-react"), join(home, ".brokkr", "harnesses", "e2e-react"), {
      recursive: true,
    });
    const outside = realpathSync(tmp("brokkr-caller-"));
    const config = { version: 1 as const, harnesses: [{ name: "e2e-react", version: "^1.0.0" }] };
    writeFileSync(join(outside, "config.yaml"), stringify(config));
    const registry = new Registry({
      cwd: outside,
      builtinDir: join(outside, "none"),
      homeDir: home,
      config,
    });
    await registry.load();
    const lock = createLock(
      registry.resolve({ harnesses: [{ name: "e2e-react", range: "^1.0.0" }] }),
      [],
    );
    writeFileSync(join(outside, "lock.json"), JSON.stringify(lock));
    return { outside, config: join(outside, "config.yaml"), lock: join(outside, "lock.json") };
  }

  it("a config profile may not shadow a built-in profile (developer mode too)", async () => {
    const result = await cli(["verify", "--profile", "frontend-strict", "--cwd", repoA()], { env });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/shadows the built-in profile/);
  });

  it("refuses to run without a caller-supplied config", async () => {
    const result = await cli(["verify", "--untrusted-workspace", "--cwd", repoA()], { env });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/caller-supplied config/);
  });

  it("a workspace-supplied harness never runs, even if the caller config names it", async () => {
    const repo = repoA();
    const outside = realpathSync(tmp("brokkr-caller-"));
    writeFileSync(
      join(outside, "config.yaml"),
      stringify({ version: 1, harnesses: [{ name: "noop", version: "^1.0.0" }] }),
    );
    const result = await cli(
      [
        "verify",
        "--untrusted-workspace",
        "--config",
        join(outside, "config.yaml"),
        "--json",
        "--cwd",
        repo,
      ],
      { env },
    );
    expect(result.code).toBe(4);
    expect(result.json<{ error: { code: string } }>().error.code).toBe("trust_required");
  });

  it("without a caller lock the run is blocked, never a warning", async () => {
    const repo = repoA();
    const caller = await callerInputs(repo);
    const { report, code } = await verify(repo, [
      "--untrusted-workspace",
      "--config",
      caller.config,
    ]);
    expect(report.trustMode).toBe("workspace-untrusted");
    expect(report.verdict).toBe("blocked");
    expect(code).toBe(4);
    expect(report.reasons.join()).toMatch(/lock_integrity: no lock supplied by the caller/);
    expect(report.harnesses.map((h) => h.name)).toEqual(["e2e-react"]);
  });

  it("with caller config and lock the real checks run; workspace exceptions are ignored", async () => {
    const repo = repoA();
    writeFileSync(
      join(repo, ".brokkr", "exceptions.yaml"),
      stringify({
        exceptions: [
          {
            id: "self-granted",
            policy: "check:unit",
            scope: {},
            reason: "trust me",
            approvedBy: "security-team@example.com",
            approvedAt: "2026-01-01T00:00:00Z",
            expiresAt: "2099-01-01T00:00:00Z",
            evidence: [],
          },
        ],
      }),
    );
    const caller = await callerInputs(repo);
    const { report, code } = await verify(repo, [
      "--untrusted-workspace",
      "--config",
      caller.config,
      "--lock",
      caller.lock,
    ]);
    expect(report.checks.map((c) => [c.id, c.state])).toEqual([
      ["typecheck", "passed"],
      ["unit", "passed"],
    ]);
    expect(report.exceptions).toEqual([]);
    expect(report.verdict).toBe("passed");
    expect(code).toBe(0);
    expect(report.warnings.join()).toMatch(/workspace \.brokkr\/exceptions\.yaml ignored/);
  });

  it("repoB: self-asserted waivers for every required check never PASS (developer mode)", async () => {
    const repo = e2eRepo(["e2e-react"]);
    const file = join(repo, ".brokkr", "config.yaml");
    writeFileSync(
      file,
      stringify({
        version: 1,
        harnesses: [{ name: "e2e-react", version: "^1.0.0" }],
        policies: { waivable: ["check:typecheck", "check:unit"] },
      }),
    );
    const exc = (id: string, policy: string) => ({
      id,
      policy,
      scope: {},
      reason: "r",
      approvedBy: "security-team@example.com",
      approvedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      evidence: [],
    });
    writeFileSync(
      join(repo, ".brokkr", "exceptions.yaml"),
      stringify({ exceptions: [exc("e1", "check:typecheck"), exc("e2", "check:unit")] }),
    );
    const { report, code } = await verify(repo);
    expect(report.checks.every((c) => c.state === "skipped")).toBe(true);
    expect(report.verdict).toBe("incomplete");
    expect(code).toBe(1);
    expect(report.reasons).toContain("no required check actually ran and passed");
  });
});

describe("mixed-case command names (fix round 2, C1 reviewer probe)", { timeout: 60_000 }, () => {
  it("a trusted harness check `Rm -rf victim` is blocked and victim/ survives", async () => {
    const repo = e2eRepo(["e2e-react"]);
    const file = join(repo, ".brokkr", "harnesses", "e2e-react", "harness.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "checks:\n",
        "checks:\n  - id: rmcheck\n    command: [Rm, -rf, victim]\n    required: true\n    timeoutSeconds: 30\n",
      ),
    );
    mkdirSync(join(repo, "victim"));
    writeFileSync(join(repo, "victim", "precious"), "1");
    const { report, code } = await verify(repo);
    expect(report.verdict).toBe("blocked");
    expect(code).toBe(4);
    expect(report.reasons.join()).toMatch(/destructive-commands.*rm -rf/);
    expect(existsSync(join(repo, "victim", "precious"))).toBe(true);
  });
});

describe(
  "reviewer probe u6: a check cannot poison ~/.brokkr (fix round 2, I3)",
  { timeout: 120_000 },
  () => {
    it("writes to $HOME land in a scratch home; the second run still runs and fails the test", async () => {
      const repo = e2eRepo([]);
      const home = homeFor(repo);
      // caller-side: a user harness whose unit check runs the workspace's t.mjs
      const h = join(home, ".brokkr", "harnesses", "u6");
      mkdirSync(h, { recursive: true });
      writeFileSync(
        join(h, "harness.yaml"),
        readFileSync(
          join(
            resolve(
              import.meta.dirname,
              "../../../tests/fixtures/harnesses/e2e-react/harness.yaml",
            ),
          ),
          "utf8",
        )
          .replace(/e2e-react/g, "u6")
          .replace(
            /checks:[\s\S]*?(?=policies:)/,
            "checks:\n  - id: unit\n    command: [node, t.mjs]\n    required: true\n    timeoutSeconds: 60\n",
          ),
      );
      const outside = realpathSync(tmp("brokkr-caller-"));
      const config = { version: 1 as const, harnesses: [{ name: "u6", version: "^1.0.0" }] };
      writeFileSync(join(outside, "config.yaml"), stringify(config));
      const registry = new Registry({
        cwd: outside,
        builtinDir: join(outside, "none"),
        homeDir: home,
        config,
      });
      await registry.load();
      writeFileSync(
        join(outside, "lock.json"),
        JSON.stringify(
          createLock(registry.resolve({ harnesses: [{ name: "u6", range: "^1.0.0" }] }), []),
        ),
      );
      // workspace: first run plants org policy + an approved exception in $HOME/.brokkr and passes; later runs fail
      writeFileSync(
        join(repo, "t.mjs"),
        `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const marker = "first-run-done";
if (existsSync(marker)) process.exit(1);
writeFileSync(marker, "1");
const dir = process.env.HOME + "/.brokkr";
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/org-policy.yaml", "waivable: [check:unit]\\n");
writeFileSync(dir + "/exceptions.yaml", "exceptions:\\n  - id: ex-unit\\n    policy: check:unit\\n    scope: {}\\n    reason: r\\n    approvedBy: mimir\\n    approvedAt: 2026-01-01T00:00:00Z\\n    expiresAt: 2099-01-01T00:00:00Z\\n    evidence: []\\n");
`,
      );
      const args = [
        "--untrusted-workspace",
        "--config",
        join(outside, "config.yaml"),
        "--lock",
        join(outside, "lock.json"),
        "--approver",
        "mimir",
      ];
      const run1 = await verify(repo, args);
      expect(run1.report.verdict).toBe("passed");
      expect(existsSync(join(home, ".brokkr", "exceptions.yaml"))).toBe(false);
      expect(existsSync(join(home, ".brokkr", "org-policy.yaml"))).toBe(false);
      const run2 = await verify(repo, args);
      expect(run2.report.checks[0]).toMatchObject({ id: "unit", state: "failed" });
      expect(run2.report.verdict).toBe("failed");
      expect(run2.code).toBe(1);
    });
  },
);

describe("brokkr report and runs", { timeout: 60_000 }, () => {
  it("renders the latest run as json, md and offline html, and verifies integrity", async () => {
    const repo = e2eRepo(["e2e-react"]);
    const { report } = await verify(repo);
    const json = await cli(["report", "--latest", "--format", "json", "--cwd", repo]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).id).toBe(report.id);
    const md = await cli(["report", "--run", report.id, "--format", "md", "--cwd", repo]);
    expect(md.stdout).toMatch(/^# Brokkr verification: PASSED/);
    const html = await cli(["report", "--latest", "--format", "html", "--cwd", repo]);
    expect(html.stdout).toMatch(/^<!doctype html>/);
    expect(html.stdout).not.toMatch(/https?:\/\//);

    appendFileSync(join(runDir(repo, report), "logs", "unit.log"), "tampered\n");
    const tampered = await cli(["report", "--run", report.id, "--cwd", repo]);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toMatch(/integrity/);
    const latest = await cli(["report", "--latest", "--cwd", repo]);
    expect(latest.code).toBe(2);
    expect(latest.stderr).toMatch(/1 run\(s\) failed signature or digest checks/);
  });

  it("report without runs is a clear error", async () => {
    const result = await cli(["report", "--latest", "--cwd", e2eRepo(["e2e-react"])]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no verification runs/);
  });

  it("runs list and prune --keep", async () => {
    const repo = e2eRepo(["e2e-react"]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await verify(repo)).report.id);
    const list = await cli(["runs", "list", "--json", "--cwd", repo]);
    expect(list.json<{ runs: Array<{ id: string }> }>().runs.map((r) => r.id)).toEqual(
      [...ids].reverse(),
    );
    const prune = await cli(["runs", "prune", "--keep", "1", "--json", "--cwd", repo]);
    expect(prune.code).toBe(0);
    expect(prune.json<{ removed: string[] }>().removed.sort()).toEqual(ids.slice(0, 2).sort());
    const bad = await cli(["runs", "prune", "--older-than", "soon", "--cwd", repo]);
    expect(bad.code).toBe(2);
  });
});

describe(
  "replay of a run from another workspace's store (fix round 2, I4 reviewer probe)",
  { timeout: 120_000 },
  () => {
    it("B's runs list, report --latest and report --run reject A's copied run", async () => {
      const a = e2eRepo(["e2e-react"]);
      const b = e2eRepo(["e2e-react"]);
      writeFileSync(join(b, "src", "broken.ts"), "export const n: number = 'x';\n");
      const home = homeFor(a);
      const { report: passed } = await verify(a);
      expect(passed.verdict).toBe("passed");
      const failedB = await cli(["verify", "--json", "--cwd", b], { env, home });
      expect(failedB.json<VerificationReport>().verdict).toBe("failed");
      cpSync(join(runsRootFor(a, home), passed.id), join(runsRootFor(b, home), passed.id), {
        recursive: true,
      });
      const list = await cli(["runs", "list", "--json", "--cwd", b], { env, home });
      expect(list.json<{ runs: Array<{ id: string }> }>().runs.map((r) => r.id)).not.toContain(
        passed.id,
      );
      const latest = await cli(["report", "--latest", "--format", "md", "--cwd", b], { env, home });
      expect(latest.stdout).not.toMatch(/Brokkr verification: PASSED/);
      const direct = await cli(["report", "--run", passed.id, "--cwd", b], { env, home });
      expect(direct.code).toBe(1);
      expect(direct.stderr).toMatch(/another runs root|another workspace/);
    });
  },
);

describe(
  "untrusted inputs and generated bundles (fix round 2, minors 1 and 2)",
  { timeout: 120_000 },
  () => {
    it("a symlinked .brokkr/generated is never followed", async () => {
      const repo = e2eRepo(["e2e-react"]);
      const outside = realpathSync(tmp("brokkr-outside-"));
      writeFileSync(join(outside, "creds.txt"), `key ${["AKIA", "IOSFODNN7EXAMPLE"].join("")}\n`);
      symlinkSync(outside, join(repo, ".brokkr", "generated"));
      const { report } = await verify(repo);
      expect(report.verdict).toBe("passed");
      expect(report.warnings.join()).toMatch(
        /refused to scan \.brokkr\/generated: it is a symlink/,
      );
    });

    it("--task inside the workspace is refused in workspace-untrusted mode", async () => {
      const repo = e2eRepo(["e2e-react"]);
      writeFileSync(
        join(repo, "task.json"),
        JSON.stringify({ id: "T-1", title: "t", description: "" }),
      );
      const outside = realpathSync(tmp("brokkr-caller-"));
      writeFileSync(join(outside, "config.yaml"), stringify({ version: 1, harnesses: [] }));
      const result = await cli(
        [
          "verify",
          "--untrusted-workspace",
          "--config",
          join(outside, "config.yaml"),
          "--task",
          "task.json",
          "--cwd",
          repo,
        ],
        { env },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/task file .* inside the verified workspace/);
    });
  },
);
