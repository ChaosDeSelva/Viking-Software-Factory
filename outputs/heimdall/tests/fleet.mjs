import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startHeimdall } from "../apps/server/main.mjs";
import { startMimir } from "../../../work/ecosystem/mimir/apps/server/dist/start.js";
const root = mkdtempSync(join(tmpdir(), "fleet-ui-"));
const config = join(root, "fleet.json");
writeFileSync(
  config,
  JSON.stringify({
    version: 1,
    workers: [{ id: "local-mac", runtime: "cli", capacity: 2 }],
  }),
);
const mimir = await startMimir({
  MIMIR_RUNTIME: "fleet",
  MIMIR_FLEET_CONFIG: config,
  MIMIR_DATA_DIR: join(root, "mimir"),
  MIMIR_WORKTREE_ROOT: join(root, "worktrees"),
  MIMIR_PORT: "0",
  MIMIR_AUTH_TOKEN: "test-fleet-source-012345678901234567890",
  MIMIR_TICK_MS: "0",
  MIMIR_LOG_LEVEL: "silent",
});
const app = await startHeimdall({
  env: {
    HEIMDALL_PORT: "0",
    HEIMDALL_DATA_DIR: join(root, "heimdall"),
    HEIMDALL_TOKEN: "test-fleet-ui",
    MIMIR_URL: mimir.url,
    MIMIR_TOKEN: "test-fleet-source-012345678901234567890",
  },
  operatorCode: "test-operator",
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function confirm() {
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Local parity acceptance test");
  await page
    .getByRole("button", { name: "Send to source", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Send to source", exact: true })
    .waitFor({ state: "hidden" });
}
try {
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-fleet-ui");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { name: "Factory overview" }).waitFor();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Fleet & supervisors", exact: true })
    .click();
  await page.getByRole("heading", { name: "local-mac", exact: true }).waitFor();
  await expect(
    page.getByRole("button", { name: "Drain worker" }),
  ).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Connections", exact: true })
    .click();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByLabel("Heimdall operator code").fill("test-operator");
  await page
    .getByRole("button", { name: "Unlock controls", exact: true })
    .click();
  await page.getByText("Unlocked", { exact: true }).waitFor();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Fleet & supervisors", exact: true })
    .click();
  await page.getByRole("button", { name: "Drain worker" }).click();
  await confirm();
  await page.getByRole("button", { name: "Refresh observations" }).click();
  await page.getByRole("button", { name: "Resume new assignments" }).waitFor();
  await page.getByLabel("Supervisor ID", { exact: true }).fill("primary");
  await page
    .getByRole("button", { name: "Register supervisor", exact: true })
    .click();
  await confirm();
  await page.getByRole("button", { name: "Refresh observations" }).click();
  await page.getByRole("button", { name: /primary · primary/ }).click();
  await page.getByRole("heading", { name: "primary", exact: true }).waitFor();
  await page
    .getByLabel("Hold or reconciliation reason")
    .fill("Waiting for a deliberate human decision");
  await page
    .getByRole("button", { name: "Hold supervisor", exact: true })
    .click();
  await confirm();
  await page.getByRole("button", { name: "Refresh observations" }).click();
  await page
    .getByText("Waiting for a deliberate human decision", { exact: true })
    .first()
    .waitFor();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    assert.deepEqual(
      result.violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      [],
    );
  }
  const record = await fetch(mimir.url + "/v1/supervisors/primary", {headers:{authorization:"Bearer test-fleet-source-012345678901234567890"}}).then(r=>r.json());
  assert.equal(record.supervisor.reason,"Waiting for a deliberate human decision");
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: "../open-source-release/fleet-supervisors.png",
    fullPage: true,
  });
  console.log(
    "PASS real-source fleet inventory, read-only controls, drain, audited supervisor register/hold and three viewport/accessibility checks",
  );
} finally {
  await browser.close();
  await app.close();
  await mimir.close();
  rmSync(root, { recursive: true, force: true });
}
