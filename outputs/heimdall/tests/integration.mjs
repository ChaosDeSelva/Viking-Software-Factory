import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const { buildServer: buildMimir } = await import(
  new URL(
    "../../../work/ecosystem/mimir/apps/server/dist/index.js",
    import.meta.url,
  )
);
const { openEventStore } = await import(
  new URL(
    "../../../work/ecosystem/mimir/packages/core/dist/index.js",
    import.meta.url,
  )
);
const { FakeRuntime } = await import(
  new URL(
    "../../../work/ecosystem/mimir/packages/fake-runtime/dist/index.js",
    import.meta.url,
  )
);
const { buildServer: buildSindri } = await import(
  new URL(
    "../../../work/ecosystem/sindri/apps/server/dist/app.js",
    import.meta.url,
  )
);
const { openDatabase } = await import(
  new URL(
    "../../../work/ecosystem/sindri/packages/knowledge/dist/index.js",
    import.meta.url,
  )
);
const { FakeProvider } = await import(
  new URL(
    "../../../work/ecosystem/sindri/packages/director/dist/index.js",
    import.meta.url,
  )
);
const { demoPlanResponder } = await import(
  new URL(
    "../../../work/ecosystem/sindri/apps/server/dist/demo-plan-responder.js",
    import.meta.url,
  )
);
const { writeDemoRepo, DEMO_TICKET } = await import(
  new URL(
    "../../../work/ecosystem/sindri/apps/server/dist/demo-repo.js",
    import.meta.url,
  )
);
const { SettingsStore } = await import(
  new URL(
    "../../../work/ecosystem/sindri/apps/server/dist/settings.js",
    import.meta.url,
  )
);
import { startHeimdall } from "../apps/server/main.mjs";
const root = mkdtempSync(join(tmpdir(), "heimdall-workflow-"));
let m, s, h, store, db, browser;
try {
  mkdirSync(join(root, "mimir"));
  store = openEventStore(join(root, "mimir/events.db"));
  m = buildMimir({
    store,
    ledger: store.commands,
    audit: store.audit,
    authToken: "mimir-test",
    runtime: new FakeRuntime(),
    dataDir: join(root, "mimir"),
    tickMs: 0,
  });
  await m.listen({ host: "127.0.0.1", port: 0 });
  db = openDatabase(join(root, "sindri.db"));
  s = buildSindri({
    db,
    dataDir: join(root, "sindri"),
    authToken: "sindri-test",
    providerFactory: () => new FakeProvider(demoPlanResponder()),
    secrets: { get: async () => "mimir-test" },
    approval: { pairingCode: "TESTC-0DE23" },
  });
  await s.listen({ host: "127.0.0.1", port: 0 });
  const settings = new SettingsStore(db, () => new Date());
  settings.put({
    ...settings.get(),
    provider: "fake",
    brokkrEnabled: true,
    mimirUrl: m.listeningOrigin,
    mimirTokenSecret: "test.token",
  });
  h = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: join(root, "heimdall"),
      HEIMDALL_TOKEN: "heimdall-test",
      MIMIR_URL: m.listeningOrigin,
      MIMIR_TOKEN: "mimir-test",
      SINDRI_URL: s.listeningOrigin,
      SINDRI_TOKEN: "sindri-test",
    },
    operatorCode: "operator",
  });
  let cookie = "";
  const call = async (path, b) => {
    const r = await fetch(h.url + "/api/" + path, {
      method: b ? "POST" : "GET",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-heimdall-request": "1",
        "idempotency-key": crypto.randomUUID(),
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
    if (path === "login") cookie = r.headers.get("set-cookie").split(";")[0];
    const data = await r.json();
    assert.ok(r.ok, path + ": " + JSON.stringify(data));
    return data;
  };
  const cmd = async (action, id = "new", body = {}) =>
    (
      await call("commands", {
        action,
        id,
        body,
        reason: "Isolated workflow acceptance",
      })
    ).result;
  await call("login", { token: "heimdall-test" });
  await call("unlock", { code: "operator" });
  await call("pair", { code: "TESTC-0DE23" });
  const repo = writeDemoRepo(join(root, "demo"));
  const { project } = await cmd("project.create", "new", {
    name: "Workflow acceptance",
    repoPath: repo.repoPath,
  });
  await cmd("project.bootstrap", project.id);
  const { intake } = await cmd("intake.create", "new", {
    projectId: project.id,
    ...DEMO_TICKET,
  });
  let { spec } = await cmd("spec.draft", "new", {
    projectId: project.id,
    intakeId: intake.id,
    request: DEMO_TICKET.title,
  });
  ({ spec } = await cmd("spec.answer", spec.id, {
    questionId: "Q1",
    answer: "id, customer and total",
  }));
  ({ spec } = await cmd("spec.revise", spec.id, {
    title: spec.title + " reviewed",
    body: { problem: spec.body.problem, goals: spec.body.goals },
  }));
  await cmd("spec.submit", spec.id);
  await cmd("spec.approve", spec.id);
  let { plan } = await cmd("plan.propose", "new", { specId: spec.id });
  ({ plan } = await cmd("plan.revise", plan.id, {
    tasks: plan.tasks.map((t, i) => ({
      ...t,
      priority: 80 - i,
      budget: { wallClockMinutes: 10 },
    })),
  }));
  await cmd("plan.submit", plan.id);
  await cmd("plan.approve", plan.id);
  const executed = await cmd("execution.create", "new", { planId: plan.id });
  assert.ok(executed.execution.id);
  await h.hub.refresh();
  const snap = h.hub.snapshot();
  assert.ok(snap.mimir.tasks.length);
  assert.equal(snap.mimir.tasks[0].priority, 80);
  const { chromium } = await import("@playwright/test");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const split = cookie.indexOf("=");
  await context.addCookies([
    {
      name: cookie.slice(0, split),
      value: cookie.slice(split + 1),
      url: h.url,
    },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(h.url);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "New work", exact: true })
    .click();
  await page.getByRole("button", { name: new RegExp(plan.id) }).click();
  await page
    .getByText("Edit task priorities, dependencies and budgets", {
      exact: true,
    })
    .click();
  await page
    .getByLabel("Priority (higher first)", { exact: true })
    .first()
    .fill("55");
  const outputs = page.getByLabel("outputs (one per line)").first();
  await outputs.fill("first-output");
  await outputs.press("End");
  await outputs.press("Enter");
  await outputs.pressSequentially("second-output");
  assert.equal(await outputs.inputValue(), "first-output\nsecond-output");
  const dependencies = page
    .getByLabel("Dependencies (comma separated IDs)")
    .last();
  const originalDependencies = await dependencies.inputValue();
  await dependencies.fill(originalDependencies);
  await dependencies.pressSequentially(", ");
  assert.equal(await dependencies.inputValue(), originalDependencies + ", ");
  await dependencies.fill(originalDependencies);
  await page
    .getByRole("button", { name: "Review new plan revision", exact: true })
    .click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Browser priority revision acceptance");
  await page
    .getByRole("button", { name: "Send to source", exact: true })
    .click();
  await page
    .getByText("Source confirmed the request.", { exact: false })
    .first()
    .waitFor();
  await h.hub.refresh();
  assert.ok(
    h.hub.snapshot().sindri.plans.some((p) => p.tasks[0].priority === 55),
  );
  const revised = h.hub
    .snapshot()
    .sindri.plans.find((p) => p.tasks[0].priority === 55);
  assert.deepEqual(revised.tasks[0].outputs, ["first-output", "second-output"]);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: browser plan drill-down, priority editing, confirmation and source-persisted revision.",
  );
  console.log(
    "PASS: real source APIs via Heimdall: project, bootstrap, intake, draft, answer, spec revision/approval, plan revision/priority/approval and execution dispatch. Model and agent providers are deterministic fixtures.",
  );
} finally {
  await browser?.close();
  await h?.close();
  await s?.close();
  db?.close();
  await m?.close();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
