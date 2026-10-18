import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANCEL_GRACE_MS,
  CLEANUP_STEP_MS,
  LocalProcessExecutor,
  type CheckExecutionRequest,
} from "./index.js";
import {
  BASE_ENV,
  ESCAPEE_SCRIPT,
  ESCAPEE_WAIT_SCRIPT,
  SILENT_ESCAPEE_SCRIPT,
  NODE,
  TREE_SCRIPT,
  alive,
  readPids,
  tmp,
  waitFor,
} from "../test/helpers.js";

function request(
  workspace: string,
  command: string[],
  over: Partial<CheckExecutionRequest> = {},
): CheckExecutionRequest {
  return {
    checkId: "c",
    command,
    workspace,
    env: BASE_ENV,
    timeoutMs: 20_000,
    logFile: join(workspace, "c.log"),
    ...over,
  };
}

const executor = new LocalProcessExecutor();

describe("LocalProcessExecutor", () => {
  it("passes on exit 0 and streams output to the log and the in-memory tail", async () => {
    const ws = tmp();
    const result = await executor.execute(
      request(ws, [NODE, "-e", "console.log('hello'); console.error('warn')"]),
    );
    expect(result.state).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.outputTail).toContain("hello");
    expect(result.outputTail).toContain("warn");
    expect(readFileSync(join(ws, "c.log"), "utf8")).toContain("hello");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.pid).toBeGreaterThan(0);
  });

  it("fails on a nonzero exit", async () => {
    const result = await executor.execute(request(tmp(), [NODE, "-e", "process.exit(3)"]));
    expect(result.state).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("never uses a shell: metacharacters are passed literally", async () => {
    const ws = tmp();
    const result = await executor.execute(
      request(ws, [NODE, "-e", "console.log(process.argv[1])", "$(touch pwned); `id` | cat"]),
    );
    expect(result.outputTail).toContain("$(touch pwned); `id` | cat");
    expect(() => statSync(join(ws, "pwned"))).toThrow();
  });

  it("passes exactly the given environment", async () => {
    process.env.BROKKR_TEST_PARENT_SECRET = "should-not-leak";
    const result = await executor.execute(
      request(tmp(), [NODE, "-e", "console.log(JSON.stringify(process.env))"], {
        env: { PATH: BASE_ENV.PATH, ONLY: "1" },
      }),
    );
    delete process.env.BROKKR_TEST_PARENT_SECRET;
    const env = JSON.parse(result.outputTail.trim()) as Record<string, string>;
    expect(env.ONLY).toBe("1");
    expect(env.BROKKR_TEST_PARENT_SECRET).toBeUndefined();
  });

  it("rejects a cwd that escapes the workspace with .. without spawning", async () => {
    const result = await executor.execute(request(tmp(), [NODE, "-e", "0"], { cwd: "../.." }));
    expect(result.state).toBe("errored");
    expect(result.reason).toBe("cwd_rejected");
    expect(result.pid).toBeUndefined();
  });

  it("rejects a cwd that escapes through a symlink", async () => {
    const ws = tmp();
    const outside = tmp();
    symlinkSync(outside, join(ws, "link"));
    const result = await executor.execute(request(ws, [NODE, "-e", "0"], { cwd: "link" }));
    expect(result.state).toBe("errored");
    expect(result.reason).toBe("cwd_rejected");
    expect(result.error).toMatch(/outside the workspace/);
  });

  it("runs in a subdirectory inside the workspace", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "pkg"));
    const result = await executor.execute(
      request(ws, [NODE, "-e", "console.log(process.cwd())"], { cwd: "pkg" }),
    );
    expect(result.outputTail.trim()).toBe(join(ws, "pkg"));
  });

  it("reports a missing executable as errored spawn_error", async () => {
    const result = await executor.execute(request(tmp(), ["definitely-not-a-real-tool-xyz"]));
    expect(result.state).toBe("errored");
    expect(result.reason).toBe("spawn_error");
    expect(result.error).toMatch(/ENOENT/);
  });

  it(
    "times out, kills the whole process tree and keeps partial output",
    { timeout: 20_000 },
    async () => {
      const ws = tmp();
      const result = await executor.execute(
        // Generous deadline: the tree must be fully started before the timeout fires,
        // even on a loaded machine; the assertion below waits for that state.
        request(ws, [NODE, "-e", TREE_SCRIPT], { cwd: ".", timeoutMs: 6000, killGraceMs: 500 }),
      );
      expect(result.state).toBe("timed_out");
      expect(result.reason).toBe("timeout");
      expect(result.outputTail).toContain("tree started");
      const pids = readPids(join(ws, "pids"));
      expect(pids).toHaveLength(2);
      await waitFor(() => pids.every((p) => !alive(p)));
    },
  );

  it(
    "cancels via AbortSignal, kills the tree and preserves partial output",
    { timeout: 20_000 },
    async () => {
      const ws = tmp();
      const controller = new AbortController();
      const pending = executor.execute(request(ws, [NODE, "-e", TREE_SCRIPT]), controller.signal);
      await waitFor(() => readPids(join(ws, "pids")).length === 2);
      controller.abort();
      const result = await pending;
      expect(result.state).toBe("cancelled");
      expect(result.reason).toBe("cancelled");
      expect(readFileSync(join(ws, "c.log"), "utf8")).toContain("tree started");
      const pids = readPids(join(ws, "pids"));
      await waitFor(() => pids.every((p) => !alive(p)));
    },
  );

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(request(tmp(), [NODE, "-e", "0"]), controller.signal);
    expect(result.state).toBe("cancelled");
    expect(result.pid).toBeUndefined();
  });

  it("cleans up processes left behind by a check that exited", { timeout: 20_000 }, async () => {
    const ws = tmp();
    const script = TREE_SCRIPT.replace("setInterval(() => {}, 1000);", "process.exit(0);");
    const result = await executor.execute(request(ws, [NODE, "-e", script]));
    expect(result.state).toBe("passed");
    const [, grandchild] = readPids(join(ws, "pids"));
    await waitFor(() => !alive(grandchild!));
  });

  it("bounds the log file and the in-memory tail", async () => {
    const ws = tmp();
    const result = await executor.execute(
      request(
        ws,
        [NODE, "-e", "for (let i = 0; i < 4000; i++) console.log(String(i).padStart(63, '.'))"],
        {
          maxLogBytes: 50_000,
          tailBytes: 1024,
        },
      ),
    );
    expect(result.state).toBe("passed");
    expect(result.outputBytes).toBe(4000 * 64);
    expect(result.truncated).toBe(true);
    const log = readFileSync(join(ws, "c.log"), "utf8");
    expect(Buffer.byteLength(log)).toBeLessThan(50_000 + 200);
    expect(log).toMatch(/\[brokkr: log truncated at 50000 bytes\]/);
    expect(result.outputTail.length).toBeLessThanOrEqual(1024);
    expect(result.outputTail).toContain("3999");
  });

  it("redacts output through the redactor before it reaches log or tail", async () => {
    const ws = tmp();
    const result = await executor.execute(
      request(ws, [NODE, "-e", "console.log('key=' + 'SECRETVALUE')"], {
        createRedactor: () => {
          let n = 0;
          return {
            write: (s: string) => s.replace(/SECRETVALUE/g, () => (n++, "[REDACTED]")),
            flush: () => "",
            get findings() {
              return n;
            },
          };
        },
      }),
    );
    expect(result.secretFindings).toBe(1);
    expect(result.outputTail).toContain("key=[REDACTED]");
    expect(readFileSync(join(ws, "c.log"), "utf8")).not.toContain("SECRETVALUE");
  });

  it("reports max RSS when the platform allows sampling", { timeout: 20_000 }, async () => {
    const result = await executor.execute(
      request(tmp(), [
        NODE,
        "-e",
        "const b = Buffer.alloc(32e6, 1); setTimeout(() => console.log(b.length), 3000)",
      ]),
    );
    expect(result.state).toBe("passed");
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(result.maxRssBytes).toBeGreaterThan(1_000_000);
    }
  });
});

