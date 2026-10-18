import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y.js";
import { e2eInfo } from "./info.js";

/**
 * Full operator flow against a real server (scripts/dev-server.ts):
 * project → mission → crew → seed tasks → start → watch tasks complete → approve a blocked task
 * → inspector terminal → export JSON. axe runs on every screen.
 *
 * Enabled at integration with MIMIR_E2E=1 (needs T6, T7 and T12 on main).
 */
test.skip(
  process.env["MIMIR_E2E"] !== "1",
  "full flow enabled at integration: set MIMIR_E2E=1 once T6/T7/T12 land",
);

async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("operator flow end to end", async ({ page }) => {
  const env = e2eInfo();
  await page.goto("/");
  await page.getByLabel("Auth token").fill(env.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("connection")).toHaveText(/Live|Connecting/);
  await expectAccessible(page, "overview");

  // Project
  await nav(page, "Projects");
  await expectAccessible(page, "projects");
  await page.getByLabel("Name").fill("e2e");
  await page.getByLabel("Repository path").fill(env.repoPath);
  await page.getByLabel("Test command").fill("npm test");
  await page.getByLabel(/Protected branches/).fill("main");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("Created project e2e.")).toBeVisible();

  // Mission (a crew needs a missionId, so the mission comes first)
  await nav(page, "Missions");
  await expectAccessible(page, "missions");
  await page.getByLabel("Project").selectOption({ label: "e2e" });
  await page.getByLabel("Objective").fill("E2E mission");
  await page.getByRole("button", { name: "Create mission" }).click();
  await expect(page.getByRole("link", { name: "E2E mission" })).toBeVisible();
  const missionHref = await page.getByRole("link", { name: "E2E mission" }).getAttribute("href");
  const missionId = (missionHref ?? "").split("/").pop() ?? "";

  // Crew
  await nav(page, "Crews");
  await expectAccessible(page, "crews");
  await page.getByLabel("Mission").selectOption({ label: "E2E mission" });
  await page.getByRole("checkbox", { name: "implementer" }).check();
  await page.getByLabel("Agent kind for implementer").selectOption("shell");
  await page.getByLabel("Max concurrent tasks").fill("2");
  await page.getByRole("button", { name: "Create crew" }).click();
  await expect(page.getByText(/Created crew/)).toBeVisible();
  const crewHref = await page.getByRole("link", { name: "default" }).first().getAttribute("href");
  const crewId = (crewHref ?? "").split("/").pop() ?? null;

  // Tasks: A, B depends on A, C independent and destructive (needs approval).
  const seeded = await fetch(`${env.controlUrl}/seed-tasks`, {
    method: "POST",
    body: JSON.stringify({
      missionId,
      crewId,
      tasks: [
        { key: "A", title: "Task A", acceptance: "echo a" },
        { key: "B", title: "Task B", acceptance: "echo b", dependsOn: ["A"] },
        { key: "C", title: "Task C", acceptance: "rm -rf build" },
      ],
    }),
  });
  expect(seeded.ok).toBe(true);

  // Start and watch
  await page.goto(`/missions/${missionId}`);
  await expect(page.getByRole("img", { name: /dependency graph: 3 tasks/ })).toBeVisible();
  await expectAccessible(page, "mission detail");
  await page.getByRole("button", { name: "Start mission" }).click();
  await expect(page.getByText(/Start requested/)).toBeVisible();

  // Approve the blocked (destructive) task
  await nav(page, "Reviews");
  const approve = page.getByRole("button", { name: /^Approve apr_/ }).first();
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, "reviews");
  await approve.click();
  await expect(page.getByText(/Approved apr_.*operation op_/)).toBeVisible();

  // Tasks complete: progress is a count, never a percentage
  await page.goto(`/missions/${missionId}`);
  await expect(page.getByText("3 of 3 tasks completed")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("main")).not.toContainText(/\d+%/);

  // Inspector terminal
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByRole("link", { name: /^ses_/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /Agent/ })).toBeVisible();
  await expectAccessible(page, "agent inspector");
  await page.getByRole("button", { name: "Read terminal" }).click();
  await expect(page.getByTestId("terminal")).toBeVisible();

  // Activity export
  await nav(page, "Activity");
  await page.getByRole("button", { name: "Replay" }).click();
  await expect(page.getByText(/Replayed \d+ events/)).toBeVisible();
  await expectAccessible(page, "activity");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export JSON/ }).click();
  const file = await download;
  const body = JSON.parse(readFileSync((await file.path()) ?? "", "utf8")) as { type: string }[];
  expect(body.some((e) => e.type === "task.completed")).toBe(true);

  await nav(page, "Settings");
  await expectAccessible(page, "settings");
});
