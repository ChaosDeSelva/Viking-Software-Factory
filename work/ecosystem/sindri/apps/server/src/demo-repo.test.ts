import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TICKET, writeDemoRepo } from "./demo-repo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "sindri-demo-test-"));
  dirs.push(d);
  return d;
};
const npmTest = (cwd: string) =>
  spawnSync("npm", ["test", "--silent"], { cwd, encoding: "utf8", timeout: 60_000 });

describe("writeDemoRepo", () => {
  it("writes a committed full-stack sample (API, React page, tests) whose tests pass", () => {
    const r = writeDemoRepo(root());
    for (const f of ["package.json", "api/server.js", "api/reports.js", "web/ReportsPage.jsx"])
      expect(existsSync(join(r.repoPath, f))).toBe(true);
    expect(r.failingTest).toBeNull();
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: r.repoPath, encoding: "utf8" }),
    ).toBe("");
    expect(npmTest(r.repoPath).status).toBe(0);
    // The ticket fixture is written beside the repo, never inside it.
    expect(JSON.parse(readFileSync(r.ticketPath, "utf8"))).toEqual(DEMO_TICKET);
    expect(r.ticketPath.startsWith(r.repoPath)).toBe(false);
  }, 60_000);

  it("plants one failing test behind the flag; it fails once, then passes (simulated repair)", () => {
    const r = writeDemoRepo(root(), { failingTest: true });
    expect(r.failingTest).toBe("test/planted.test.js");
    const first = npmTest(r.repoPath);
    expect(first.status).not.toBe(0);
    expect(first.stdout + first.stderr).toContain("planted failure");
    expect(npmTest(r.repoPath).status).toBe(0);
  }, 60_000);
});
