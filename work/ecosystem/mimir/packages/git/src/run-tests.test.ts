import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
