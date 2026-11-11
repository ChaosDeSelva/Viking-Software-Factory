// Browser checks for the specification, plan and delivery workflow against fixture Sindri records.
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { until, wait } from "./support.mjs";
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
  intakes: [
    { id: "int_1", projectId: "prj_demo", title: "Customer request", body: "Please fix totals" },
    // An imported ticket without a description: Sindri stores an empty body.
    { id: "int_blank", projectId: "prj_demo", title: "Ticket without description", body: "" },
  ],
  deliveries: [{ id: "exe_demo", executionId: "exe_demo", projectId: "prj_demo", status: "verified_pending_review" }],
  meta: { ln_a: { untrustedInstructionDetected: true } },
  local: {
    baseSha: "base000",
    resultCommit: "abc1234def",
    patch: "diff --git a/total.js b/total.js\n+const key = 'sk-abcdefghijklmnop1234';\n",
    repoPath: "/example/invoice",
    apply: "git -C /example/invoice merge abc1234def",
    undo: "git -C /example/invoice reset --hard base000",
    followUp: { baseSha: "mid1111", patch: "diff --git a/round.js b/round.js\n+Bearer abcdefghijklmnop1234\n" },
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
// Known to Mimir only, so it has no Sindri record to hold a profile.
source.data.projects.push({ id: "prj_solo", name: "Solo tools", repoPath: "/example/solo" });
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
const TABS = ["Overview", "Pipeline", "Crews & agents", "Execution graph", "Activity", "Quality & approvals", "Autonomy"];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Project pages are top-bar links, global pages bottom-bar links; a count may follow the label.
const nav = async (name) => {
  if (name === "New work") await page.getByRole("banner").getByRole("button", { name: "New work" }).click();
  else
    await page
      .getByRole("navigation", { name: TABS.includes(name) ? "Project pages" : "Global pages", exact: true })
      .getByRole("link", { name: new RegExp(`^${escape(name)}( \\d+)?$`) })
      .click();
  await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
};
const stage = (name) => page.getByRole("region", { name: `${name} stage, scroll for more items` });
const status = (scope, label) => scope.getByRole("img", { name: `Status: ${label}`, exact: true });
const inspector = page.getByRole("dialog").filter({ hasText: "inspector" });
const closeInspector = async () => {
  await inspector.getByRole("button", { name: "Close", exact: true }).click();
  await inspector.waitFor({ state: "hidden" });
};
// A blocked action stays focusable (aria-disabled) and names its reason in its description.
const unavailable = async (button) => (await button.getAttribute("aria-disabled")) === "true";
const reasonOf = (button) =>
  button.evaluate((b) => document.getElementById(b.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
const commandDialog = page.getByRole("dialog").filter({ hasText: "This request changes the owning service" });
const send = async (reason) => {
  await commandDialog.getByLabel("Reason", { exact: true }).fill(reason);
  await commandDialog.getByRole("button", { name: "Send to source" }).click();
};
const confirmed = async () => {
  await commandDialog.waitFor({ state: "hidden" });
  await page.getByText("Source confirmed the request. Current state is shown.").first().waitFor();
};
const access = async () => {
  await nav("Connections");
  await page.getByRole("tab", { name: "Access", exact: true }).click();
};
const pair = async () => {
  await access();
  await page.getByLabel("Sindri pairing code", { exact: true }).fill("sindri-code");
  await page.getByRole("button", { name: "Pair approval session" }).click();
  await status(page.getByRole("main"), "Paired").waitFor();
};
const readDownload = async (button) => {
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return [download.suggestedFilename(), Buffer.concat(chunks).toString("utf8")];
};
const projectRow = (name) => page.getByRole("row").filter({ hasText: name });
const openProfile = async (name) => {
  await nav("Projects");
  await projectRow(name).getByRole("button", { name: "Execution profile" }).click();
  await inspector.getByRole("heading", { name: "Execution profile" }).waitFor();
};
const runs = page.getByRole("region", { name: "Runs", exact: true }).first();
const review = inspector.getByRole("button", { name: "Review profile change" });
const posts = (path) =>
  source.requests.filter((r) => r.method === "POST" && r.path === path).length;
const lastPost = (path) =>
  JSON.parse(source.requests.findLast((r) => r.method === "POST" && r.path === path).body);
try {
  console.log("Pipeline lists");
  await page.goto(app.url);
  await page.getByLabel("Access token", { exact: true }).fill("test-workflow");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
  await nav("Pipeline");
  const specCard = stage("Specification").getByRole("button", { name: /Exact invoice totals/ });
  await specCard.waitFor();
  assert.equal(await specCard.count(), 1, "one card per specification lineage");
  assert.match(await specCard.innerText(), /v2 · spc_v2/);
  await status(stage("Intake"), "Received").first().waitFor();
  assert.doesNotMatch(await stage("Intake").innerText(), /unknown/i);
  await stage("Building").getByText("Abandoned spike").waitFor();
  assert.match(await stage("Delivery").innerText(), /Exact invoice totals/);

  console.log("Read-only inspector");
  await stage("Intake").getByRole("button", { name: /Customer request/ }).click();
  await status(inspector, "Received").waitFor();
  await closeInspector();
  await specCard.click();
  await inspector.getByText("v2 · spc_v2").waitFor();
  const submit = inspector.getByRole("button", { name: "Submit for review" });
  const approve = inspector.getByRole("button", { name: "Approve specification" });
  assert.equal(await unavailable(submit), true);
  assert.match(await reasonOf(submit), /Unlock operator controls/);
  // The reason is the button's description (a hidden node read via aria-describedby), not text.
  await inspector.getByText("Unlock operator controls under Connections first.", { exact: true }).first().waitFor({ state: "attached" });
  const questions = inspector.locator(".question");
  await questions.first().waitFor();
  assert.equal(await questions.count(), 2);
  assert.match(await questions.nth(0).innerText(), /Blocking[\s\S]*Round half up/);
  assert.doesNotMatch(await questions.nth(0).innerText(), /Non-blocking/i);
  assert.match(await questions.nth(1).innerText(), /Non-blocking[\s\S]*currency symbol/i);
  assert.equal(await page.getByRole("button", { name: "Load clarification questions" }).count(), 0);
  await closeInspector();
  await openProfile("Invoice library");
  await inspector.getByText("No checks set: plans use the built-in checks, which assume a Node project.").first().waitFor();
  await inspector.getByText("Edit execution profile").click();
  assert.equal(await unavailable(review), true);
  assert.match(await reasonOf(review), /Unlock operator controls/);
  await closeInspector();
  await openProfile("Solo tools");
  await inspector.getByText(/A profile needs the project registered in Sindri/).waitFor();
  assert.equal(await review.count(), 0);
  await closeInspector();

  console.log("Gating");
  await access();
  await page.getByLabel("Heimdall operator code", { exact: true }).fill("operator-test");
  await page.getByRole("button", { name: "Unlock controls" }).click();
  await page.getByRole("button", { name: "Session: Operator unlocked" }).waitFor();
  await nav("Pipeline");
  await specCard.click();
  assert.equal(await unavailable(submit), true);
  assert.match(await reasonOf(submit), /Pair with Sindri/);
  await closeInspector();
  await pair();
  await nav("Pipeline");
  await specCard.click();
  await inspector.getByText("I have reviewed the flagged source instructions").waitFor();
  assert.equal(await unavailable(submit), false);
  assert.equal(await unavailable(approve), true);
  assert.match(await reasonOf(approve), /Submit it for review/);

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
  await page.getByRole("alert").filter({ hasText: /may still be running/ }).first().waitFor();
  // Resend once the first attempt has completed at the source.
  await until(() => source.workflow.specs.find((s) => s.id === "spc_v2x").status === "review", "the slow submit");
  await commandDialog.getByRole("button", { name: "Send to source" }).click();
  await confirmed();
  assert.equal(posts(submitPath), 2, "the resend was forwarded");
  const keys = source.requests.filter((r) => r.path === submitPath).map((r) => r.headers["idempotency-key"]);
  assert.equal(keys[0], keys[1], "the resend reused the idempotency key");
  source.intercept = null;

  console.log("Details survive a same-record command");
  const acknowledge = inspector.getByRole("checkbox");
  await acknowledge.waitFor();
  assert.equal(await unavailable(submit), true);
  assert.match(await reasonOf(approve), /Acknowledge the flagged/);
  await acknowledge.check();
  assert.equal(await unavailable(approve), false);

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
  await commandDialog.getByRole("alert").filter({ hasText: /Pair again/ }).first().waitFor();
  source.intercept = null;
  await commandDialog.getByRole("button", { name: "Go back" }).click();
  await inspector.getByText("Pair with Sindri under Connections first.").first().waitFor({ state: "attached" });
  assert.equal(await unavailable(approve), true);
  assert.match(await reasonOf(approve), /Pair with Sindri/);
  await closeInspector();
  await access();
  await status(page.getByRole("main"), "Not paired").waitFor();
  await pair();
  await nav("Pipeline");
  await stage("Review").getByRole("button", { name: /Exact invoice totals/ }).click();
  await acknowledge.check();
  await approve.click();
  await send("Reviewed");
  await confirmed();
  await status(inspector, "Approved").waitFor();
  assert.equal(await unavailable(inspector.getByRole("button", { name: "Propose implementation plan" })), false);
  await closeInspector();

  console.log("Start lands on the run");
  await nav("New work");
  await page.getByRole("button", { name: /Plan v1/ }).click();
  await inspector.getByRole("button", { name: "Start approved plan" }).click();
  await send("Go");
  await confirmed();
  await page.getByRole("heading", { level: 1, name: "Pipeline", exact: true }).waitFor();
  await inspector.waitFor({ state: "hidden" });

  console.log("Local delivery");
  await stage("Delivery").getByRole("button", { name: /Exact invoice totals/ }).click();
  await inspector.getByRole("heading", { name: "Exact invoice totals" }).waitFor();
  assert.equal(await unavailable(inspector.getByRole("button", { name: "Request local export" })), false);
  await inspector.getByRole("button", { name: "View local delivery" }).click();
  await inspector.getByText("git -C /example/invoice merge abc1234def", { exact: true }).waitFor();
  await inspector.getByText("git -C /example/invoice reset --hard base000", { exact: true }).waitFor();
  assert.deepEqual(await readDownload(inspector.getByRole("button", { name: "Download result.patch" })), [
    "result.patch",
    source.workflow.local.patch,
  ]);
  assert.deepEqual(await readDownload(inspector.getByRole("button", { name: "Download follow-up.patch" })), [
    "follow-up.patch",
    source.workflow.local.followUp.patch,
  ]);
  const delivered = await inspector.innerText();
  const followUpAt = delivered.indexOf("Follow-up only — use this if you already applied the earlier delivery");
  assert.ok(followUpAt > 0 && followUpAt < delivered.indexOf("Full patch"), "the follow-up comes first");
  assert.doesNotMatch(delivered, /Preview/);
  await closeInspector();

  console.log("Execution profile");
  await openProfile("Invoice library");
  await inspector.getByText("Edit execution profile").click();
  assert.match(await reasonOf(review), /Change the profile first/);
  await inspector.getByRole("button", { name: "Add check" }).click();
  assert.equal(await unavailable(review), true);
  await inspector.getByLabel("ID", { exact: true }).fill("test");
  await inspector.getByLabel("Command", { exact: true }).fill("make test 'two words' | tee");
  await inspector.getByText('["make","test","two words","|","tee"]').waitFor();
  await inspector.getByText(/Run directly, not through a shell/).waitFor();
  await inspector.getByLabel(/^Working directory/).fill("src/app");
  await inspector.getByLabel(/^Timeout in seconds/).fill("900");
  assert.equal(await inspector.getByLabel("Required: work does not pass").isChecked(), true);
  await inspector.getByRole("button", { name: "Add variable" }).click();
  await inspector.getByLabel("Name", { exact: true }).fill("GIT_DIR");
  await inspector.getByLabel("Value", { exact: true }).fill("/cache/go-build");
  await inspector.getByText("Environment variable GIT_DIR cannot be set from a profile.").first().waitFor();
  assert.equal(await unavailable(review), true);
  await inspector.getByLabel("Name", { exact: true }).fill("GOCACHE");
  await inspector.getByLabel(/^PATH additions/).fill("/opt/shims\n/opt/go/bin");
  await inspector.getByLabel(/^Writable directories/).fill("/cache/go-build");
  await inspector.getByLabel("Allow network access").check();
  await inspector.getByText(/lets commands run by the agent reach the network/).waitFor();
  await inspector.getByLabel(/^Verification timeout in minutes/).fill("45");
  await review.click();
  await send("Go project checks");
  await confirmed();
  await inspector.getByText("Checks are installed as harness sindri-fixture-1a2b3c4d.").waitFor();
  const savedProfile = {
    checks: [{ id: "test", command: ["make", "test", "two words", "|", "tee"], cwd: "src/app", timeoutSeconds: 900 }],
    env: { GOCACHE: "/cache/go-build" },
    pathPrepend: ["/opt/shims", "/opt/go/bin"],
    codexSandbox: { writableRoots: ["/cache/go-build"], networkAccess: true },
    verificationTimeoutMs: 2700000,
  };
  assert.deepEqual(source.profiles.prj_demo, savedProfile);
  const put = source.requests.find((r) => r.method === "PUT");
  assert.equal(put.path, "/v1/projects/prj_demo/profile");
  assert.equal(put.headers["x-sindri-approval"], "sindri-human-secret");
  // The form now shows what Sindri stored, so there is nothing to send.
  assert.equal(await inspector.getByLabel("Command", { exact: true }).inputValue(), "make test 'two words' | tee");
  assert.match(await reasonOf(review), /Change the profile first/);
  await inspector.getByRole("button", { name: "Remove check 1" }).click();
  await review.click();
  await send("Back to the built-in checks");
  await confirmed();
  await inspector.getByText("No checks set: plans use the built-in checks, which assume a Node project.").first().waitFor();
  const { checks: _removed, ...withoutChecks } = savedProfile;
  assert.deepEqual(source.profiles.prj_demo, withoutChecks);
  await closeInspector();

  console.log("Escalations end with their run");
  source.execution.tasks = [{ planTaskId: "build", escalation: { reason: "Gate failed twice" } }];
  source.execution.execution.status = "running";
  await app.hub.refresh();
  await nav("Quality & approvals");
  const escalation = page.getByRole("button", { name: "build · Human decision needed" });
  await escalation.click();
  const retryTask = inspector.getByRole("button", { name: /^Retry\b/ });
  assert.equal(await unavailable(retryTask), false);
  source.execution.execution.status = "failed";
  await app.hub.refresh();
  await inspector.getByText(/its escalations can no longer be resolved/).first().waitFor({ state: "attached" });
  assert.equal(await unavailable(retryTask), true);
  assert.match(await reasonOf(retryTask), /status is failed/);
  await closeInspector();
  await escalation.waitFor({ state: "hidden" });
  source.execution.tasks = [];
  source.execution.execution.status = "verified_pending_review";
  await app.hub.refresh();

  console.log("Cancel a run");
  await nav("Pipeline");
  await runs.getByRole("button", { name: /Exact invoice totals/ }).click();
  const cancelRun = inspector.getByRole("button", { name: /^Cancel run\b/ });
  assert.equal(await unavailable(cancelRun), true);
  assert.match(await reasonOf(cancelRun), /This run has ended/);
  source.execution.execution.status = "running";
  await app.hub.refresh();
  await inspector.getByText(/Cancelling stops the run for good/).waitFor();
  assert.equal(await unavailable(cancelRun), false);
  await cancelRun.click();
  await send("Wrong plan");
  await confirmed();
  await inspector.waitFor({ state: "hidden" });
  await runs.getByText("ended without a delivery").waitFor();
  await status(runs, "Cancelled").waitFor();
  assert.match(await runs.innerText(), /0 in progress · 1 failed or cancelled/);
  const cancelPost = source.requests.find((r) => r.path === "/v1/executions/exe_demo/cancel");
  assert.deepEqual(JSON.parse(cancelPost.body), { reason: "Wrong plan" });
  await runs.getByRole("button", { name: /Exact invoice totals/ }).click();
  assert.equal(await unavailable(cancelRun), true);
  assert.match(await reasonOf(cancelRun), /status is cancelled/);
  await closeInspector();

  console.log("Intake to a cancelled run");
  source.workflow.authoring = true;
  await nav("New work");
  await page.getByLabel("Intake title", { exact: true }).fill("Footer totals");
  await page.getByLabel("Request", { exact: true }).fill("Show the invoice total in the footer");
  await page.getByRole("button", { name: "Save intake" }).click();
  await send("Customer asked");
  await confirmed();
  assert.deepEqual(lastPost("/v1/intakes"), {
    projectId: "prj_demo",
    title: "Footer totals",
    body: "Show the invoice total in the footer",
  });
  await inspector.getByRole("heading", { name: "Footer totals" }).waitFor();
  await inspector.getByRole("button", { name: "Draft specification from intake" }).click();
  await send("Draft it");
  await confirmed();
  assert.deepEqual(lastPost("/v1/director/draft"), {
    projectId: "prj_demo",
    intakeId: "int_new01",
    request: "Show the invoice total in the footer",
  });
  await inspector.getByText("v1 · spc_new02").waitFor();
  assert.equal(await questions.count(), 1);
  await questions.first().getByRole("button", { name: "Use recommendation" }).click();
  assert.equal(await questions.first().getByLabel("Your answer").inputValue(), "Only the totals module");
  await questions.first().getByRole("button", { name: "Review answer" }).click();
  await send("The recommendation fits");
  await confirmed();
  assert.deepEqual(lastPost("/v1/specs/spc_new02/answer"), {
    questionId: "q-scope",
    answer: "Only the totals module",
  });
  await inspector.getByText("v2 · spc_new02x").waitFor();
  assert.equal(await questions.count(), 0);
  await submit.click();
  await send("Ready");
  await confirmed();
  await status(inspector, "In review").waitFor();
  await approve.click();
  await send("Looks right");
  await confirmed();
  await status(inspector, "Approved").waitFor();
  await inspector.getByRole("button", { name: "Propose implementation plan" }).click();
  await send("Plan it");
  await confirmed();
  assert.deepEqual(lastPost("/v1/plans/propose"), { specId: "spc_new02x" });
  await inspector.getByText("v1 · pln_new03").waitFor();
  const approvePlan = inspector.getByRole("button", { name: /^Approve plan\b/ });
  assert.equal(await unavailable(approvePlan), true);
  await submit.click();
  await send("Ready");
  await confirmed();
  await approvePlan.click();
  await send("Good plan");
  await confirmed();
  await status(inspector, "Approved").waitFor();
  await inspector.getByRole("button", { name: "Start approved plan" }).click();
  await send("Go");
  await confirmed();
  assert.deepEqual(lastPost("/v1/executions"), { planId: "pln_new03" });
  await page.getByRole("heading", { level: 1, name: "Pipeline", exact: true }).waitFor();
  await inspector.waitFor({ state: "hidden" });
  const newRun = runs.getByRole("button", { name: /Drafted: Show the invoice total/ });
  await newRun.click();
  await inspector.getByText(/Cancelling stops the run for good/).waitFor();
  await cancelRun.click();
  await send("No longer needed");
  await confirmed();
  assert.deepEqual(lastPost("/v1/executions/exe_new04/cancel"), { reason: "No longer needed" });
  await inspector.waitFor({ state: "hidden" });
  await runs.getByText("0 in progress · 2 failed or cancelled").waitFor();
  await newRun.click();
  assert.match(await reasonOf(cancelRun), /status is cancelled/);
  await closeInspector();

  console.log("An intake without a description is drafted from its title");
  await stage("Intake").getByRole("button", { name: /Ticket without description/ }).click();
  await inspector.getByRole("button", { name: "Draft specification from intake" }).click();
  await send("Draft from the ticket title");
  await confirmed();
  assert.deepEqual(lastPost("/v1/director/draft"), {
    projectId: "prj_demo",
    intakeId: "int_blank",
    request: "Ticket without description",
  });
  await inspector.getByText("v1 · spc_new05").waitFor();
  await closeInspector();

  console.log("Request changes to a delivery");
  await stage("Delivery").getByRole("button", { name: /Exact invoice totals/ }).click();
  await inspector.getByText("Request changes to this delivery").click();
  const reviewChanges = inspector.getByRole("button", { name: "Review change request" });
  assert.equal(await unavailable(reviewChanges), true);
  await inspector.getByLabel("What should change").fill("  Round per line, not per invoice  ");
  await reviewChanges.click();
  await send("Reviewer feedback");
  await confirmed();
  assert.deepEqual(lastPost("/v1/deliveries/exe_demo/rework"), {
    feedback: "Round per line, not per invoice",
  });
  await inspector.getByText("v1 · spc_new07").waitFor();
  assert.match(await inspector.innerText(), /Drafted: Round per line/);
  await closeInspector();

  console.log("Autonomy (all): steward and modes");
  const stamp = (n) => `2026-11-0${n}T10:00:00.000Z`;
  const decisionRow = (id, over) => ({
    id, projectId: "prj_demo", type: "spec.answer",
    subject: { kind: "question", id: "q-" + id, label: id },
    inputs: [], recommendation: { value: "" }, reasoning: "", confidence: 0.5, mode: "recommend",
    status: "pending", outcome: null, reversible: false, notes: [], createdAt: stamp(1), decidedAt: null,
    ...over,
  });
  source.steward = {
    running: true,
    types: [
      { type: "spec.answer", mode: "recommend", autoAllowed: true, stats: { decided: 12, accepted: 9, changed: 2, rejected: 1, rolledBack: 0, autoApplied: 0, accuracy: 0.92 } },
      { type: "spec.approve", mode: "recommend", autoAllowed: false, stats: { decided: 3, accepted: 3, changed: 0, rejected: 0, rolledBack: 0, autoApplied: 0, accuracy: null } },
      { type: "brand.new", mode: "turbo", autoAllowed: false, stats: {} },
    ],
    decisions: [
      decisionRow("dec_answer", {
        subject: { kind: "question", id: "q-hard", label: "Rounding rule" },
        recommendation: { value: "Round half to even", detail: "Matches the ledger module" },
        reasoning: "The ledger module already rounds half to even.",
        confidence: 0.87,
        inputs: [
          { kind: "lesson", ref: "fg:l1", summary: "Keep integer cents" },
          { kind: "hunch", ref: "x1", summary: "An input kind this page does not know" },
        ],
        createdAt: stamp(5),
      }),
      decisionRow("dec_approve", { type: "spec.approve", subject: { kind: "spec", id: "spc_v2", label: "Approve totals spec" }, recommendation: { value: "approve" }, createdAt: stamp(4) }),
      decisionRow("dec_fix", { type: "escalation.resolve", subject: { kind: "task", id: "build", label: "Retry the build" }, recommendation: { value: "retry" }, status: "applied", mode: "auto", reversible: true, createdAt: stamp(3) }),
      decisionRow("dec_odd", { type: "brand.new", subject: { kind: "plan", id: "p", label: "Odd one" }, status: "mystery", createdAt: stamp(2) }),
    ],
    notes: [],
  };
  source.feedbackGraph = {
    status: { configured: true, enabled: true, url: "http://127.0.0.1:8787", reachable: true, error: null },
    projects: {
      prj_demo: {
        auto: "invoice-lib",
        link: { projectKey: "invoice-lib", source: "auto" },
        lessons: [{ id: "l1", title: "Keep integer cents", rule: "Never use floats for money", appliesWhen: "Touching totals", paths: ["src/total.js"], status: "approved" }],
        error: null,
      },
    },
  };
  await nav("Autonomy (all)");
  await page.getByText("The steward is looking at new work").waitFor();
  const modes = (name) => page.getByRole("radiogroup", { name: "Mode for " + name, exact: true });
  const typeRow = (type) => page.getByRole("row").filter({ has: page.getByText(type, { exact: true }) });
  await modes("Answer specification questions").waitFor();
  assert.match(await typeRow("spec.answer").innerText(), /92%[\s\S]*9 \/ 2 \/ 1/);
  const approveAuto = modes("Approve specifications").getByRole("radio", { name: "Automatic" });
  assert.equal(await approveAuto.isDisabled(), true);
  await page.getByText("Approvals are never automatic; they can only be recommended.").first().waitFor();
  // An unknown type and mode are shown as sent, and the unknown type cannot go automatic.
  await typeRow("brand.new").getByText("turbo", { exact: true }).waitFor();
  assert.equal(await modes("brand.new").getByRole("radio", { name: "Automatic" }).isDisabled(), true);
  await modes("Answer specification questions").getByRole("radio", { name: "Automatic" }).click();
  await send("Track record is good");
  await confirmed();
  const modePut = source.requests.findLast((r) => r.method === "PUT" && r.path === "/v1/steward/modes");
  assert.deepEqual(JSON.parse(modePut.body), { type: "spec.answer", mode: "auto" });
  assert.equal(modePut.headers["x-sindri-approval"], "sindri-human-secret");
  await modes("Answer specification questions").getByRole("radio", { name: "Automatic", checked: true }).waitFor();

  await page.getByRole("button", { name: "Pause steward" }).click();
  await send("Quiet period");
  await confirmed();
  await page.getByRole("button", { name: "Resume steward" }).waitFor();
  await page.getByText(/The steward is paused/).waitFor();
  assert.equal(source.steward.running, false);
  assert.equal(source.requests.findLast((r) => r.path === "/v1/steward/pause").headers["x-sindri-approval"], undefined);

  console.log("Autonomy: decision log");
  await nav("Autonomy");
  const detail = page.locator(".decision-detail");
  const decisionButton = (name) => page.getByRole("button", { name });
  await decisionButton(/Odd one/).click();
  await detail.getByText("mystery", { exact: true }).first().waitFor();
  await decisionButton(/Rounding rule/).click();
  await detail.getByText("The ledger module already rounds half to even.").waitFor();
  await detail.getByText("Keep integer cents").waitFor();
  await detail.getByText("hunch", { exact: true }).waitFor();
  assert.match(await detail.innerText(), /87%/);
  const rollback = detail.getByRole("button", { name: /^Roll back\b/ });
  assert.equal(await unavailable(rollback), true);
  assert.match(await reasonOf(rollback), /cannot be reversed/);
  const answerBox = detail.getByLabel("Answer to send");
  assert.equal(await answerBox.inputValue(), "Round half to even");
  await answerBox.fill("Round half up");
  await detail.getByRole("button", { name: "Accept with my answer" }).click();
  await send("Finance prefers half up");
  await confirmed();
  assert.deepEqual(lastPost("/v1/steward/decisions/dec_answer/accept"), { value: "Round half up" });
  assert.equal(source.requests.findLast((r) => r.path === "/v1/steward/decisions/dec_answer/accept").headers["x-sindri-approval"], undefined);
  // Accepted with an edited answer: docs label "Changed".
  await status(detail, "Changed").waitFor();
  assert.equal(await unavailable(detail.getByRole("button", { name: /^Accept/ })), true);

  await detail.getByLabel("Note on this decision").fill("Finance owns rounding");
  await detail.getByRole("button", { name: "Add note" }).click();
  await send("Context for later");
  await confirmed();
  assert.deepEqual(lastPost("/v1/steward/decisions/dec_answer/notes"), { text: "Finance owns rounding" });
  await detail.getByText("Finance owns rounding").waitFor();

  await decisionButton(/Approve totals spec/).click();
  await detail.getByText(/performs the approval itself/).waitFor();
  assert.equal(await unavailable(detail.getByRole("button", { name: "Accept and approve" })), false);
  await detail.getByRole("button", { name: "Reject" }).click();
  await send("Not ready yet");
  await confirmed();
  assert.deepEqual(lastPost("/v1/steward/decisions/dec_approve/reject"), { reason: "Not ready yet" });
  await status(detail, "Rejected").waitFor();

  await decisionButton(/Retry the build/).click();
  await detail.getByText(/Retry the build · task/).waitFor();
  assert.equal(await unavailable(rollback), false);
  // Sindri has the last word: a refused rollback is reported and nothing changes.
  source.intercept = (req, res) => {
    if (!req.url.endsWith("/rollback")) return false;
    res.writeHead(409);
    res.end('{"error":{"code":"invalid_state","message":"the retry already finished and cannot be undone"}}');
    return true;
  };
  await rollback.click();
  await send("Wrong call");
  await commandDialog.getByRole("alert").filter({ hasText: /cannot be undone/ }).first().waitFor();
  source.intercept = null;
  await commandDialog.getByRole("button", { name: "Go back" }).click();
  assert.equal(source.steward.decisions.find((d) => d.id === "dec_fix").status, "applied");
  await rollback.click();
  await send("Wrong call");
  await confirmed();
  assert.deepEqual(lastPost("/v1/steward/decisions/dec_fix/rollback"), { reason: "Wrong call" });
  await status(detail, "Rolled back").waitFor();
  assert.equal(await unavailable(rollback), true);

  const noteButton = page.getByRole("button", { name: /^Review note\b/ });
  assert.equal(await unavailable(noteButton), true);
  assert.match(await reasonOf(noteButton), /^Write the note first\.$/);
  await page.getByLabel("New note", { exact: true }).fill("Prefer small plans");
  await noteButton.click();
  await send("Guidance");
  await confirmed();
  assert.deepEqual(lastPost("/v1/steward/notes"), { projectId: null, text: "Prefer small plans" });
  await page.getByLabel("Notes").last().getByText("Prefer small plans").waitFor();

  const statusFilter = page.getByRole("combobox", { name: "Decision status" });
  await statusFilter.click();
  await page.getByRole("option", { name: "Rolled back" }).click();
  await page.getByText("1 shown", { exact: true }).waitFor();
  assert.equal(await decisionButton(/Rounding rule/).count(), 0);
  await decisionButton(/Retry the build/).waitFor();

  // The populated page, with a decision open, passes the same checks as the other pages.
  await decisionButton(/Retry the build/).click();
  await detail.getByText(/Retry the build · task/).waitFor();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(axe.violations.map((v) => [v.id, v.nodes.map((n) => n.target)]), [], `Autonomy at ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Autonomy overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });

  console.log("Feedback Graph");
  await openProfile("Invoice library");
  await inspector.getByRole("heading", { name: /^Feedback Graph/ }).waitFor();
  await status(inspector, "Linked automatically").waitFor();
  await inspector.getByText("invoice-lib", { exact: true }).waitFor();
  await inspector.getByText("Never use floats for money").waitFor();
  await inspector.getByText("Applies when: Touching totals").waitFor();
  const clearLink = inspector.getByRole("button", { name: /^Clear override\b/ });
  assert.equal(await unavailable(clearLink), true);
  await inspector.getByText("There is no operator override to clear.").first().waitFor({ state: "attached" });
  await inspector.getByLabel("Feedback Graph project key").fill("demo-app");
  await inspector.getByRole("button", { name: "Review link override" }).click();
  await send("Different key in Feedback Graph");
  await confirmed();
  const linkPut = source.requests.findLast((r) => r.method === "PUT" && r.path === "/v1/projects/prj_demo/feedback-graph");
  assert.deepEqual(JSON.parse(linkPut.body), { projectKey: "demo-app" });
  await status(inspector, "Linked by you").waitFor();
  await inspector.getByText("demo-app", { exact: true }).waitFor();
  await clearLink.click();
  await send("Back to automatic");
  await confirmed();
  await status(inspector, "Linked automatically").waitFor();
  assert.equal(JSON.parse(source.requests.findLast((r) => r.method === "PUT" && r.path === "/v1/projects/prj_demo/feedback-graph").body).projectKey, null);
  await closeInspector();
  await nav("Connections");
  await page.getByRole("tab", { name: "Services", exact: true }).click();
  await page.getByText("Sindri reaches Feedback Graph at http://127.0.0.1:8787.").first().waitFor();
  await nav("Pipeline");

  console.log("Project filter survives the ID change");
  const picker = page.getByRole("banner").getByRole("button", { name: /^Project:/ });
  await picker.click();
  await page.getByRole("option", { name: /Ledger app/ }).click();
  await stage("Specification").getByRole("button", { name: /Ledger export/ }).waitFor();
  assert.equal(await stage("Specification").getByRole("button").count(), 1);
  source.data.projects.push({ id: "prj_ledger", name: "ledger", repoPath: "/example/ledger" });
  await app.hub.refresh();
  // Nothing should change, so there is no condition to wait on: give the snapshot time to land.
  await wait(600);
  assert.match(await picker.innerText(), /Ledger app/);
  assert.equal(await stage("Specification").getByRole("button", { name: /Ledger export/ }).count(), 1);

  console.log("Session expiry");
  // The browser drops the session cookie when its lifetime ends; the next request is refused.
  await context.clearCookies();
  await page.getByRole("navigation", { name: "Project pages" }).getByRole("link", { name: "Activity" }).click();
  await page.getByText("Your session ended. Sign in again.").waitFor();
  await page.getByLabel("Access token", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);

  console.log("Session loss");
  await page.getByLabel("Access token", { exact: true }).fill("test-workflow");
  await page.getByRole("button", { name: "Connect to factory" }).click();
  await page.getByRole("navigation", { name: "Project pages" }).waitFor();
  assert.equal(await page.getByText("Your session ended. Sign in again.").count(), 0);
  // Signing out elsewhere ends this page's event stream, which returns it to sign-in.
  await page.evaluate(() =>
    fetch("/api/logout", {
      method: "POST",
      headers: { "x-heimdall-request": "1", "content-type": "application/json" },
      body: "{}",
    }),
  );
  await page.getByText("Your session ended. Sign in again.").waitFor();
  await page.getByLabel("Access token", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: latest versions, received intake, cancelled tasks, gated controls with reasons, inline questions, timeout resend, retained details, stale pairing, run start, exact patch downloads, execution profile, escalations of ended runs, run cancel, intake to cancelled run, blank intake draft, delivery change request, Autonomy (all) (modes, pause) and Autonomy decision log (accept with edit, note, reject, refused and allowed rollback, global note, filters), Feedback Graph link and status, stable project filter, session expiry and session loss.",
  );
} finally {
  await browser.close();
  await app.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
}