describe("descendants that leave the process group (B2 review I1)", () => {
  const kill = (pid: number | undefined): void => {
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  };

  it(
    "a passing main process with an escapee holding the pipes is bounded and not passed",
    { timeout: 30_000 },
    async () => {
      const ws = tmp();
      const started = Date.now();
      const result = await executor.execute(
        request(ws, [NODE, "-e", ESCAPEE_SCRIPT], { timeoutMs: 20_000, killGraceMs: 500 }),
      );
      const wall = Date.now() - started;
      kill(readPids(join(ws, "escapee"))[0]);
      expect(result.state).toBe("errored");
      expect(result.reason).toBe("orphaned_descendants");
      expect(result.error).toMatch(
        /output pipe held by a process outside the process group|outlived the check/,
      );
      expect(result.exitCode).toBe(0);
      expect(result.outputTail).toContain("escapee started");
      // grace + bounded cleanup steps + a second grace + slack for a loaded host
      expect(wall).toBeLessThan(500 + 2 * CLEANUP_STEP_MS + 500 + 8000);
    },
  );

  it(
    "cancelling a check whose escapee keeps the pipes open is bounded and reports it (readiness-gated)",
    { timeout: 60_000 },
    async () => {
      const ws = tmp();
      const controller = new AbortController();
      const pending = executor.execute(
        request(ws, [NODE, "-e", ESCAPEE_WAIT_SCRIPT], { timeoutMs: 60_000, killGraceMs: 500 }),
        controller.signal,
      );
      await waitFor(() => readPids(join(ws, "escapee")).length === 1, 30_000);
      // let the sampler see the escapee as a descendant of the running check
      await new Promise((r) => setTimeout(r, 1000));
      const started = Date.now();
      controller.abort();
      const result = await pending;
      const wall = Date.now() - started;
      const [escapee] = readPids(join(ws, "escapee"));
      expect(result.state).toBe("cancelled");
      expect(result.error).toMatch(/outside the process group|outlived the check/);
      await waitFor(() => !alive(escapee!), 5000);
      expect(wall).toBeLessThan(CANCEL_GRACE_MS + 2 * CLEANUP_STEP_MS + 500 + 8000);
    },
  );

  it(
    "cancelling a SIGTERM-ignoring check escalates to SIGKILL within the short cancel grace (waits for readiness, so deterministic)",
    { timeout: 30_000 },
    async () => {
      const ws = tmp();
      const controller = new AbortController();
      const pending = executor.execute(
        request(
          ws,
          [
            NODE,
            "-e",
            "process.on('SIGTERM', () => {}); require('fs').writeFileSync('up', '1'); setInterval(() => {}, 1000)",
          ],
          { killGraceMs: 20_000 },
        ),
        controller.signal,
      );
      await waitFor(() => existsSync(join(ws, "up")));
      const started = Date.now();
      controller.abort();
      const result = await pending;
      expect(result.state).toBe("cancelled");
      // SIGTERM was ignored, so the group was escalated to SIGKILL after the grace period.
      expect(result.signal).toBe("SIGKILL");
      // grace + bounded cleanup steps + slack for a loaded machine
      expect(Date.now() - started).toBeLessThan(CANCEL_GRACE_MS + 2 * CLEANUP_STEP_MS + 4000);
    },
  );
});

