// Automated accessibility (axe, WCAG 2.1 A/AA) and no horizontal overflow on every page, each
// Connections tab and the docs, in light and dark, at phone, tablet and desktop widths.
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";

const dir = mkdtempSync(join(tmpdir(), "heimdall-accessibility-"));
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
// Path → the page's H1, so each check runs on the rendered page rather than a loading state.
const PAGES = [
  ["/", "Overview"],
  ["/pipeline", "Pipeline"],
  ["/crews", "Crews & agents"],
  ["/graph", "Execution graph"],
  ["/activity", "Activity"],
  ["/quality", "Quality & approvals"],
  ["/autonomy", "Autonomy"],
  ["/new-work", "New work"],
  ["/notifications", "Notifications"],
  ["/projects", "Projects"],
  ["/connections/services", "Connections"],
  ["/connections/access", "Connections"],
  ["/connections/display", "Connections"],
  ["/connections/audit", "Connections"],
  ["/fleet", "Fleet"],
  ["/autonomy/all", "Autonomy (all)"],
  ["/docs/glossary", "Glossary"],
  ["/docs/heimdall-screens", "Heimdall screens"],
];
try {
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-components");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
  const findings = [];
  for (const theme of ["Light", "Dark"]) {
    // The bottom bar's theme menu sets <html data-theme>; the choice survives page loads.
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole("contentinfo").getByRole("button", { name: /^Theme:/ }).click();
    await page.getByRole("menuitemradio", { name: theme }).click();
    await page.getByRole("contentinfo").getByRole("button", { name: `Theme: ${theme}` }).waitFor();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1050 });
      for (const [path, title] of PAGES) {
        await page.goto(app.url + path + "?project=prj_demo");
        await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme.toLowerCase(), `${path} theme`);
        if (path.startsWith("/connections/"))
          await page.getByRole("tab", { selected: true }).waitFor();
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        for (const violation of result.violations) findings.push({ theme, width, path, rule: violation.id, targets: violation.nodes.map(n => n.target) });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} overflow at ${width} (${theme})`);
      }
    }
  }
  assert.deepEqual(findings, []);
  assert.deepEqual(errors, []);
  console.log(`PASS: automated accessibility and no overflow on ${PAGES.length} screens (every page, each Connections tab, docs), light and dark themes, 390/768/1440 widths`);
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
