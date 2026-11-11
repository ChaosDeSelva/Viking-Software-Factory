// Browser checks for the specification, plan and delivery workflow against fixture Sindri records.
import { chromium } from "@playwright/test";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "heimdall-workflow-"));
const source = await fixture();
const body = {
  problem: "Totals drift by a cent",
  goals: ["Exact totals"],
  acceptanceCriteria: [],
  openQuestions: [
    { id: "q-soft", text: "Which currency symbol should be shown?", blocking: false },
    {
      id: "q-hard",
      text: "Round half up or half to even?",
      blocking: true,
      recommendation: "Round half to even",
      rationale: "The ledger module already does.",
    },
  ],
};
source.workflow = {
  projects: [
    { id: "prj_demo", name: "Invoice library", repoPath: "/example/invoice" },
    { id: "sp_ledger", name: "Ledger app", repoPath: "/example/ledger" },
  ],
  specs: [
    { id: "spc_v1", projectId: "prj_demo", lineageId: "ln_a", version: 1, status: "superseded", title: "Exact invoice totals", body },
    { id: "spc_v2", projectId: "prj_demo", lineageId: "ln_a", version: 2, status: "draft", title: "Exact invoice totals", body },
    { id: "spc_ledger", projectId: "sp_ledger", lineageId: "ln_l", version: 1, status: "draft", title: "Ledger export", body: { ...body, openQuestions: [] } },
  ],
  plans: [
    {
      id: "pln_ok", projectId: "prj_demo", lineageId: "lp_a", version: 1, status: "approved", specId: "spc_v1",
      tasks: [{ id: "build", objective: "Build totals", budget: { wallClockMinutes: 10 }, maxRetries: 1, dependsOn: [], inputs: [], outputs: [], acceptanceCriteria: [] }],
    },
  ],
  intakes: [{ id: "int_1", projectId: "prj_demo", title: "Customer request", body: "Please fix totals" }],
  deliveries: [{ id: "exe_demo", executionId: "exe_demo", projectId: "prj_demo", status: "verified_pending_review" }],
  meta: { ln_a: { untrustedInstructionDetected: true } },
  local: {
    baseSha: "base000",
    resultCommit: "abc1234def",
    patch: "diff --git a/total.js b/total.js",
    repoPath: "/example/invoice",
    apply: "git -C /example/invoice merge abc1234def",
    undo: "git -C /example/invoice reset --hard base000",
  },
};
source.execution.execution.status = "verified_pending_review";
source.execution.plan = { id: "pln_ok", version: 1, specId: "spc_v2", tasks: [] };
source.data.tasks.push({
  ...source.data.tasks[1],
  id: "tsk_cancel",
  title: "Abandoned spike",
  status: "cancelled",
});
const app = await startHeimdall({
  env: {
    HEIMDALL_PORT: "0",
    HEIMDALL_DATA_DIR: dir,
    HEIMDALL_TOKEN: "test-workflow",
    MIMIR_URL: source.url,
    MIMIR_TOKEN: "fixture-token",
    SINDRI_URL: source.url,
    SINDRI_TOKEN: "fixture-token",
  },
  operatorCode: "operator-test",
  // Short enough to time a submit out without slowing the run.
  commandTimeout: (action) => (action === "spec.submit" ? 500 : undefined),
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
const nav = (name) =>
  page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true })
    .click();
const stage = (name) => page.getByRole("region", { name: new RegExp(`^${name} stage`) });
const inspector = page.getByRole("dialog").filter({ hasText: "INSPECTOR" });
const closeInspector = () => page.getByRole("button", { name: "Close inspector" }).click();
const send = async (reason) => {
  await page.getByLabel("Reason", { exact: true }).fill(reason);
  await page.getByRole("button", { name: "Send to source" }).click();
};
const confirmed = () =>
  page.getByText("Source confirmed the request.", { exact: false }).first().waitFor();
const access = async () => {
  await nav("Connections");
  await page.getByRole("button", { name: "Access", exact: true }).click();
};
const pair = async () => {
  await access();
  await page.getByLabel("Sindri pairing code").fill("sindri-code");
  await page.getByRole("button", { name: "Pair approval session" }).click();
  await page.getByText("Paired", { exact: true }).waitFor();
};
const posts = (path) =>
  source.requests.filter((r) => r.method === "POST" && r.path === path).length;