describe("timeout escalation (QA: load-flaky SIGKILL test made deterministic)", () => {
  it(
    "a SIGTERM-ignoring check that hits its deadline is SIGKILLed after the grace",
    { timeout: 120_000 },
    async () => {
      // The child installs its SIGTERM handler and only then writes `up`. A run whose
      // deadline fired before `up` existed tested node start-up, not escalation: it is
      // retried with a longer deadline. Once `up` exists the assertion is strict.
      for (const timeoutMs of [2_500, 10_000, 40_000]) {
        const ws = tmp();
        const result = await executor.execute(
          request(
            ws,
            [
              NODE,
              "-e",
              "process.on('SIGTERM', () => {}); require('fs').writeFileSync('up', '1'); setInterval(() => {}, 1000)",
            ],
            { timeoutMs, killGraceMs: 400 },
          ),
        );
        expect(result.state).toBe("timed_out");
        if (!existsSync(join(ws, "up"))) continue;
        expect(result.signal).toBe("SIGKILL");
        return;
      }
      expect.fail("the child never became ready before its deadline");
    },
  );
});

describe("escaped descendants are found and killed (audit I1)", () => {
  it(
    "a setsid escapee with closed stdio is killed after the run and the check fails",
    { timeout: 30_000 },
    async () => {
      const ws = tmp();
      const result = await executor.execute(
        request(ws, [NODE, "-e", SILENT_ESCAPEE_SCRIPT], { timeoutMs: 20_000, killGraceMs: 500 }),
      );
      const [escapee] = readPids(join(ws, "escapee"));
      expect(escapee).toBeGreaterThan(0);
      await waitFor(() => !alive(escapee!), 5000);
      expect(result.state).toBe("errored");
      expect(result.reason).toBe("orphaned_descendants");
      expect(result.error).toMatch(/descendant process\(es\) outlived the check/);
    },
  );

  it(
    "on timeout an escapee of a still-running check is killed too",
    { timeout: 60_000 },
    async () => {
      const ws = tmp();
      const started = Date.now();
      // Deadline generous enough for the escapee to exist before it fires on a loaded host.
      const result = await executor.execute(
        request(ws, [NODE, "-e", ESCAPEE_WAIT_SCRIPT], { timeoutMs: 8000, killGraceMs: 500 }),
      );
      const [escapee] = readPids(join(ws, "escapee"));
      expect(escapee).toBeGreaterThan(0);
      await waitFor(() => !alive(escapee!), 5000);
      expect(result.state).toBe("timed_out");
      expect(Date.now() - started).toBeLessThan(8000 + 500 + 2 * CLEANUP_STEP_MS + 500 + 8000);
    },
  );

  it("each check gets a unique BROKKR_CHECK_TOKEN", async () => {
    const one = await executor.execute(
      request(tmp(), [NODE, "-e", "console.log(process.env.BROKKR_CHECK_TOKEN)"]),
    );
    const two = await executor.execute(
      request(tmp(), [NODE, "-e", "console.log(process.env.BROKKR_CHECK_TOKEN)"]),
    );
    expect(one.outputTail.trim()).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.outputTail).not.toBe(two.outputTail);
  });
});

