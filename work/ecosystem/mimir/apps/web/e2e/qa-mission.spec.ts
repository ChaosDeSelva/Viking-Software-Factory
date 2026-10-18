import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y.js";
import { e2eInfo, type E2eInfo } from "./info.js";

/**
 * QA smoke (scripts/qa-smoke.mjs, `pnpm qa:smoke`): axe on the mission page while a 3-task
 * mission runs and after it completes, in light and dark mode. The mission is set up over the
 * HTTP API against the Playwright harness server (scripts/dev-server.ts, FakeRuntime).
 * Skipped unless MIMIR_QA_SMOKE=1.
 */
test.skip(process.env["MIMIR_QA_SMOKE"] !== "1", "run through pnpm qa:smoke (MIMIR_QA_SMOKE=1)");

async function api<T>(env: E2eInfo, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.token}`,
      ...(method === "GET"
        ? {}
        : { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function approveAll(env: E2eInfo, missionId: string): Promise<number> {
  const { approvals } = await api<{ approvals: { id: string }[] }>(
    env,
    "GET",
    `/v1/approvals?status=pending&missionId=${missionId}`,
  );
  for (const a of approvals) {
    await api(env, "POST", `/v1/approvals/${a.id}/decision`, { decision: "approved" });
  }
  return approvals.length;
}

async function connect(page: Page, env: E2eInfo): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Auth token").fill(env.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

test("mission page is accessible while running and when complete", async ({ page }) => {
  // The FakeRuntime mission takes about a minute on a busy machine; leave headroom.
  test.setTimeout(240_000);
  const env = e2eInfo();
  const { project } = await api<{ project: { id: string } }>(env, "POST", "/v1/projects", {
    name: "qa-axe",
    repoPath: env.repoPath,
  });
  const { mission } = await api<{ mission: { id: string } }>(env, "POST", "/v1/missions", {
    projectId: project.id,
    objective: "QA axe mission",
  });
  await api(env, "POST", "/v1/crews", {
    missionId: mission.id,
    template: "solo",
    limits: { maxConcurrentTasks: 2 },
    members: [{ role: "implementer", agentKind: "shell" }],
  });
  const task = async (title: string, brief: string, dependsOn: string[] = []) =>
    (
      await api<{ task: { id: string } }>(env, "POST", "/v1/tasks", {
        missionId: mission.id,
        title,
        brief,
        dependsOn,
      })
    ).task.id;
  const a = await task("Task A", "echo A");
  await task("Task B", "echo B", [a]);
  // Quoted, so not plain allowlisted words: this dispatch needs an approval.
  await task("Task C", 'echo "C"');
  await api(env, "POST", `/v1/missions/${mission.id}/start`, {});

  await connect(page, env);
  await page.goto(`/missions/${mission.id}`);
  await expect(page.getByRole("img", { name: /dependency graph: 3 tasks/ })).toBeVisible();
  await expectAccessible(page, "mission page (running, light)");

  let approved = 0;
  const state = async () => {
    const m = await api<{
      mission: { status: string };
      tasks: { title: string; status: string; blockedReason?: string }[];
    }>(env, "GET", `/v1/missions/${mission.id}`);
    const tasks = m.tasks.map(
      (t) => `${t.title}=${t.status}${t.blockedReason ? `(${t.blockedReason})` : ""}`,
    );
    return `${m.mission.status}: ${tasks.join(", ")}`;
  };
  await expect
    .poll(
      async () => {
        approved += await approveAll(env, mission.id);
        return state();
      },
      { timeout: 120_000, intervals: [300] },
    )
    .toMatch(/^completed:/);
  expect(approved).toBeGreaterThan(0);

  await expect(page.getByText("3 of 3 tasks completed")).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, "mission page (completed, light)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "mission page (completed, dark)");
});
