import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y.js";
import { e2eInfo } from "./info.js";

/**
 * Real SDK + real server (scripts/dev-server.ts) through the Vite dev proxy. Runs in the gate now
 * that T6 and T7 are on main; the orchestration flow (T12) stays in flow.spec.ts.
 */
test("connects through the dev proxy, goes Live, and creates a project", async ({ page }) => {
  const env = e2eInfo();
  await page.goto("/");
  await page.getByLabel("Auth token").fill(env.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  // Honest indicator: "Connecting…" until the SDK reports open or an event arrives; never "Live" early.
  await expect(page.getByTestId("connection")).toHaveText(/Connecting|Live/);
  await expect(page.getByRole("region", { name: "Fleet health" })).toContainText("fake");
  await expectAccessible(page, "overview (live server)");

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByLabel("Name").fill("live-e2e");
  await page.getByLabel("Repository path").fill(env.liveRepoPath);
  await page.getByLabel("Test command").fill("npm test");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("Created project live-e2e.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "live-e2e" })).toBeVisible();
  // The SDK reports `open` once the SSE connection is up, even with no events yet.
  await expect(page.getByTestId("connection")).toHaveText(/Live/, { timeout: 15_000 });
  expect(page.url()).not.toContain(env.token);
});

test("a wrong token returns to the prompt", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Auth token").fill("definitely-not-the-token-definitely-not");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toContainText(/rejected/i);
});
