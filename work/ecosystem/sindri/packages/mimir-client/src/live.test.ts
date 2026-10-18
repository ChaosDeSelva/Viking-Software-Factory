/**
 * Opt-in contract test against a real, running Mimir.
 *
 *   MIMIR_LIVE=1 MIMIR_URL=http://127.0.0.1:7700 MIMIR_TOKEN=$(cat ~/.mimir/auth-token) \
 *     pnpm --filter @sindri/mimir-client exec vitest run src/live.test.ts
 *
 * Start Mimir with its FakeRuntime first (`cd ../mimir && pnpm dev`). It creates a two-task
 * `shell` mission from an approved plan and follows it to `mission.completed`.
 */
import { execFileSync } from "node:child_process";
import { openDatabase } from "@sindri/knowledge";
import { createTempRepo } from "@sindri/testing";
import { describe, expect, it } from "vitest";
import { MimirClientFacade } from "./facade.js";
import { approvedPlan, planTask } from "./testing.js";

const LIVE = process.env.MIMIR_LIVE === "1";
const MIMIR_URL = process.env.MIMIR_URL ?? "http://127.0.0.1:7700";
const TOKEN = process.env.MIMIR_TOKEN ?? "";
const title = LIVE
  ? `live Mimir at ${MIMIR_URL}`
  : "live Mimir (skipped: set MIMIR_LIVE=1, MIMIR_URL and MIMIR_TOKEN to run against a real server)";

describe.skipIf(!LIVE)(title, () => {
  it("runs a two-task shell mission from a plan to completion", { timeout: 120_000 }, async () => {
    const repo = createTempRepo({ "README.md": "live\n" }, { git: true });
    execFileSync("git", ["add", "-A"], { cwd: repo.path });
    execFileSync(
      "git",
      ["-c", "user.name=sindri", "-c", "user.email=sindri@localhost", "commit", "-qm", "init"],
      { cwd: repo.path },
    );
    const facade = new MimirClientFacade({
      db: openDatabase(":memory:"),
      agentKindFor: () => "shell",
    });
    facade.connect({ baseUrl: MIMIR_URL, token: TOKEN });
    try {
      const caps = await facade.capabilities();
      console.log("capabilities", JSON.stringify(caps));
      const project = await facade.ensureProject(repo.path);
      const plan = approvedPlan(
        [
          planTask("first", { objective: "echo first > first.txt" }),
          planTask("second", { objective: "echo second > second.txt", dependsOn: ["first"] }),
        ],
        { id: `live-${Date.now()}` },
      );
      const { missionId, taskIdMap } = await facade.createMissionFromPlan(plan, {
        projectId: project.id,
      });
      console.log("mission", missionId, JSON.stringify(taskIdMap));
      await facade.start(missionId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 110_000);
      const types: string[] = [];
      for await (const e of facade.follow(missionId, { signal: ac.signal })) {
        types.push(e.type);
        console.log(e.type, e.taskId ?? "");
        if (e.type === "mission.completed" || e.type === "mission.cancelled") break;
      }
      clearTimeout(timer);
      ac.abort();
      expect(types.at(-1)).toBe("mission.completed");
      expect(types.filter((t) => t === "task.completed")).toHaveLength(2);
    } finally {
      repo.cleanup();
    }
  });
});
