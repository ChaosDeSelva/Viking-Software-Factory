// Browser checks for navigation, routing, the shell (top bar, bottom bar, drawers) and operator
// commands against the fixture Mimir.
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
import { until } from "./support.mjs";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "heimdall-browser-"));
const source = await fixture();
const now = new Date().toISOString(),
  common = { createdAt: now, updatedAt: now, version: 1 };
// A second project, to see the picker narrow every project page.
source.data.projects.push({ ...common, id: "prj_two", name: "Ledger tools", repoPath: "/example/ledger" });
source.data.missions.push({ ...common, id: "msn_two", projectId: "prj_two", objective: "Ship ledger exports", status: "active" });
source.data.crews.push({ ...common, id: "crw_two", missionId: "msn_two", template: "Ledger crew", status: "running" });
source.data.tasks.push(
  { ...common, id: "tsk_two", missionId: "msn_two", crewId: "crw_two", title: "Export ledger CSV", status: "ready", attempt: 0, maxAttempts: 3 },
  // Parked by Mimir on its crew's budget: the Raise budget flow releases it.
  { ...common, id: "tsk_budget", missionId: "msn_demo", crewId: "crw_demo", title: "Summarize spend", status: "blocked", blockedReason: "budget_exceeded", attempt: 1, maxAttempts: 3 },
  // Held because usage is unknown, with no budget in the attention list: limits cannot help.
  { ...common, id: "tsk_unknown", missionId: "msn_two", crewId: "crw_two", title: "Reconcile ledger", status: "blocked", blockedReason: "budget_uncertain", attempt: 1, maxAttempts: 3 },
);
source.attention = [
  { kind: "budget_exceeded", crewId: "crw_demo", missionId: "msn_demo", limitTokens: 10000, limitCost: null, spentTokens: 12240, spentCost: 0, budgetVersion: 0 },
];
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
const TABS = ["Overview", "Pipeline", "Crews & agents", "Execution graph", "Activity", "Quality & approvals", "Autonomy"];
const GLOBALS = ["Notifications", "Projects", "Connections", "Fleet", "Autonomy (all)"];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const h1 = (name) => page.getByRole("heading", { level: 1, name, exact: true });
// Project pages are top-bar links, global pages bottom-bar links; a count may follow the label.
const link = (name) =>
  page
    .getByRole("navigation", { name: TABS.includes(name) ? "Project pages" : "Global pages", exact: true })
    .getByRole("link", { name: new RegExp(`^${escape(name)}( \\d+)?$`) });