describe("an immediate double-fork escapee holding the pipes (audit I1 probe)", () => {
  it(
    "is bounded, fails the check and, where the platform allows, is killed",
    { timeout: 30_000 },
    async () => {
      const ws = tmp();
      const started = Date.now();
      const result = await executor.execute(
        request(
          ws,
          [
            "perl",
            "-e",
            'use POSIX qw(setsid); if(fork){exit 0} setsid(); open P,">pids"; print P $$; close P; sleep 6; print "late"; open F,">escaped.txt"; print F "alive"; close F',
          ],
          // the main perl process exits right after forking; the deadline only has to outlast
          // its start-up on a loaded host
          { timeoutMs: 10_000, killGraceMs: 200 },
        ),
      );
      expect(Date.now() - started).toBeLessThan(10_000 + 200 + 2 * CLEANUP_STEP_MS + 200 + 8000);
      expect(result.state).toBe("errored");
      expect(result.reason).toBe("orphaned_descendants");
      if (process.platform === "darwin" || process.platform === "linux") {
        await new Promise((r) => setTimeout(r, 6500));
        expect(existsSync(join(ws, "escaped.txt"))).toBe(false);
      }
    },
  );
});

describe("package managers never auto-install before running a script (B3b finding)", () => {
  it("sets verify-deps-before-run=false for npm- and pnpm-style config", async () => {
    const result = await executor.execute(
      request(tmp(), [
        NODE,
        "-e",
        "console.log(process.env.npm_config_verify_deps_before_run, process.env.pnpm_config_verify_deps_before_run)",
      ]),
    );
    expect(result.outputTail.trim()).toBe("false false");
  });
});

describe("pipe fd access used for lsof attribution (fix round 2, minor 8)", () => {
  it.skipIf(process.platform !== "darwin")(
    "child stdout exposes a numeric fd on darwin",
    async () => {
      const { spawn } = await import("node:child_process");
      const c = spawn(NODE, ["-e", "setTimeout(() => {}, 200)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const fd = (c.stdout as unknown as { _handle?: { fd?: number } })._handle?.fd;
      await new Promise((r) => c.on("exit", r));
      expect(typeof fd).toBe("number");
      expect(fd).toBeGreaterThanOrEqual(0);
    },
  );
});
