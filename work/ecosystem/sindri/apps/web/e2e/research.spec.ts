import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { E2E_TOKEN } from "../playwright.config.js";

// The research form runs against the real e2e server; the document view is fed a fixture
// delivery through page.route, since the fake Mimir does not write research artifacts.

let repo: TempRepo;
test.beforeAll(() => {
  repo = createTempRepo(
    { "README.md": "# Totals\n\nInvoices are summed per month.\n" },
    { git: true },
  );
});
test.afterAll(() => repo.cleanup());

async function expectNoSeriousA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map(
      (v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
}

const notice = (page: Page) => page.locator('div[role="status"][aria-live="polite"]');

const DELIVERY_ID = "e2e-research-1";

function researchDelivery(projectId: string) {
  return {
    deliveryService: "s6",
    prDescription: "",
    report: {
      id: "dlv_r1",
      executionId: DELIVERY_ID,
      projectId,
      status: "built",
      createdAt: "2026-01-01T00:01:00Z",
      deliveredAt: null,
      spec: { id: "s1", lineageId: "L1", version: 1, title: "Totals", intakeId: null },
      plan: { id: "pl1", version: 1 },
      missionId: "msn_1",
      requirements: [],
      tasks: [],
      summary: { sentences: [], stripped: [] },
      changedFiles: [],
      testResults: [],
      screenshots: [],
      reviews: [],
      limitations: [],
      rollback: { branches: [], commits: [], note: "" },
      workKind: "research",
      guidance: {
        skills: [],
        omitted: [],
        projectNotes: "",
        requestNotes: "",
        projectNotesDigest: null,
        requestNotesDigest: null,
      },
      research: {
        question: "How are invoices totalled?",
        sourcesAllowed: { code: true, feedbackGraph: true, web: false },
        planTaskId: "research",
        document: {
          markdown:
            "## Answer\n\nInvoices are summed per month [1], rounded half up [2].\n\n## Findings\n\nNone.\n\n## Open questions\n\nNone.\n\n## Sources\n\n1. README.md\n",
          artifactId: "art_doc",
        },
        sources: [
          { id: "1", kind: "file", ref: "README.md:3" },
          { id: "2", kind: "lesson", ref: "lesson:7", title: "Round half up", private: true },
        ],
        sourcesArtifactId: "art_src",
        containsPrivateSources: true,
        gate: { passed: true, failures: [] },
        factCheck: null,
        decision: null,
      },
    },
  };
}

test("research question form and document view", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("API token", { exact: true }).fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  // Independent of other specs sharing the server: go to Projects instead of the empty Overview.
  await page
    .getByRole("navigation", { name: "Global pages" })
    .getByRole("link", { name: /^Projects( \d+)?$/ })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Totals");
  await page.getByLabel("Repository path", { exact: true }).fill(repo.path);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(notice(page)).toContainText("Created project Totals");

  await page
    .getByRole("navigation", { name: "Project pages" })
    .getByRole("link", { name: /^Inbox( \d+)?$/ })
    .click();
  await page.getByRole("radio", { name: "Research", exact: true }).click();
  const form = page.getByRole("form", { name: "Research question", exact: true });
  await expect(form.getByLabel("Project code", { exact: true })).toBeChecked();
  await expect(
    form.getByLabel("Lessons from your feedback history", { exact: true }),
  ).toBeDisabled();
  await expectNoSeriousA11yViolations(page, "research form");
  await form.getByLabel("Question", { exact: true }).fill("How are invoices totalled?");
  await form.getByLabel("Web", { exact: true }).check();
  await form.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(notice(page)).toContainText('Added research question "How are invoices totalled?"');
  const row = page.getByRole("button", { name: /How are invoices totalled\?/ });
  await expect(row).toContainText("Research");
  await row.click();
  await expect(page.getByRole("article", { name: "Intake detail", exact: true })).toContainText(
    "Project code, Web",
  );

  const projectId = new URL(page.url()).hash.match(/project=([^&]+)/)?.[1] ?? "";
  expect(projectId).not.toBe("");
  await page.route(/\/v1\/deliveries\?/, (route) =>
    route.fulfill({
      json: {
        deliveries: [
          {
            id: DELIVERY_ID,
            planId: "pl1",
            planVersion: 1,
            projectId,
            status: "verified_pending_review",
            mimirMissionId: "msn_1",
            createdAt: "2026-01-01T00:00:00Z",
            finishedAt: "2026-01-01T00:01:00Z",
          },
        ],
      },
    }),
  );
  await page.route(new RegExp(`/v1/deliveries/${DELIVERY_ID}$`), (route) =>
    route.fulfill({ json: researchDelivery(projectId) }),
  );
  await page.goto(`/#/deliveries?project=${projectId}&delivery=${DELIVERY_ID}`);
  await expect(page.getByRole("heading", { name: "How are invoices totalled?" })).toBeVisible();
  await expect(page.getByText("Contains private lessons")).toBeVisible();
  const doc = page.getByRole("region", { name: "Research document", exact: true });
  await expect(doc).toContainText("Invoices are summed per month");
  await expect(doc).toContainText("README.md:3");
  await expect(doc).toContainText("Private lesson");
  await expect(page.getByRole("tab", { name: /Local export/ })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, "research document");
});
