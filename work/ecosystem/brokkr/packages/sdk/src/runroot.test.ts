/**
 * Run-root acceptance (B3b fix round 3 ruling). Since B2fix the run store is
 * `<home>/.brokkr/runs/<sha256(realpath(workspace))>/run_<ulid>` (HMAC-signed),
 * and checks are not told where it is. A check running as the same user can
 * still compute it, so these tests let a check swap its own run directory, or
 * the home `.brokkr`, for a symlink: Brokkr must never write evidence outside
 * and never pass. Verify must also never write inside the workspace.
 * Every test uses a temp home.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runsRootFor } from "@brokkr/evidence";
import { describe, expect, it } from "vitest";
import { Brokkr, type VerificationReport } from "./index.js";
import { BUILTIN, tempDir } from "../test/fixtures.js";

function scriptRepo(check: string): string {
  const dir = tempDir("brokkr-runroot-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "r", private: true, scripts: { test: "node check.mjs" } }),
  );
  writeFileSync(join(dir, "check.mjs"), check);
  return dir;
}

async function verify(
  workspace: string,
  homeDir: string,
): Promise<VerificationReport | { error: unknown }> {
  const brokkr = new Brokkr({ cwd: workspace, builtinDir: BUILTIN, homeDir });
  const selection = await brokkr.resolve({
    task: { id: "QA-1", title: "qa", description: "qa", taskTypes: ["qa"] },
  });
  try {
    return await brokkr.verify({ selection, workspace });
  } catch (error) {
    return { error };
  }
}

const filesUnder = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }) : [];

/** A check that finds its own (only) run directory in the store and swaps it, or an ancestor. */
function swapper(target: "run" | "dotBrokkr", root: string, outside: string): string {
  return `import { readdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const runs = readdirSync(root).filter((n) => n.startsWith("run_"));
if (runs.length !== 1) { console.error("expected one run, got", runs); process.exit(7); }
const target = ${target === "run" ? "join(root, runs[0])" : 'join(root, "..", "..")'};
renameSync(target, target + ".moved");
symlinkSync(${JSON.stringify(outside)}, target);
console.log("swapped", target);
`;
}

describe("run-root acceptance (temp home)", { timeout: 60_000 }, () => {
  it("runs are stored under the Brokkr home, signed, never in the workspace", async () => {
    const home = tempDir("brokkr-home-");
    const ws = scriptRepo("console.log('ok');\n");
    const before = filesUnder(ws).sort();
    const result = await verify(ws, home);
    expect("error" in result ? result.error : result.verdict).toBe("passed");
    const runDir = join(runsRootFor(ws, home), (result as VerificationReport).id);
    expect(readdirSync(runDir).sort()).toEqual(
      expect.arrayContaining(["evidence-manifest.json", "report.json", "report.md"]),
    );
    expect(filesUnder(ws).sort()).toEqual(before);
  });

  it("a workspace .brokkr/runs symlink is irrelevant: nothing is written inside the workspace", async () => {
    const outside = tempDir("brokkr-outside-ws-runs-");
    const ws = scriptRepo("console.log('ok');\n");
    mkdirSync(join(ws, ".brokkr"));
    symlinkSync(outside, join(ws, ".brokkr", "runs"));
    const before = filesUnder(ws).sort();
    const result = await verify(ws, tempDir("brokkr-home-"));
    expect("error" in result ? result.error : result.verdict).toBe("passed");
    expect(filesUnder(outside)).toEqual([]);
    expect(filesUnder(ws).sort()).toEqual(before);
  });

  it("a check that replaces its run directory with a symlink: infra error, nothing lands outside", async () => {
    const home = tempDir("brokkr-home-");
    const outside = tempDir("brokkr-outside-run-");
    const ws = scriptRepo("");
    writeFileSync(join(ws, "check.mjs"), swapper("run", runsRootFor(ws, home), outside));
    const result = await verify(ws, home);
    expect(filesUnder(outside)).toEqual([]);
    expect("error" in result && result.error).toMatchObject({
      code: "infra",
      message: expect.stringMatching(/replaced or moved/),
    });
  });

  it("refuses a swapped run before scrubbing existing outside artifacts", async () => {
    const home = tempDir("brokkr-home-");
    const outside = tempDir("brokkr-outside-existing-");
    mkdirSync(join(outside, "test-results"));
    const file = join(outside, "test-results", "private.txt");
    const content = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n";
    writeFileSync(file, content);
    const ws = scriptRepo("");
    writeFileSync(join(ws, "check.mjs"), swapper("run", runsRootFor(ws, home), outside));
    const result = await verify(ws, home);
    expect("error" in result && result.error).toMatchObject({ code: "infra" });
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("a check that replaces the home .brokkr with a symlink: infra error, nothing lands outside", async () => {
    const home = tempDir("brokkr-home-");
    const outside = tempDir("brokkr-outside-dotbrokkr-");
    const ws = scriptRepo("");
    writeFileSync(join(ws, "check.mjs"), swapper("dotBrokkr", runsRootFor(ws, home), outside));
    const result = await verify(ws, home);
    expect(filesUnder(outside)).toEqual([]);
    expect("error" in result && result.error).toMatchObject({
      code: "infra",
      message: expect.stringMatching(/replaced or moved/),
    });
  });
});
