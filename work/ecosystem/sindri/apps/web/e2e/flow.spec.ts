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
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    // Known @factory/ui 0.1.0 issue (reported upstream): LogView puts role="log" on its <ol>,
    // which orphans the <li> rows for axe. Only that exact pattern is skipped.
    .filter(
      (v) => !(v.id === "listitem" && v.nodes.every((n) => /grid-cols/.test(String(n.target)))),
    );
  expect(
    serious.map(
      (v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

/** The app's notice region (loading placeholders also use role=status). */
const notice = (page: Page) => page.locator('div[role="status"][aria-live="polite"]');

/** Project tabs live in the top bar; global pages (Projects, Settings, …) in the bottom bar. */
const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: /^(Project pages|Global pages)$/ })
    .getByRole("link", { name: new RegExp(`^${name}( \\d+)?$`) })
    .first()
    .click();

test("create project, bootstrap, intake, draft, answer, approve, plan, execute, deliver", async ({
  page,
}) => {
  await page.goto("/");
  await expectNoSeriousA11yViolations(page, "token prompt");
  await page.getByLabel("API token", { exact: true }).fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // Overview without projects points to Projects: create + bootstrap.
  await page.getByRole("button", { name: "Add a project", exact: true }).click();
  await expect(page.getByText(/No projects yet/).first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, "projects (empty)");
  await page.getByLabel("Name", { exact: true }).fill("Fixture");
  await page.getByLabel("Repository path", { exact: true }).fill(repo.path);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(notice(page)).toContainText("Created project Fixture");
  await page.getByRole("button", { name: "Bootstrap Fixture", exact: true }).click();
  const summary = page.getByLabel("Bootstrap result", { exact: true });
  await expect(summary).toContainText("Indexed");
  await expect(summary).toContainText("skipped 1");
  // The index search lives on the project's settings (Repository & index).
  await page.getByRole("link", { name: "Project settings", exact: true }).click();
  await page.getByRole("tab", { name: "Repository & index", exact: true }).click();
  await page.getByLabel("Search the project index", { exact: true }).fill("invoices");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("list", { name: "Search results", exact: true })).toContainText(
    "README.md",
  );
  await expectNoSeriousA11yViolations(page, "projects");

  // Inbox: manual intake.
  await nav(page, "Inbox");
  await page.getByLabel("Title", { exact: true }).fill("CSV export for reports");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Finance wants to export the reports page as CSV.");
  await page.getByRole("button", { name: "Add to inbox", exact: true }).click();
  await expect(page.getByRole("button", { name: /CSV export for reports/ })).toBeVisible();
  await page.getByRole("button", { name: /CSV export for reports/ }).click();
  await expect(page.getByRole("article", { name: "Intake detail", exact: true })).toContainText(
    "Finance wants",
  );
  await expectNoSeriousA11yViolations(page, "inbox");

  // Director: draft from the intake, answer the blocking question.
  await nav(page, "Director");
  await page.getByLabel("Request", { exact: true }).fill("Add CSV export to the reports page");
  await page
    .getByLabel("Inbox item (optional)", { exact: true })
    .selectOption({ label: "CSV export for reports" });
  await page.getByRole("button", { name: "Draft spec", exact: true }).click();
  const article = page.getByRole("article", { name: /CSV export for reports/ });
  await expect(article).toContainText("Users cannot export reports as CSV.");
  await expect(article).toContainText("Sources: intake:");
  await expectNoSeriousA11yViolations(page, "director (draft)");
  await page
    .getByLabel("Q1: Which columns must the CSV include?", { exact: true })
    .fill("Date, invoice number and total");
  await page.getByRole("button", { name: "Submit answer to Q1", exact: true }).click();
  await expect(notice(page)).toContainText("spec revised to v2");
  // Q1 is answered; the non-blocking Q2 stays open and answerable.
  await expect(page.getByRole("form", { name: "Answer Q1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Answer Q2", exact: true })).toBeVisible();
  await expect(article).toContainText("Date, invoice number and total");

  // Specs: submit + approve v2.
  await page.getByRole("button", { name: "Open in Specs", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Versions", exact: true })).toContainText(
    "v2 (draft)",
  );
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(notice(page)).toContainText("Submitted v2 for review");
  // Approvals need the pairing code from the server terminal (audit M9); e2e/server.ts fixes it.
  await page.getByLabel("Approval pairing code", { exact: true }).fill("E2EPA-IRCDE");
  await page.getByRole("button", { name: "Unlock approvals", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(notice(page)).toContainText("Approved v2");
  await expect(page.getByRole("navigation", { name: "Versions", exact: true })).toContainText(
    "v2 (approved)",
  );
  await expect(page.getByRole("navigation", { name: "Versions", exact: true })).toContainText(
    "v1 (superseded)",
  );
  await expectNoSeriousA11yViolations(page, "specs");

  // Plans: propose from the approved spec, review the DAG, submit, approve.
  await nav(page, "Plans");
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await expect(notice(page)).toContainText("Proposed plan v1");
  await expect(page.getByRole("heading", { name: /Plan v1/ })).toBeVisible();
  const implTask = page.getByRole("article", { name: "Task implement-frontend", exact: true });
  await expect(implTask).toContainText("frontend-react@");
  await implTask.getByText("Why this harness").click();
  await expect(implTask).toContainText("selected");
  await page.getByRole("tab", { name: "Dry-run order" }).click();
  await expect(page.getByRole("list", { name: "Dry-run order", exact: true })).toContainText(
    "Step 1",
  );
  await expectNoSeriousA11yViolations(page, "plans");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(notice(page)).toContainText("Submitted plan v1 for review");
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  await expect(notice(page)).toContainText("Approved plan v1");

  // Execute through the fake Mimir; approve the one gated action from Runs.
  await page.getByRole("button", { name: "Execute plan", exact: true }).click();
  await expect(notice(page)).toContainText("Started a run");
  await expect(
    page.getByRole("link", { name: /Open (mission msn_\S+ )?in Mimir/ }).first(),
  ).toBeVisible();
  const approve = page.getByRole("button", {
    name: "Approve fs.write for implement-frontend",
    exact: true,
  });
  await expect(approve).toBeVisible({ timeout: 15_000 });
  // Agent deep link from the session Mimir put on the task's events.
  await expect(
    page.getByRole("link", {
      name: "Open agent session for implement-frontend in Mimir",
      exact: true,
    }),
  ).toHaveAttribute("href", /\/agents\/ses/);
  await expectNoSeriousA11yViolations(page, "runs (awaiting approval)");
  await nav(page, "Needs you");
  await expect(
    page.getByRole("button", { name: "Approve fs.write for implement-frontend", exact: true }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, "reviews");
  await nav(page, "Runs");
  await page
    .getByRole("button", { name: /^Run 1/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Approve fs.write for implement-frontend", exact: true })
    .click();
  await expect(notice(page)).toContainText("Approved fs.write");
  await page.getByRole("button", { name: "Open delivery", exact: true }).click({ timeout: 15_000 });

  // Deliveries: report, PR text and trace.
  const reportRegion = page.getByRole("region", { name: "Delivery report", exact: true });
  await expect(reportRegion).toContainText("AC1");
  // No Brokkr verification report was recorded by the fake Mimir: gates fail closed.
  // Shown in plain words; the raw code stays on the element (and in its tooltip).
  await expect(reportRegion).toContainText("Verification report missing");
  await expect(
    reportRegion.locator('[data-reason-code$="verification_report_missing"]').first(),
  ).toBeAttached();
  await page.getByRole("tab", { name: "Local export" }).click();
  await expect(
    page.getByRole("region", { name: "Delivery description", exact: true }),
  ).toContainText("## Requirements");
  await page.getByRole("tab", { name: "Trace" }).click();
  const traceTree = page.getByRole("list", { name: "Trace", exact: true });
  await expect(traceTree).toContainText("Mimir mission");
  await expect(traceTree).toContainText("test.output");
  await expectNoSeriousA11yViolations(page, "deliveries");
  await nav(page, "Needs you");
  await expect(page.getByText(/Verification report missing/).first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, "reviews (gate failures)");
  await nav(page, "Harnesses");
  await expect(page.getByText(/Fixture harnesses/)).toBeVisible();
  await page
    .getByRole("button", { name: /^frontend-react@/ })
    .first()
    .click();
  // disabledReason buttons are aria-disabled (still focusable, with the reason as a tooltip).
  await expect(page.getByRole("button", { name: /^Verify/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expectNoSeriousA11yViolations(page, "harnesses");

  // Routes: the URL names the view and selection, the title follows, and a bad deep link
  // shows an announced error state (axe on an error state).
  await expect(page).toHaveTitle("Harnesses · Fixture · Sindri");
  const project = new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("project");
  expect(project).toBeTruthy();
  await page.goto(`/#/deliveries?project=${project}&delivery=exe_missing`);
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not load delivery" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Deliveries · Fixture · Sindri");
  await expectNoSeriousA11yViolations(page, "deliveries (error state)");
  await page.goBack();
  await expect(page).toHaveTitle("Harnesses · Fixture · Sindri");

  // Knowledge and Settings render and pass axe; check dark theme too.
  await nav(page, "Knowledge");
  await expect(page.getByText(/No knowledge entries yet/)).toBeVisible();
  await expectNoSeriousA11yViolations(page, "knowledge");
  await nav(page, "Settings");
  await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page, "settings");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // Colour transitions can still be mid-way when axe measures; a reload shows the saved theme
  // settled (and checks that it persists).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page, "settings (dark)");
});
