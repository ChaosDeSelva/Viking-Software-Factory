import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OUTPUT_CAP_BYTES, runTests } from "./run-tests.js";

const node = process.execPath;

describe("runTests", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mimir-git-run-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.MIMIR_TEST_SECRET;
  });

  it("runs the command in the worktree and reports exit code and output", async () => {
    const r = await runTests(dir, [
      node,
      "-e",
      "process.stdout.write(process.cwd()); process.stderr.write('err'); process.exit(3)",
    ]);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("mimir-git-run-");
    expect(r.stderr).toBe("err");
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("scrubs the environment to the allowlist plus explicit extras", async () => {
    process.env.MIMIR_TEST_SECRET = "hunter2";
    const r = await runTests(
      dir,
      [node, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: { EXTRA_OK: "1" } },
    );
    const env = JSON.parse(r.stdout) as Record<string, string>;
    expect(env.MIMIR_TEST_SECRET).toBeUndefined();
    expect(r.stdout).not.toContain("hunter2");
    expect(env.EXTRA_OK).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
    const allowed = new Set(["PATH", "HOME", "LANG", "TERM", "EXTRA_OK"]);
    // macOS may inject __CF_USER_TEXT_ENCODING into child processes.
    const unexpected = Object.keys(env).filter((k) => !allowed.has(k) && !k.startsWith("__CF"));
    expect(unexpected).toEqual([]);
  });

  it("kills the command's process group when the signal aborts", async () => {
    const ac = new AbortController();
    const started = Date.now();
    // A shell that starts a grandchild: both must die with the group.
    const pending = runTests(dir, ["sh", "-c", "sleep 30 & echo $! && wait"], {
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 300);
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe("SIGKILL");
    expect(r.timedOut).toBe(false);
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(() => process.kill(grandchild, 0)).toThrow();

    const already = new AbortController();
    already.abort();
    const killed = await runTests(dir, ["sleep", "30"], { signal: already.signal });
    expect(killed.signal).toBe("SIGKILL");
  });

  it("caps each output stream at 1 MiB", async () => {
    const r = await runTests(dir, [
      node,
      "-e",
      "const b = Buffer.alloc(1024 * 1024, 97); process.stdout.write(b); process.stdout.write(b);",
    ]);
    expect(OUTPUT_CAP_BYTES).toBe(1024 * 1024);
    expect(Buffer.byteLength(r.stdout)).toBe(OUTPUT_CAP_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("kills the process on timeout", async () => {
    const r = await runTests(dir, [node, "-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(10000);
  });

  it("reports 127 when the executable does not exist", async () => {
    const r = await runTests(dir, ["definitely-not-a-real-binary-mimir"]);
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/ENOENT|not found/);
  });

  it("does not interpret shell syntax", async () => {
    const r = await runTests(dir, [
      node,
      "-e",
      "process.stdout.write(process.argv[1])",
      "$(id); `x`",
    ]);
    expect(r.stdout).toBe("$(id); `x`");
  });

  it("rejects empty commands and unsafe paths", async () => {
    await expect(runTests(dir, [])).rejects.toMatchObject({ code: "validation_failed" });
    await expect(runTests(`${dir}/../x`, [node])).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(runTests("relative", [node])).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("runTests with a descendant that left the process group", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mimir-git-run-escape-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Starts a detached grandchild that keeps the output pipes open for 45s and records its pid.
  const escape = (pidFile: string, thenWait: boolean) => [
    node,
    "-e",
    `const g = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 45000)"],
       { detached: true, stdio: ["ignore", "inherit", "inherit"] });
     g.unref();
     require("fs").writeFileSync(process.argv[1] + ".tmp", String(g.pid));
     require("fs").renameSync(process.argv[1] + ".tmp", process.argv[1]);
     ${thenWait ? "setTimeout(() => {}, 60000);" : ""}`,
    pidFile,
  ];
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidFrom = async (pidFile: string) =>
    await vi.waitFor(async () => Number(await readFile(pidFile, "utf8")), {
      timeout: 60_000,
      interval: 50,
    });

  it("returns after an abort without waiting for the descendant to exit", async () => {
    const pidFile = join(dir, "abort.pid");
    const ac = new AbortController();
    const pending = runTests(dir, escape(pidFile, true), { signal: ac.signal });
    const grandchild = await pidFrom(pidFile);
    try {
      ac.abort();
      const r = await pending;
      expect(r).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false });
      // Still running: the result did not wait for the pipes it holds.
      expect(isAlive(grandchild)).toBe(true);
    } finally {
      if (isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  }, 120_000);

  it("returns after a timeout even when the command itself already exited", async () => {
    const pidFile = join(dir, "timeout.pid");
    const pending = runTests(dir, escape(pidFile, false), { timeoutMs: 3000 });
    const grandchild = await pidFrom(pidFile);
    try {
      const r = await pending;
      expect(r).toMatchObject({ exitCode: 0, signal: null, timedOut: true });
      expect(isAlive(grandchild)).toBe(true);
    } finally {
      if (isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  }, 120_000);
});

describe("runTests edge cases", () => {
  it("fails with not_found when the worktree path is missing or not a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mimir-git-run-missing-"));
    try {
      await expect(runTests(join(dir, "gone"), [node])).rejects.toMatchObject({
        code: "not_found",
        details: { path: join(dir, "gone") },
      });
      await writeFile(join(dir, "file"), "");
      await expect(runTests(join(dir, "file"), [node])).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports 127 for an unspawnable command even when the signal was already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runTests(tmpdir(), ["definitely-not-a-real-binary-mimir"], {
      signal: ac.signal,
    });
    expect(r).toMatchObject({ exitCode: 127, signal: null, timedOut: false, truncated: false });
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it("keeps stderr separate, capped and flagged like stdout", async () => {
    const r = await runTests(tmpdir(), [
      node,
      "-e",
      "process.stdout.write('out'); process.stderr.write(Buffer.alloc(1024 * 1024 + 10, 98))",
    ]);
    expect(r.stdout).toBe("out");
    expect(Buffer.byteLength(r.stderr)).toBe(OUTPUT_CAP_BYTES);
    expect(r.truncated).toBe(true);
  });

  it("does not drop bytes at the cap when the output is not UTF-8 at all", async () => {
    const r = await runTests(tmpdir(), [
      node,
      "-e",
      "process.stdout.write(Buffer.alloc(1024 * 1024 + 10, 0x80))",
    ]);
    expect(r.truncated).toBe(true);
    // Each stray continuation byte decodes to one replacement character.
    expect(r.stdout).toBe("\uFFFD".repeat(OUTPUT_CAP_BYTES));
  });

  it("cuts a truncated stream before an incomplete 2- or 4-byte character and keeps a complete one", async () => {
    for (const [pad, char, bytes] of [
      [1, "\u00e9", 2],
      [1, "\u{1F600}", 4],
      [0, "\u00e9", 2],
    ] as const) {
      const r = await runTests(tmpdir(), [
        node,
        "-e",
        `process.stdout.write("a".repeat(${pad}) + ${JSON.stringify(char)}.repeat(${OUTPUT_CAP_BYTES}))`,
      ]);
      expect(r.truncated).toBe(true);
      expect(r.stdout).not.toContain("\uFFFD");
      const whole = Math.floor((OUTPUT_CAP_BYTES - pad) / bytes);
      expect(r.stdout).toBe("a".repeat(pad) + char.repeat(whole));
    }
  });

  it("reports the signal of a command that killed itself, without a timeout", async () => {
    const r = await runTests(tmpdir(), [node, "-e", "process.kill(process.pid, 'SIGTERM')"]);
    expect(r).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: false });
  });
});

describe("runTests hardening (M4)", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects timeoutMs %s",
    async (timeoutMs) => {
      await expect(runTests(tmpdir(), [node, "-e", ""], { timeoutMs })).rejects.toMatchObject({
        code: "validation_failed",
      });
    },
  );

  it("does not split a multibyte character at the output cap", async () => {
    // 1 byte of padding then 3-byte characters: the cap falls inside a character.
    const r = await runTests(tmpdir(), [
      node,
      "-e",
      "process.stdout.write('a' + '\\u20ac'.repeat(400000))",
    ]);
    expect(r.truncated).toBe(true);
    expect(r.stdout).not.toContain("�");
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(OUTPUT_CAP_BYTES - 4);
  });
});
