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
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-components");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { name: "Factory overview" }).waitFor();
  const findings = [];
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1440, height: 1050 });
    if (theme === "dark") await page.getByRole("button", { name: /Dark theme/ }).click();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1050 });
      for (const title of ["Overview", "Projects", "Pipeline", "Crews & agents", "Execution graph", "Activity", "Quality & approvals", "New work", "Notifications", "Connections", "Fleet & supervisors"]) {
        if (width <= 800) await page.getByRole("button", { name: "Menu", exact: true }).click();
        await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: title, exact: true }).click();
        const sections = title === "Connections" ? ["Services", "Access", "Display", "Audit history"] : [null];
        for (const section of sections) {
          if (section) await page.getByRole("button", { name: section, exact: true }).click();
          const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
          for (const violation of result.violations) findings.push({ theme, width, title, section, rule: violation.id, targets: violation.nodes.map(n => n.target) });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${title} overflow at ${width}`);
        }
      }
    }
  }
  assert.deepEqual(findings, []);
  assert.deepEqual(errors, []);
  console.log("PASS: automated accessibility across 11 pages and all settings sections, both themes, 390/768/1440 widths");
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
