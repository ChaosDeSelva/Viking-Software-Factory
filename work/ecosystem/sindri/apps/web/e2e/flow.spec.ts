import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { E2E_TOKEN } from "../playwright.config.js";

let repo: TempRepo;
test.beforeAll(() => {
  repo = createTempRepo(
    {
      "README.md":
        "# Reports\n\nThe reports page lists invoices and totals. Users want CSV export.\n",
      "docs/reports.md": "# Reports page\n\nRendered by the reports service.\n",
      "package.json": JSON.stringify({ name: "fixture", scripts: { test: "vitest run" } }),
      ".env": "SECRET=never-index-me\n",
    },
    { git: true },
  );
});
test.afterAll(() => repo.cleanup());

async function expectNoSeriousA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map(
      (v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

/** The app's notice region (loading placeholders also use role=status). */
const notice = (page: Page) => page.locator('div[role="status"][aria-live="polite"]');

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();

test("create project, bootstrap, intake, draft, answer, approve, plan, execute, deliver", async ({
  page,
}) => {
  await page.goto("/");
  await expectNoSeriousA11yViolations(page, "token prompt");
  await page.getByLabel("API token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();

  // Projects: create + bootstrap.
  await expect(page.getByText(/No projects yet/)).toBeVisible();
  await expectNoSeriousA11yViolations(page, "projects (empty)");
  await page.getByLabel("Name").fill("Fixture");
  await page.getByLabel("Repository path").fill(repo.path);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toContainText("Created project Fixture");
  await page.getByRole("button", { name: "Bootstrap Fixture" }).click();
  const summary = page.getByLabel("Bootstrap result");
  await expect(summary).toContainText("Indexed");
  await expect(summary).toContainText("skipped 1");
  await page.getByLabel("Search the project index").fill("invoices");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("README.md");
  await expectNoSeriousA11yViolations(page, "projects");

  // Inbox: manual intake.
  await nav(page, "Inbox");
  await page.getByLabel("Title").fill("CSV export for reports");
  await page.getByLabel("Description").fill("Finance wants to export the reports page as CSV.");
  await page.getByRole("button", { name: "Add to inbox" }).click();
  await expect(page.getByRole("button", { name: /CSV export for reports/ })).toBeVisible();
  await page.getByRole("button", { name: /CSV export for reports/ }).click();
  await expect(page.getByRole("article", { name: "Intake detail" })).toContainText("Finance wants");
  await expectNoSeriousA11yViolations(page, "inbox");

  // Director: draft from the intake, answer the blocking question.
  await nav(page, "Director");
  await page.getByLabel("Request").fill("Add CSV export to the reports page");
  await page.getByLabel("Inbox item (optional)").selectOption({ label: "CSV export for reports" });
  await page.getByRole("button", { name: "Draft spec" }).click();
  const article = page.getByRole("article", { name: /CSV export for reports/ });
  await expect(article).toContainText("Users cannot export reports as CSV.");
  await expect(article).toContainText("Sources: intake:");
  await expectNoSeriousA11yViolations(page, "director (draft)");
  await page
    .getByLabel("Q1: Which columns must the CSV include?")
    .fill("Date, invoice number and total");
  await page.getByRole("button", { name: "Submit answer to Q1" }).click();
  await expect(page.getByRole("status")).toContainText("spec revised to v2");
  await expect(page.getByText("No blocking questions remain.")).toBeVisible();
  await expect(article).toContainText("Date, invoice number and total");

  // Specs: submit + approve v2.
  await page.getByRole("button", { name: "Open in Specs" }).click();
  await expect(page.getByRole("navigation", { name: "Versions" })).toContainText("v2 (draft)");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("status")).toContainText("Submitted v2 for review");
  // Approvals need the pairing code from the server terminal (audit M9); e2e/server.ts fixes it.
  await page.getByLabel("Approval pairing code").fill("E2EPA-IRCDE");
  await page.getByRole("button", { name: "Unlock approvals" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toContainText("Approved v2");
  await expect(page.getByRole("navigation", { name: "Versions" })).toContainText("v2 (approved)");
  await expect(page.getByRole("navigation", { name: "Versions" })).toContainText("v1 (superseded)");
  await expectNoSeriousA11yViolations(page, "specs");

  // Plans: propose from the approved spec, review the DAG, submit, approve.
  await nav(page, "Plans");
  await page.getByRole("button", { name: "Propose plan" }).click();
  await expect(notice(page)).toContainText("Proposed plan v1");
  await expect(page.getByRole("heading", { name: /Plan v1/ })).toBeVisible();
  const implTask = page.getByRole("article", { name: "Task implement-frontend" });
  await expect(implTask).toContainText("frontend-react@");
  await implTask.getByText("Why this harness").click();
  await expect(implTask).toContainText("selected");
  await expect(page.getByRole("list", { name: "Dry-run order" })).toContainText("Step 1");
  await expectNoSeriousA11yViolations(page, "plans");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(notice(page)).toContainText("Submitted plan v1 for review");
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(notice(page)).toContainText("Approved plan v1");

  // Execute through the fake Mimir; approve the one gated action from Runs.
  await page.getByRole("button", { name: "Execute plan" }).click();
  await expect(notice(page)).toContainText("Started run");
  await expect(page.getByRole("link", { name: /Open mission msn_\S+ in Mimir/ })).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve fs.write for implement-frontend" });
  await expect(approve).toBeVisible({ timeout: 15_000 });
  // Agent deep link from the session Mimir put on the task's events.
  await expect(
    page.getByRole("link", { name: "Open agent session for implement-frontend in Mimir" }),
  ).toHaveAttribute("href", /\/agents\/ses/);
  await expectNoSeriousA11yViolations(page, "runs (awaiting approval)");
  await nav(page, "Reviews");
  await expect(
    page.getByRole("button", { name: "Approve fs.write for implement-frontend" }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, "reviews");
  await nav(page, "Runs");
  await page.getByRole("button", { name: /^exe_/ }).first().click();
  await page.getByRole("button", { name: "Approve fs.write for implement-frontend" }).click();
  await expect(notice(page)).toContainText("Approved fs.write");
  await page.getByRole("button", { name: "Open delivery" }).click({ timeout: 15_000 });

  // Deliveries: report, PR text and trace.
  const reportRegion = page.getByRole("region", { name: "Delivery report" });
  await expect(reportRegion).toContainText("AC1");
  // No Brokkr verification report was recorded by the fake Mimir: gates fail closed.
  await expect(reportRegion).toContainText("verification_report_missing");
  await expect(page.getByRole("region", { name: "Delivery description" })).toContainText(
    "## Requirements",
  );
  const traceTree = page.getByRole("list", { name: "Trace" });
  await expect(traceTree).toContainText("Mimir mission");
  await expect(traceTree).toContainText("test.output");
  await expectNoSeriousA11yViolations(page, "deliveries");
  await nav(page, "Reviews");
  await expect(page.getByText(/verification_report_missing/).first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, "reviews (gate failures)");
  await nav(page, "Harnesses");
  await expect(page.getByText(/Fixture harnesses/)).toBeVisible();
  await page
    .getByRole("button", { name: /^frontend-react@/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Verify" })).toBeDisabled();
  await expectNoSeriousA11yViolations(page, "harnesses");

  // Routes: the URL names the view and selection, the title follows, and a bad deep link
  // shows an announced error state (axe on an error state).
  await expect(page).toHaveTitle("Harnesses · Sindri");
  const project = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("project");
  expect(project).toBeTruthy();
  await page.goto(`/#/deliveries?project=${project}&delivery=exe_missing`);
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not load delivery" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Deliveries · Sindri");
  await expectNoSeriousA11yViolations(page, "deliveries (error state)");
  await page.goBack();
  await expect(page).toHaveTitle("Harnesses · Sindri");

  // Knowledge and Settings render and pass axe; check dark theme too.
  await nav(page, "Knowledge");
  await expect(page.getByText(/No knowledge entries yet/)).toBeVisible();
  await expectNoSeriousA11yViolations(page, "knowledge");
  await nav(page, "Settings");
  await expect(page.getByLabel("Model")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "settings");
  await page.getByRole("button", { name: /switch to dark theme/i }).click();
  await expectNoSeriousA11yViolations(page, "settings (dark)");
});