try {
  console.log("Pipeline lists");
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-workflow");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { name: "Factory overview" }).waitFor();
  await nav("Pipeline");
  const specCard = stage("Specification").getByRole("button", { name: /Exact invoice totals/ });
  await specCard.waitFor();
  assert.equal(await specCard.count(), 1, "one card per specification lineage");
  assert.match(await specCard.innerText(), /v2 · spc_v2/);
  assert.match(await stage("Intake").innerText(), /received/);
  assert.doesNotMatch(await stage("Intake").innerText(), /unknown/);
  await stage("Building").getByText("Abandoned spike").waitFor();
  assert.match(await stage("Delivery").innerText(), /Exact invoice totals/);

  console.log("Read-only inspector");
  await stage("Intake").getByRole("button", { name: /Customer request/ }).click();
  await inspector.getByText("received", { exact: true }).waitFor();
  await closeInspector();
  await specCard.click();
  await inspector.getByText("v2 · spc_v2").waitFor();
  const submit = inspector.getByRole("button", { name: "Submit for review" });
  const approve = inspector.getByRole("button", { name: "Approve specification" });
  assert.equal(await submit.isDisabled(), true);
  assert.match(await submit.getAttribute("title"), /Unlock operator controls/);
  await inspector.getByText("Unlock operator controls under Connections first.").first().waitFor();
  const questions = inspector.locator(".question");
  await questions.first().waitFor();
  assert.equal(await questions.count(), 2);
  assert.match(await questions.nth(0).innerText(), /blocking[\s\S]*Round half up/);
  assert.doesNotMatch(await questions.nth(0).innerText(), /non-blocking/);
  assert.match(await questions.nth(1).innerText(), /non-blocking[\s\S]*currency symbol/);
  assert.equal(await page.getByRole("button", { name: "Load clarification questions" }).count(), 0);
  await closeInspector();

  console.log("Gating");
  await access();
  await page.getByLabel("Heimdall operator code").fill("operator-test");
  await page.getByRole("button", { name: "Unlock controls", exact: true }).click();
  await page.getByText("Unlocked", { exact: true }).waitFor();
  await nav("Pipeline");
  await specCard.click();
  assert.equal(await submit.isDisabled(), true);
  assert.match(await submit.getAttribute("title"), /Pair with Sindri/);
  await closeInspector();
  await pair();
  await nav("Pipeline");
  await specCard.click();
  await inspector.getByText("I have reviewed the flagged source instructions").waitFor();
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await approve.isDisabled(), true);
  assert.match(await approve.getAttribute("title"), /Submit it for review/);

  console.log("Answer keeps the remaining questions");
  await questions.nth(0).getByRole("button", { name: "Use recommendation" }).click();
  await questions.nth(0).getByRole("button", { name: "Review answer" }).click();
  await send("Matches the ledger");
  await confirmed();
  await inspector.getByText("v3 · spc_v2x").waitFor();
  await inspector.getByText("I have reviewed the flagged source instructions").waitFor();
  assert.equal(await questions.count(), 1);
  assert.match(await questions.nth(0).innerText(), /currency symbol/);

  console.log("Timed-out submit");
  const submitPath = "/v1/specs/spc_v2x/submit";
  let submits = 0;
  source.intercept = async (req, res) => {
    if (req.url !== submitPath) return false;
    // The first attempt outlasts Heimdall's limit, then completes at the source.
    if (++submits === 1) return (await wait(1500), false);
    res.end(JSON.stringify({ spec: source.workflow.specs.find((s) => s.id === "spc_v2x") }));
    return true;
  };
  await submit.click();
  await send("Ready for review");
  await page.getByRole("alert").filter({ hasText: /may still be running/ }).waitFor();
  await wait(1200);
  await page.getByRole("button", { name: "Send to source" }).click();
  await confirmed();
  assert.equal(posts(submitPath), 2, "the resend was forwarded");
  const keys = source.requests.filter((r) => r.path === submitPath).map((r) => r.headers["idempotency-key"]);
  assert.equal(keys[0], keys[1], "the resend reused the idempotency key");
  source.intercept = null;

  console.log("Details survive a same-record command");
  const acknowledge = inspector.getByRole("checkbox");
  await acknowledge.waitFor();
  assert.equal(await submit.isDisabled(), true);
  assert.match(await approve.getAttribute("title"), /Acknowledge the flagged/);
  await acknowledge.check();
  assert.equal(await approve.isEnabled(), true);

  console.log("Stale pairing");
  const approvePath = "/v1/specs/spc_v2x/approve";
  source.intercept = (req, res) => {
    if (req.url !== approvePath) return false;
    res.writeHead(403);
    res.end('{"error":{"code":"approval_required","message":"approvals need a valid approval secret"}}');
    return true;
  };
  await approve.click();
  await send("Reviewed");
  await page.getByRole("alert").filter({ hasText: /Pair again/ }).waitFor();
  source.intercept = null;
  await page.getByRole("button", { name: "Go back" }).click();
  await inspector.getByText("Pair with Sindri under Connections first.").first().waitFor();
  assert.equal(await approve.isDisabled(), true);
  await closeInspector();
  await access();
  await page.getByText("Not paired", { exact: true }).waitFor();
  await pair();
  await nav("Pipeline");
  await stage("Review").getByRole("button", { name: /Exact invoice totals/ }).click();
  await acknowledge.check();
  await approve.click();
  await send("Reviewed");
  await confirmed();
  await inspector.getByText("approved", { exact: true }).first().waitFor();
  assert.equal(await inspector.getByRole("button", { name: "Propose implementation plan" }).isEnabled(), true);
  await closeInspector();

  console.log("Start lands on the run");
  await nav("New work");
  await page.getByRole("button", { name: /Plan v1/ }).click();
  await inspector.getByRole("button", { name: "Start approved plan" }).click();
  await send("Go");
  await confirmed();
  await page.getByRole("heading", { name: "Pipeline", exact: true }).waitFor();
  await inspector.waitFor({ state: "hidden" });

  console.log("Local delivery");
  await stage("Delivery").getByRole("button", { name: /Exact invoice totals/ }).click();
  await inspector.getByRole("heading", { name: "Exact invoice totals" }).waitFor();
  assert.equal(await inspector.getByRole("button", { name: "Request local export" }).isEnabled(), true);
  await inspector.getByRole("button", { name: "View local delivery" }).click();
  await inspector.getByText("git -C /example/invoice merge abc1234def", { exact: true }).waitFor();
  await inspector.getByText("git -C /example/invoice reset --hard base000", { exact: true }).waitFor();
  await inspector.getByText("Preview (may be shortened or altered for display)").waitFor();
  assert.equal(await page.getByRole("button", { name: /Download/ }).count(), 0);
  await closeInspector();

  console.log("Project filter survives the ID change");
  const filter = page.getByRole("combobox", { name: "Filter by project" });
  await filter.click();
  await page.getByRole("option", { name: "Ledger app" }).click();
  await stage("Specification").getByRole("button", { name: /Ledger export/ }).waitFor();
  assert.equal(await stage("Specification").getByRole("button").count(), 1);
  source.data.projects.push({ id: "prj_ledger", name: "ledger", repoPath: "/example/ledger" });
  await app.hub.refresh();
  await wait(600);
  assert.match(await filter.innerText(), /Ledger app/);
  assert.equal(await stage("Specification").getByRole("button", { name: /Ledger export/ }).count(), 1);

  console.log("Session loss");
  await page.evaluate(() =>
    fetch("/api/logout", {
      method: "POST",
      headers: { "x-heimdall-request": "1", "content-type": "application/json" },
      body: "{}",
    }),
  );
  await nav("Activity");
  await page.getByText("Your session ended. Sign in again.").waitFor();
  await page.getByLabel("Access token", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: latest versions, received intake, cancelled tasks, gated controls with reasons, inline questions, timeout resend, retained details, stale pairing, run start, local delivery, stable project filter and session loss.",
  );
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
