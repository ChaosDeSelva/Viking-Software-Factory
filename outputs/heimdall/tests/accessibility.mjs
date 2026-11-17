// Automated accessibility (axe, WCAG 2.1 A/AA) and no horizontal overflow on every page, each
// Connections tab and the docs, in light and dark, at phone, tablet and desktop widths.
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture, installWorkKinds } from "./fixture.mjs";

const dir = mkdtempSync(join(tmpdir(), "heimdall-accessibility-"));
const source = await fixture();
installWorkKinds(source);
const app = await startHeimdall({ env: {
  HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: "test-components",
  MIMIR_URL: source.url, MIMIR_TOKEN: "fixture-token",
  SINDRI_URL: source.url, SINDRI_TOKEN: "fixture-token",
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
  ["/in-progress", "In progress"],
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
const kindForm = (kind, ready) => async () => {
  await page.goto(app.url + "/new-work?project=prj_demo");
  await page.getByRole("radiogroup", { name: "Kind of work" }).getByRole("radio", { name: kind }).click();
  await page.getByRole("button", { name: ready }).waitFor();
  await page.getByText("Loading skills…").waitFor({ state: "detached" });
};
const delivery = (id, region) => async () => {
  await page.goto(app.url + `/quality?project=prj_demo&inspect=deliveries:${id}`);
  await page.getByRole("dialog").getByRole("region", { name: region }).waitFor();
};
const WORK_STATES = [
  ["New work: research", kindForm("Research", "Save and draft spec")],
  ["New work: PR review", kindForm("Review a PR", "Review pull request import")],
  ["Inspector: research document", delivery("exe_research", "Research document")],
  ["New work: plan from text", kindForm("Plan from text", "Save and draft spec")],
  ["Inspector: plan", async () => {
    await delivery("exe_plan", "Plan")();
    const plan = page.getByRole("dialog");
    await plan.getByLabel("Diagram").first().waitFor();
    // A fact-check that asked for changes says what to do next, where the plan is read.
    await plan.getByText("The fact-check asked for changes", { exact: true }).waitFor();
    await plan.getByText(/1 major · 1 minor/).first().waitFor();
    await plan.getByLabel("What to change").waitFor();
    assert.equal(await plan.getByRole("button", { name: "Re-run quality checks" }).count(), 0);
    await plan.getByRole("tab", { name: /Fact-check/ }).click();
    const facts = plan.getByRole("list", { name: "Fact-check findings" });
    await facts.getByText("The Sources list skips [2]").waitFor();
    // The run's input folders are dropped from the location, and the fix reads apart.
    await facts.getByText("proposal.md:12", { exact: true }).waitFor();
    await facts.getByText("move the export to week 2.").waitFor();
  }],
  ["Inspector: PR review", async () => {
    await delivery("exe_review", "Leak check")();
    await page.getByRole("dialog").getByText("Posting is blocked").waitFor();
  }],
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
      // States reached by a click or an inspector link: the work-kind forms and delivery views.
      for (const [name, open] of WORK_STATES) {
        await open();
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        for (const violation of result.violations) findings.push({ theme, width, path: name, rule: violation.id, targets: violation.nodes.map(n => n.target) });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow at ${width} (${theme})`);
      }
      // The inspector is modal; leave it so the theme menu is reachable again.
      await page.goto(app.url + "/?project=prj_demo");
      await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
    }
  }
  assert.deepEqual(findings, []);
  assert.deepEqual(errors, []);
  console.log(`PASS: automated accessibility and no overflow on ${PAGES.length} screens (every page, each Connections tab, docs) and ${WORK_STATES.length} work-kind states (research and PR review forms and inspector views), light and dark themes, 390/768/1440 widths`);
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
