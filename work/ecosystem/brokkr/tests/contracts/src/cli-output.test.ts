/**
 * Review I4: the published schemas are enforced against real CLI output, not
 * only SDK output. Spawns the built `brokkr` bin with --json.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Stored runs live outside the workspace: `<home>/.brokkr/runs/<sha256(realpath(repo))>/`. */
function runsRoot(repo: string, home: string): string {
  return join(
    home,
    ".brokkr",
    "runs",
    createHash("sha256").update(realpathSync(repo)).digest("hex"),
  );
}
const BIN = join(dirname(require.resolve("@brokkr/cli")), "bin.js");
const SCHEMAS = join(dirname(require.resolve("@brokkr/sdk/package.json")), "schemas");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateReport = ajv.compile(
  JSON.parse(readFileSync(join(SCHEMAS, "verification-report.v1.json"), "utf8")) as object,
);
const errors = (value: unknown): string[] =>
  validateReport(value)
    ? []
    : (validateReport.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);

function brokkr(cwd: string, home: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args, "--cwd", cwd], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      BROKKR_HOME: home,
      BROKKR_LOG_LEVEL: "silent",
    },
  });
}

// Spawns the real CLI (lock, verify, report) three times per case: load-sensitive.
describe("CLI --json output matches the published report schema", { timeout: 120_000 }, () => {
  it.each([
    ["passed", "console.log('ok');\n", 0],
    ["failed", "process.exit(1);\n", 1],
  ])("verify (%s), the stored report.json and report --latest", (verdict, check, exit) => {
    const repo = mkdtempSync(join(tmpdir(), "brokkr-cli-contract-"));
    const home = mkdtempSync(join(tmpdir(), "brokkr-cli-contract-home-"));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "r", private: true, scripts: { test: "node check.mjs" } }),
    );
    writeFileSync(join(repo, "check.mjs"), check);
    mkdirSync(join(repo, ".brokkr"));
    writeFileSync(
      join(repo, ".brokkr", "config.yaml"),
      "version: 1\nharnesses:\n  - { name: qa-regression, version: ^1.0.0 }\n",
    );
    expect(brokkr(repo, home, "harness", "lock").status).toBe(0);

    const run = brokkr(repo, home, "verify", "--json");
    expect(run.status, run.stderr).toBe(exit);
    const report = JSON.parse(run.stdout) as { id: string; verdict: string };
    expect(report.verdict).toBe(verdict);
    expect(errors(report)).toEqual([]);

    const stored = JSON.parse(
      readFileSync(join(runsRoot(repo, home), report.id, "report.json"), "utf8"),
    ) as unknown;
    expect(errors(stored)).toEqual([]);

    const latest = brokkr(repo, home, "report", "--latest", "--format", "json");
    expect(latest.status, latest.stderr).toBe(0);
    expect(errors(JSON.parse(latest.stdout))).toEqual([]);
  });
});
