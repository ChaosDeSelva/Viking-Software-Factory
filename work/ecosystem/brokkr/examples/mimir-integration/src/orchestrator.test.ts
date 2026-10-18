import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerificationReportSchema } from "@brokkr/sdk";
import { WorktreeExecutor, planMission, verifyMission } from "./orchestrator.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

/** A repository with one commit and a worktree for the "agent". */
function repoWithWorktree(check: string): { repo: string; worktree: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mimir-example-")));
  const repo = join(base, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "app", private: true, scripts: { test: "node check.mjs" } }),
  );
  writeFileSync(join(repo, "check.mjs"), "console.log('ok');\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  const worktree = join(base, "wt-mission-7");
  git(repo, "worktree", "add", "-q", "-b", "mission-7", worktree);
  writeFileSync(join(worktree, "check.mjs"), check); // the agent's change
  return { repo, worktree };
}

/** Isolated ~ for Brokkr: tests never read the developer's real ~/.brokkr (review M3). */
const homeDir = mkdtempSync(join(tmpdir(), "mimir-example-home-"));

const task = {
  id: "QA-7",
  title: "Regression pass",
  description: "Independent regression run",
  taskTypes: ["qa"],
};

describe("Mimir-style orchestrator using @brokkr/sdk", () => {
  it("verifies the exact worktree through its executor and records ordered events", async () => {
    const { repo, worktree } = repoWithWorktree("console.log('84 passed');\n");
    const selection = await planMission(repo, task, homeDir);
    const outcome = await verifyMission({
      repo,
      worktree,
      missionId: "mission-7",
      selection,
      pinnedLock: selection.lock,
      homeDir,
    });
    expect(outcome.state).toBe("verified");
    expect(VerificationReportSchema.safeParse(outcome.report).success).toBe(true);
    expect(outcome.report.executionId).toBe("mission-7/verify-1");
    expect(outcome.report.repository.workspaceId).toBe("wt-mission-7");
    expect(outcome.report.repository.dirtyTreeDigest).toMatch(/^sha256:/); // uncommitted agent change
    expect(outcome.executed).toEqual([{ checkId: "test", workspace: worktree }]);
    expect(outcome.log.map((e) => e.type)).toEqual([
      "verification.started",
      "verification.check.started",
      "verification.check.completed",
      "verification.check.completed",
      "verification.check.completed",
      "verification.check.completed",
      "verification.completed",
    ]);
    expect(outcome.log.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a failed verdict becomes a repair decision owned by the orchestrator", async () => {
    const { repo, worktree } = repoWithWorktree("process.exit(1);\n");
    const selection = await planMission(repo, task, homeDir);
    const outcome = await verifyMission({
      repo,
      worktree,
      missionId: "mission-8",
      selection,
      pinnedLock: selection.lock,
      homeDir,
    });
    expect(outcome.report.verdict).toBe("failed");
    expect(outcome.state).toBe("needs_repair");
    expect(outcome.diagnosis).toEqual([expect.stringContaining("test")]);
  });

  it("a worktree cannot redefine its own contract (no-op harness, config, self-approved waivers)", async () => {
    const { repo, worktree } = repoWithWorktree("process.exit(1);\n");
    const selection = await planMission(repo, task, homeDir);
    for (const root of [repo, worktree]) {
      mkdirSync(join(root, ".brokkr", "harnesses", "noop"), { recursive: true });
      writeFileSync(
        join(root, ".brokkr", "config.yaml"),
        "version: 1\nharnesses: [{ name: noop, version: ^1.0.0 }]\npolicies: { waivable: [check:test] }\n",
      );
      writeFileSync(
        join(root, ".brokkr", "exceptions.yaml"),
        "exceptions:\n  - { id: x, policy: check:test, scope: {}, reason: r, approvedBy: me, approvedAt: 2026-01-01T00:00:00Z, expiresAt: 2099-01-01T00:00:00Z, evidence: [] }\n",
      );
    }
    const outcome = await verifyMission({
      repo,
      worktree,
      missionId: "mission-9",
      selection,
      pinnedLock: selection.lock,
      homeDir,
    });
    expect(outcome.report.verdict).toBe("failed");
    expect(outcome.report.exceptions).toEqual([]);
  });

  it("a selection other than the planned one is blocked (review I1)", async () => {
    const { repo, worktree } = repoWithWorktree("console.log(1);\n");
    const planned = await planMission(repo, task, homeDir);
    // The lock recorded at mission acceptance lives in the orchestrator's own store.
    const store = { "mission-10": planned.lock };
    const swapped = await planMission(repo, { ...task, taskTypes: ["docs"] }, homeDir);
    for (const selection of [swapped, { ...swapped, lock: planned.lock }]) {
      const outcome = await verifyMission({
        repo,
        worktree,
        missionId: "mission-10",
        selection, // replaced wholesale, its own lock included
        pinnedLock: store["mission-10"],
        homeDir,
      });
      expect(outcome.report.verdict).toBe("blocked");
      expect(outcome.report.reasons.join("\n")).toMatch(/lock_integrity/);
      expect(outcome.executed).toEqual([]);
    }
  });

  it("the executor refuses to run anything outside its worktree", async () => {
    const { worktree } = repoWithWorktree("console.log(1);\n");
    const executor = new WorktreeExecutor(worktree);
    const result = await executor.execute({
      checkId: "x",
      command: ["node", "-e", "1"],
      workspace: tmpdir(),
      env: {},
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ state: "errored", reason: "cwd_rejected" });
  });
});
