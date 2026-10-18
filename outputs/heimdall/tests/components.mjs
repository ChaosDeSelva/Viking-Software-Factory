import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";

const dir = mkdtempSync(join(tmpdir(), "heimdall-components-"));
const source = await fixture();
const app = await startHeimdall({ env: {
  HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: "test-components",
  MIMIR_URL: source.url, MIMIR_TOKEN: "fixture-token",
}, operatorCode: "test-operator" });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.setDefaultTimeout(10000);
try {
  await page.goto(app.url + "/?view=components");
  const harness = page.getByRole("combobox", { name: "Agent harness" });
  await harness.click();
  await page.getByRole("option", { name: "Claude Code", exact: true }).click();
  assert.match(await harness.innerText(), /Claude Code/);
  await harness.focus();
  await page.keyboard.press("Space");
  assert.equal(await page.getByRole("option", { name: "Unavailable harness" }).getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  const opener = page.getByRole("button", { name: "Open dialog", exact: true });
  await opener.click();
  await page.getByRole("dialog").waitFor();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    assert.ok(await page.getByRole("dialog").evaluate(el => el.contains(document.activeElement)));
  }
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `catalog overflow at ${width}`);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
  }
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-components");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { name: "Factory overview" }).waitFor();
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search navigation and records").fill("Implement integer-cent totals");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Task objective" }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log("PASS: custom selectors, disabled options, dialog focus, catalog accessibility/overflow, task command palette");
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
