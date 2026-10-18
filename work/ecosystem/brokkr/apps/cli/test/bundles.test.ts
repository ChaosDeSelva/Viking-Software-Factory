/**
 * B3b fix round 3, I-b: `brokkr verify` reads generated bundles with the same
 * after-the-checks, O_NOFOLLOW/fstat/nlink/bounded reader as the SDK.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tmp } from "./helpers.js";

const BIN = resolve(import.meta.dirname, "../dist/bin.js");
const AWS = "AKIAIOSFODNN7EXAMPLE";

function brokkr(cwd: string, home: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args, "--cwd", cwd], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      BROKKR_HOME: home,
      BROKKR_LOG_LEVEL: "silent",
    },
    timeout: 60_000,
  });
}

/** A repo whose required `test` check runs `check.mjs` (which manipulates bundles). */
function repo(check: string): { dir: string; home: string } {
  const dir = tmp("brokkr-cli-bundles-");
  const home = tmp("brokkr-cli-bundles-home-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "r", private: true, scripts: { test: "node check.mjs" } }),
  );
  writeFileSync(join(dir, "check.mjs"), check);
  mkdirSync(join(dir, ".brokkr", "generated"), { recursive: true });
  writeFileSync(join(dir, ".brokkr", "generated", "a.md"), "benign\n");
  writeFileSync(
    join(dir, ".brokkr", "config.yaml"),
    "version: 1\nharnesses:\n  - { name: qa-regression, version: ^1.0.0 }\n",
  );
  expect(brokkr(dir, home, "harness", "lock").status).toBe(0);
  return { dir, home };
}

function verify(check: string) {
  const { dir, home } = repo(check);
  const started = Date.now();
  const r = brokkr(dir, home, "verify", "--json");
  const report = JSON.parse(r.stdout) as { verdict: string; warnings: string[] };
  return { report, ms: Date.now() - started, stderr: r.stderr };
}

describe("brokkr verify bundle scan (fix round 3, I-b)", { timeout: 90_000 }, () => {
  it("a check swapping a bundle for a symlink to a host secret: not read, reported", () => {
    const outside = join(tmp("brokkr-host-"), "host-secret.env");
    writeFileSync(outside, `AWS_ACCESS_KEY_ID=${AWS}\n`);
    const { report } = verify(
      `import { rmSync, symlinkSync } from "node:fs";
rmSync(".brokkr/generated/a.md");
symlinkSync(${JSON.stringify(outside)}, ".brokkr/generated/a.md");
`,
    );
    expect(report.verdict).toBe("passed");
    expect(report.warnings.join("\n")).toMatch(/a\.md: it is a symlink/);
  });

  it("a FIFO and a /dev/zero link do not hang verify", () => {
    const { report, ms } = verify(
      `import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
execFileSync("mkfifo", [".brokkr/generated/pipe"]);
symlinkSync("/dev/zero", ".brokkr/generated/zero.md");
`,
    );
    expect(ms).toBeLessThan(60_000);
    expect(report.verdict).toBe("passed");
    expect(report.warnings.join("\n")).toMatch(/pipe: it is not a regular file/);
    expect(report.warnings.join("\n")).toMatch(/zero\.md: it is a symlink/);
  });

  it("a bundle of 8 MiB + 1 byte is refused, not read", () => {
    const { report } = verify(
      `import { writeFileSync } from "node:fs";
writeFileSync(".brokkr/generated/big.md", Buffer.alloc(8 * 1024 * 1024 + 1, 65));
`,
    );
    expect(report.verdict).toBe("passed");
    expect(report.warnings.join("\n")).toMatch(/big\.md: larger than 8388608 bytes/);
  });

  it("a real secret written into a bundle still blocks", () => {
    const { report } = verify(
      `import { writeFileSync } from "node:fs";
writeFileSync(".brokkr/generated/a.md", "key ${AWS}\\n");
`,
    );
    expect(report.verdict).toBe("blocked");
  });
});