const nav = async (name) => {
  await link(name).click();
  await h1(name).waitFor();
};
const inspector = page.getByRole("dialog").filter({ hasText: "inspector" });
const closeInspector = async () => {
  await inspector.getByRole("button", { name: "Close", exact: true }).click();
  await inspector.waitFor({ state: "hidden" });
};
const commandDialog = page.getByRole("dialog").filter({ hasText: "This request changes the owning service" });
const confirmed = async () => {
  await commandDialog.waitFor({ state: "hidden" });
  await page.getByText("Source confirmed the request. Current state is shown.").first().waitFor();
};
const picker = page.getByRole("banner").getByRole("button", { name: /^Project:/ });
const pick = async (name) => {
  await picker.click();
  await page.getByRole("option", { name: new RegExp(`^${escape(name)}`) }).click();
  await until(async () => (await picker.innerText()).includes(name), "picker shows " + name);
};
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const axe = async (what) => {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  assert.deepEqual(
    result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    [],
    what,
  );
};
try {
  console.log("Login");
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-browser");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await h1("Overview").waitFor();
  assert.match(await picker.innerText(), /All projects/);

  console.log("Project filtering");
  await pick("Ledger tools");
  assert.equal(new URL(page.url()).searchParams.get("project"), "prj_two");
  await page.getByRole("button", { name: "Open Export ledger CSV" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open Implement integer-cent totals" }).count(), 0);
  await nav("Pipeline");
  assert.equal(new URL(page.url()).searchParams.get("project"), "prj_two", "tab links keep the project");
  await page.getByRole("button", { name: /Export ledger CSV/ }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Implement integer-cent totals/ }).count(), 0);
  await nav("Crews & agents");
  await page.getByRole("button", { name: "Inspect Ledger crew" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Inspect Implementation crew" }).count(), 0);
  await nav("Notifications");
  assert.equal(await picker.isDisabled(), true);
  assert.equal(await picker.getAttribute("title"), "This page covers all projects");
  await nav("Overview");
  assert.equal(await picker.isEnabled(), true);
  await pick("Invoice library");
  await page.getByRole("button", { name: "Open Implement integer-cent totals" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open Export ledger CSV" }).count(), 0);

  console.log("Search and empty state actions");
  await nav("Pipeline");
  await page.getByLabel("Search records").fill("no-such-task-987654");
  await page.getByText("No matching items").waitFor();
  await page.getByRole("button", { name: "Clear search" }).click();
  assert.equal(await page.getByLabel("Search records").inputValue(), "");
  await page.getByRole("region", { name: "Building stage, scroll for more items" }).waitFor();

  console.log("Task details");
  await nav("Overview");
  await page.getByRole("button", { name: "Open Implement integer-cent totals" }).click();
  await inspector.getByRole("heading", { name: "Task objective" }).waitFor();
  assert.ok(await inspector.getByText("Reject negative quantities.", { exact: false }).count());
  await closeInspector();

  console.log("Hulder task deep link");
  await page.goto(app.url + "/?task=tsk_demo");
  await inspector.getByRole("heading", { name: "Task objective" }).waitFor();
  await closeInspector();
  assert.equal(new URL(page.url()).searchParams.has("task"), false);
  assert.equal(new URL(page.url()).searchParams.has("inspect"), false);

  console.log("URL routing");
  // A bookmarked page with an open record survives a reload.
  // The open drawer hides the page from the accessibility tree, so read the H1 by its element.
  const pageTitle = () => page.locator("main h1").innerText();
  await page.goto(app.url + "/pipeline?project=prj_demo&inspect=tasks:tsk_demo");
  await inspector.getByRole("heading", { name: "Task objective" }).waitFor();
  assert.equal(await pageTitle(), "Pipeline");
  await page.reload();
  await inspector.getByRole("heading", { name: "Task objective" }).waitFor();
  assert.equal(await pageTitle(), "Pipeline");
  await closeInspector();
  await h1("Pipeline").waitFor();
  // Opening a record is a history entry: Back closes it; Back again returns to the previous page.
  await nav("Crews & agents");
  await page.getByRole("button", { name: "Inspect Implementation crew" }).click();
  await inspector.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("inspect"), "crews:crw_demo");
  await page.goBack();
  await inspector.waitFor({ state: "hidden" });
  await h1("Crews & agents").waitFor();
  assert.equal(new URL(page.url()).searchParams.has("inspect"), false);
  await page.goBack();
  await h1("Pipeline").waitFor();
  assert.equal(new URL(page.url()).pathname, "/pipeline");
  await page.goForward();
  await h1("Crews & agents").waitFor();

  console.log("Navigation");
  for (const title of [...TABS.slice(1), ...GLOBALS]) {
    await nav(title);
    await axe(title);
  }
  await page.getByRole("banner").getByRole("button", { name: "New work" }).click();
  await h1("New work").waitFor();
  await axe("New work");

  console.log("Execution graph");
  await nav("Execution graph");
  const graphNode = page.locator(".graph-node").filter({ hasText: "Implement integer-cent totals" });
  await graphNode.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await until(() => app.store.preferences().graphs?.msn_demo?.tsk_demo?.x === 50, "the saved layout");
  await page.reload();
  await h1("Execution graph").waitFor();
  assert.equal(await graphNode.evaluate((e) => e.style.left), "50px");
  await graphNode.dispatchEvent("click");
  await inspector.getByRole("heading", { name: "Task objective" }).waitFor();
  await closeInspector();

  console.log("Notifications");
  await nav("Notifications");
  await page.getByRole("button", { name: "Mark view read", exact: true }).click();
  await page.getByText("No notifications in this view.").waitFor();

  console.log("Tooltips");
  await nav("Pipeline");
  await page.getByRole("button", { name: "What is Pipeline?" }).click();
  await page.getByRole("dialog").getByRole("link", { name: /Read more in Docs/ }).waitFor();
  await page.keyboard.press("Escape");
  await nav("Crews & agents");
  await page.getByRole("main").getByRole("img", { name: "Status: Running" }).first().focus();
  await page.getByRole("tooltip").filter({ hasText: "running" }).first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Inspect Implementation crew" }).click();
  await inspector.getByRole("button", { name: /^Pause crew scheduling/ }).hover();
  await page.getByRole("tooltip").filter({ hasText: "Unlock operator controls" }).first().waitFor();
  await closeInspector();

  console.log("Docs");
  await nav("Pipeline");
  await page.getByRole("contentinfo").getByRole("link", { name: "Docs" }).click();
  await h1("Heimdall screens").waitFor();
  assert.equal(new URL(page.url()).pathname, "/docs/heimdall-screens");
  assert.equal(new URL(page.url()).hash, "#pipeline");
  await page.locator("#pipeline").waitFor();
  await page.goto(app.url + "/docs/heimdall-screens#pipeline");
  await h1("Heimdall screens").waitFor();
  await page.locator("#pipeline").waitFor();
  await page.getByLabel("Search the docs").fill("pipeline");
  await page.getByRole("list", { name: "Search results" }).getByRole("listitem").first().waitFor();
  // Shared search: a heading inside a page is a result of its own.
  await page.getByLabel("Search the docs").fill("budget blocked");
  const budget = page.getByRole("list", { name: "Search results" }).getByRole("link", { name: /^Budget blocked/ });
  if ((await budget.getAttribute("href")) !== "/docs/troubleshooting#budget-blocked")
    throw new Error("docs search did not return the Budget blocked heading");

  console.log("Ask drawer");
  const asked = [];
  await page.route("**/api/details/guide/ask", async (route) => {
    asked.push(JSON.parse(route.request().postData()));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Open the Pipeline page to see every stage.", links: [] }) });
  });
  await nav("Pipeline");
  await page.getByRole("contentinfo").getByRole("button", { name: "Ask", exact: true }).click();
  const ask = page.getByRole("dialog", { name: "Ask the guide" });
  await ask.waitFor();
  await ask.getByLabel("Your question").fill("Where are the stages?");
  await ask.getByLabel("Your question").press("Enter");
  await ask.getByText("Open the Pipeline page to see every stage.").waitFor();
  assert.equal(asked[0].question, "Where are the stages?");
  assert.equal(asked[0].context.screen, "pipeline");
  await page.keyboard.press("Escape");
  await ask.waitFor({ state: "hidden" });
  await page.unroute("**/api/details/guide/ask");

  console.log("Operator");
  await page.getByRole("button", { name: "Session: Read-only" }).click();
  await page.getByLabel("Heimdall operator code", { exact: true }).fill("operator-test");
  await page.getByRole("button", { name: "Unlock controls" }).click();
  await page.getByRole("button", { name: "Session: Operator unlocked" }).waitFor();
  await page.keyboard.press("Escape");
  await nav("Overview");
  await page.getByRole("button", { name: "Build reliable invoice tools" }).click();
  await inspector.getByRole("button", { name: "Pause mission" }).click();
  await commandDialog.getByRole("heading", { name: "Pause mission" }).waitFor();
  await commandDialog.getByLabel("Reason", { exact: true }).fill("Review requirements before continuing");
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
  await commandDialog.getByRole("button", { name: "Send to source" }).click();
  await commandDialog.getByRole("alert").filter({ hasText: /fetch/i }).first().waitFor();
  await commandDialog.getByRole("button", { name: "Send to source" }).click();
  await confirmed();
  await page.unroute("**/api/commands");
  assert.equal(source.data.missions[0].status, "paused");
  assert.equal(commandKeys.length, 2);
  assert.equal(commandKeys[0], commandKeys[1]);
  assert.equal(
    source.requests.filter((r) => r.method === "POST" && r.path === "/v1/missions/msn_demo/pause").length,
    1,
  );
  await closeInspector();

  console.log("Raise budget");
  // The budget-blocked task shows the card in its inspector...
  await page.goto(app.url + "/?project=prj_demo&inspect=tasks:tsk_budget");
  await inspector.getByRole("heading", { name: /^Raise budget/ }).waitFor();
  await closeInspector();
  // ...and a Raise budget action in Overview's Needs you list.
  const needsYou = page.getByRole("list", { name: "Needs you" });
  await needsYou.getByRole("listitem").filter({ hasText: "Summarize spend" }).getByRole("button", { name: "Raise budget" }).click();
  const budgetDialog = page.getByRole("dialog", { name: "Raise budget" });
  const tokens = budgetDialog.getByLabel("New token limit");
  // The form starts from double the limit Mimir reported.
  await until(async () => (await tokens.inputValue()) === "20000", "the suggested token limit");
  await budgetDialog.getByLabel("New cost limit (USD)").fill("5");
  await budgetDialog.getByRole("button", { name: "Review budget change" }).click();
  await commandDialog.getByRole("heading", { name: "Raise budget" }).waitFor();
  await commandDialog.getByLabel("Reason", { exact: true }).fill("Finish the summary");
  await commandDialog.getByRole("button", { name: "Send to source" }).click();
  await confirmed();
  const patch = source.requests.find((r) => r.method === "PATCH" && r.path === "/v1/crews/crw_demo/budget");
  assert.ok(patch, "the PATCH reached Mimir");
  assert.deepEqual(JSON.parse(patch.body), { limitTokens: 20000, limitCost: 5, expectedVersion: 0 });
  assert.deepEqual(source.budgets.crw_demo, { version: 1, limitTokens: 20000, limitCost: 5 });
  assert.equal(source.data.tasks.find((t) => t.id === "tsk_budget").status, "ready");
  await app.hub.refresh();
  await needsYou.getByText("Summarize spend").waitFor({ state: "hidden" });
  await page.goto(app.url + "/?project=prj_demo&inspect=tasks:tsk_budget");
  await inspector.getByRole("img", { name: "Status: Ready" }).waitFor();
  await closeInspector();
  // budget_uncertain with nothing in the attention list: the operator picks the budget, and the
  // unknown-usage choice (preset to allow) is what goes to Mimir, with no limits.
  await page.goto(app.url + "/?project=prj_two&inspect=tasks:tsk_unknown");
  const unknownUsage = inspector.getByRole("radiogroup", { name: "When usage is unknown" });
  await unknownUsage.getByRole("radio", { name: "Allow dispatch", checked: true }).waitFor();
  const budgetScope = inspector.getByRole("radiogroup", { name: "Budget to change" });
  await budgetScope.getByRole("radio", { name: "Crew budget", checked: true }).waitFor();
  assert.equal(await inspector.getByLabel("New token limit").inputValue(), "");
  await inspector.getByRole("button", { name: "Review budget change" }).click();
  await commandDialog.getByRole("heading", { name: "Raise budget" }).waitFor();
  await commandDialog.getByLabel("Reason", { exact: true }).fill("Usage is not reported by this runtime");
  await commandDialog.getByRole("button", { name: "Send to source" }).click();
  await confirmed();
  const allow = source.requests.findLast((r) => r.method === "PATCH" && r.path === "/v1/crews/crw_two/budget");
  assert.deepEqual(JSON.parse(allow.body), { onUnknown: "allow" });
  assert.equal(source.data.tasks.find((t) => t.id === "tsk_unknown").status, "ready");
  await closeInspector();
  // Back to the first project: the steps below read its events.
  await page.goto(app.url + "/?project=prj_demo");
  await h1("Overview").waitFor();

  console.log("Event drill-down");
  source.emit();
  await nav("Activity");
  const event = page.getByRole("button", { name: "Task output (task.output)" });
  await event.first().click();
  await inspector.getByText("Running regression tests", { exact: false }).first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  console.log("Theme and screenshots");
  await nav("Overview");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/overview.png", fullPage: true, animations: "disabled" });
  const theme = page.getByRole("contentinfo").getByRole("button", { name: /^Theme:/ });
  await theme.click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.getByRole("button", { name: "Theme: Dark" }).click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");

  console.log("Phone layout");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await noOverflow(), true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Project pages (current: Overview)" }).click();
  await page.getByRole("menuitem", { name: "Pipeline" }).click();
  await h1("Pipeline").waitFor();
  await page.getByRole("button", { name: "Project pages (current: Pipeline)" }).waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Global pages", exact: true }).isVisible(), false);
  const more = page.getByRole("dialog", { name: "More" });
  await page.getByRole("contentinfo").getByRole("button", { name: "More" }).click();
  await more.getByRole("navigation", { name: "Global pages (more)" }).getByRole("link", { name: "Fleet" }).click();
  await h1("Fleet").waitFor();
  await more.waitFor({ state: "hidden" });

  for (const width of [390, 768, 1024, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of ["/", "/projects", "/pipeline", "/crews", "/graph", "/activity", "/quality", "/autonomy", "/new-work", "/notifications", "/connections", "/fleet", "/autonomy/all", "/docs"]) {
      await page.goto(app.url + path + "?project=prj_demo");
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      assert.equal(await noOverflow(), true, `${path}: page overflow at ${width}px`);
    }
  }

  console.log("Sign out from the More sheet");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("contentinfo").getByRole("button", { name: "More" }).click();
  for (const name of GLOBALS)
    await more.getByRole("navigation", { name: "Global pages (more)" }).getByRole("link", { name: new RegExp(`^${escape(name)}( \\d+)?$`) }).waitFor();
  await more.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Access token", { exact: true }).waitFor();
  await page.goto(app.url + "/pipeline");
  await page.getByRole("heading", { level: 1, name: "Sign in to Heimdall" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: project filtering and the disabled picker on global pages, empty-state actions, task details, Hulder deep link, URL routing (reload, Back, Forward), every page via top- and bottom-bar links with axe, graph keyboard movement and persisted layout, notifications, tooltips, docs route and search, Ask drawer, session-popover unlock, confirmed pause with idempotent resend, raise budget end to end (exhausted, and unknown usage), event drill-down, Escape, theme menu, phone page menu, More sheet and sign out, no overflow at four widths.",
  );
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
