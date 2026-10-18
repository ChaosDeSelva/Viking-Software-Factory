import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "heimdall-browser-"));
const source = await fixture();
const app = await startHeimdall({
  env: {
    HEIMDALL_PORT: "0",
    HEIMDALL_DATA_DIR: dir,
    HEIMDALL_TOKEN: "test-browser",
    MIMIR_URL: source.url,
    MIMIR_TOKEN: "fixture-token",
  },
  operatorCode: "operator-test",
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  console.log("Login");
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-browser");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { name: "Factory overview" }).waitFor();
  await page.getByLabel("Search records").fill("no-such-task-987654");
  await page
    .getByText("No matching records. Try a different search.")
    .first()
    .waitFor();
  await page.getByLabel("Search records").fill("");
  console.log("Task details");
  await page
    .getByRole("button", { name: /Implement integer-cent totals/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "Task objective" }).waitFor();
  assert.ok(
    await page
      .getByText("Reject negative quantities.", { exact: false })
      .count(),
  );
  await page.getByRole("button", { name: "Close inspector" }).click();
  console.log("Hulder task deep link");
  await page.goto(app.url + "?task=tsk_demo");
  await page.getByRole("heading", { name: "Task objective" }).waitFor();
  await page.getByRole("button", { name: "Close inspector" }).click();
  assert.equal(new URL(page.url()).searchParams.has("task"), false);
  console.log("Navigation");
  for (const title of [
    "Pipeline",
    "Crews & agents",
    "Execution graph",
    "Activity",
    "Quality & approvals",
    "New work",
    "Notifications",
    "Connections",
  ]) {
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: title, exact: true })
      .click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    assert.deepEqual(
      axe.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
    );
  }
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Execution graph", exact: true })
    .click();
  const graphNode = page.locator(".graph-node").first();
  await graphNode.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(app.store.preferences().graphs.msn_demo.tsk_demo.x, 50);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Execution graph", exact: true })
    .click();
  assert.equal(
    await page
      .locator(".graph-node")
      .first()
      .evaluate((e) => e.style.left),
    "50px",
  );
  await page.locator(".graph-node").first().dispatchEvent("click");
  await page.getByRole("heading", { name: "Task objective" }).waitFor();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark view read", exact: true })
    .click();
  await page.getByText("No notifications in this view.").waitFor();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Connections", exact: true })
    .click();
  console.log("Operator");
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByLabel("Heimdall operator code").fill("operator-test");
  await page
    .getByRole("button", { name: "Unlock controls", exact: true })
    .click();
  await page.getByText("Unlocked", { exact: true }).waitFor();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Crews & agents", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect mission & controls" })
    .click();
  await page.getByRole("button", { name: "pause mission" }).click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Review requirements before continuing");
  // Lose the browser response after the source confirms. Retrying the same
  // decision must replay its receipt, not execute a second source command.
  const commandKeys = [];
  let dropResponse = true;
  await page.route("**/api/commands", async (route) => {
    commandKeys.push(route.request().headers()["idempotency-key"]);
    if (dropResponse) {
      dropResponse = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Send to source" }).click();
  await page.getByRole("alert").filter({ hasText: /fetch/i }).waitFor();
  await page.getByRole("button", { name: "Send to source" }).click();

  await page
    .getByText("Source confirmed the request.", { exact: false })
    .first()
    .waitFor();
  assert.equal(source.data.missions[0].status, "paused");
  assert.equal(commandKeys.length, 2);
  assert.equal(commandKeys[0], commandKeys[1]);
  assert.equal(
    source.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/missions/msn_demo/pause",
    ).length,
    1,
  );
  await page.getByRole("button", { name: "Close inspector" }).click();
  source.emit();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await page.getByRole("button", { name: /task.output/ }).waitFor();
  await page.getByRole("button", { name: /task.output/ }).click();
  await page
    .getByText("Running regression tests", { exact: false })
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await page.getByRole("button", { name: "Dismiss message" }).click();
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/overview.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Dark theme" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.getByRole("button", { name: "Light theme" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: "test-results/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  for (const width of [390, 768, 1024, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const title of [
      "Overview",
      "Projects",
      "Pipeline",
      "Crews & agents",
      "Execution graph",
      "Activity",
      "Quality & approvals",
      "New work",
      "Notifications",
      "Connections",
    ]) {
      if (width <= 800) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: title, exact: true })
        .click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${title}: page overflow at ${width}px`,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: eight navigation destinations, graph keyboard movement and persisted layout, notifications, task details, operator unlock, confirmed pause, event drill-down, Escape focus, mobile and light theme.",
  );
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
