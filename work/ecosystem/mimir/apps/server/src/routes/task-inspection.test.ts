import { GetTaskResponseSchema } from "@mimir/protocol";
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";
const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
it("serves an authenticated source-owned task detail for native IDE and MCP clients", async () => {
  const server = makeServer();
  servers.push(server);
  const repository = tempGitRepo();
  const post = async (url: string, payload: Record<string, unknown>) =>
    server.app.inject({
      method: "POST",
      url,
      headers: { ...AUTH, "idempotency-key": randomUUID() },
      payload,
    });
  try {
    const project = (
      await post("/v1/projects", { name: "Native inspector", repoPath: repository.repo })
    ).json().project;
    const mission = (
      await post("/v1/missions", {
        projectId: project.id,
        objective: "Inspect source evidence",
        tasks: [
          {
            title: "Read-only task",
            brief: "Native acceptance",
            acceptanceCriteria: ["Visible in inspector"],
          },
        ],
      })
    ).json();
    const task = mission.tasks[0];
    const url = `/v1/tasks/${task.id}`;
    expect((await server.app.inject({ method: "GET", url })).statusCode).toBe(401);
    const response = await server.app.inject({ method: "GET", url, headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(GetTaskResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json()).toMatchObject({
      task: { id: task.id, title: "Read-only task", acceptance: "Visible in inspector" },
      spec: { brief: "Native acceptance" },
      mission: { id: mission.mission.id },
      sessions: [],
      worktrees: [],
      artifacts: [],
      approvals: [],
      dependencies: [],
    });
  } finally {
    repository.cleanup();
  }
});
