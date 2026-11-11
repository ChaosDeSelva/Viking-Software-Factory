// Raise budget: the `budget.raise` operator command, Mimir's attention passthrough, and the
// path routing fallback that makes every page URL bookmarkable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRoute } from "../apps/server/commands.mjs";
import {
  budgetBlock,
  budgetEntryFor,
  budgetPayload,
  budgetTarget,
  entryScope,
} from "../apps/web/src/features/budgetForm.ts";
import { setup } from "./support.mjs";

test("budget.raise patches the crew budget in Mimir with only the limits and version", () => {
  const route = commandRoute({
    action: "budget.raise",
    id: "crw_demo",
    body: {
      scope: "crew",
      limitTokens: 2000000,
      limitCost: 12.5,
      expectedVersion: 3,
      extra: "dropped",
    },
  });
  assert.deepEqual(
    {
      source: route.source,
      method: route.method,
      path: route.path,
      approval: route.approval,
    },
    {
      source: "mimir",
      method: "PATCH",
      path: "/v1/crews/crw_demo/budget",
      approval: false,
    },
  );
  assert.deepEqual(route.body, {
    limitTokens: 2000000,
    limitCost: 12.5,
    expectedVersion: 3,
  });
  assert.equal(
    commandRoute({
      action: "budget.raise",
      id: "msn_demo",
      body: { scope: "mission", limitCost: 5 },
    }).path,
    "/v1/missions/msn_demo/budget",
  );
});

test("budget.raise refuses missing, non-positive or fractional limits and unknown scopes", () => {
  const bad = [
    {},
    { limitTokens: 0 },
    { limitTokens: -5 },
    { limitTokens: 1.5 },
    { limitCost: "10" },
    { limitTokens: 10, scope: "project" },
    { limitTokens: 10, expectedVersion: -1 },
    { onUnknown: "warn" },
    { onUnknown: true },
    { limitTokens: 10, onUnknown: "ALLOW" },
  ];
  for (const body of bad)
    assert.throws(
      () => commandRoute({ action: "budget.raise", id: "crw_demo", body }),
      undefined,
      JSON.stringify(body),
    );
  assert.throws(() =>
    commandRoute({
      action: "budget.raise",
      id: "../crw",
      body: { limitTokens: 10 },
    }),
  );
});

test("budget.raise forwards onUnknown alone, so a budget_uncertain block or a new hard budget can be fixed", () => {
  for (const onUnknown of ["allow", "block"])
    assert.deepEqual(
      commandRoute({
        action: "budget.raise",
        id: "crw_demo",
        body: { scope: "crew", onUnknown, expectedVersion: 1 },
      }).body,
      { onUnknown, expectedVersion: 1 },
    );
  assert.deepEqual(
    commandRoute({
      action: "budget.raise",
      id: "msn_demo",
      body: { scope: "mission", limitTokens: 500, onUnknown: "block" },
    }).body,
    { limitTokens: 500, onUnknown: "block" },
  );
});

const exceeded = (extra) => ({
  kind: "budget_exceeded",
  missionId: "msn_a",
  crewId: null,
  limitTokens: 100,
  limitCost: null,
  budgetVersion: 4,
  ...extra,
});

test("the form picks the exhausted budget that blocks the task, never a mere warning", () => {
  const task = {
    id: "t",
    crewId: "crw_a",
    missionId: "msn_a",
    blockedReason: "budget_exceeded",
  };
  const crewWarning = {
    ...exceeded({ crewId: "crw_a" }),
    kind: "budget_warning",
  };
  const missionExceeded = exceeded();
  // A crew warning next to an exhausted mission budget: the mission budget is what blocks.
  assert.equal(
    budgetEntryFor([crewWarning, missionExceeded], task),
    missionExceeded,
  );
  assert.equal(entryScope(missionExceeded), "mission");
  assert.equal(budgetTarget(task, "mission", missionExceeded), "msn_a");
  const crewExceeded = exceeded({ crewId: "crw_a" });
  assert.equal(
    budgetEntryFor([missionExceeded, crewExceeded], task),
    crewExceeded,
  );
  // Other crews' and missions' budgets never qualify.
  assert.equal(
    budgetEntryFor(
      [exceeded({ crewId: "crw_b" }), exceeded({ missionId: "msn_b" })],
      task,
    ),
    undefined,
  );
  // Nothing known: no default; the operator chooses crew or mission.
  assert.equal(budgetEntryFor([crewWarning], task), undefined);
  assert.equal(entryScope(undefined), null);
  assert.equal(budgetTarget(task, "crew", undefined), "crw_a");
  assert.equal(budgetTarget(task, "mission", undefined), "msn_a");
  // budget_uncertain: the budget whose usage is unknown, even below its warning fraction.
  const unknown = { ...crewWarning, uncertain: true };
  assert.equal(
    budgetEntryFor([unknown], { ...task, blockedReason: "budget_uncertain" }),
    unknown,
  );
});

test("the form accepts an onUnknown change without limits and sends only what was set", () => {
  const entry = exceeded();
  assert.match(budgetBlock(true, "msn_a", "", "", entry), /unknown usage/);
  assert.equal(budgetBlock(true, "msn_a", "", "", entry, "allow"), "");
  assert.match(budgetBlock(true, "msn_a", "100", "", entry), /higher/);
  assert.match(
    budgetBlock(true, undefined, "500", "", undefined),
    /no crew or mission/,
  );
  assert.match(budgetBlock(false, "msn_a", "500", "", entry), /Unlock/);
  assert.deepEqual(budgetPayload("mission", "", "", "allow", entry), {
    scope: "mission",
    onUnknown: "allow",
    expectedVersion: 4,
  });
  assert.deepEqual(budgetPayload("crew", "200", "1.5", "", undefined), {
    scope: "crew",
    limitTokens: 200,
    limitCost: 1.5,
  });
});

test("raising a budget needs operator controls, not Sindri pairing, and unblocks the crew's task", async (t) => {
  const { app, source, call, signIn, operator, key } = await setup(t);
  source.data.tasks[0].status = "blocked";
  source.data.tasks[0].blockedReason = "budget_exceeded";
  const cmd = {
    action: "budget.raise",
    id: "crw_demo",
    reason: "The crew needs more room for the final review",
    body: { scope: "crew", limitTokens: 3000000, expectedVersion: 0 },
  };
  await signIn();
  assert.equal(
    (await call("commands", cmd, key())).status,
    403,
    "read-only sessions cannot raise",
  );
  await operator({ pair: false });
  const answer = await call("commands", cmd, key());
  assert.equal(answer.status, 200, await answer.clone().text());
  const sent = source.requests.findLast((r) => r.method === "PATCH");
  assert.equal(sent.path, "/v1/crews/crw_demo/budget");
  assert.deepEqual(JSON.parse(sent.body), {
    limitTokens: 3000000,
    expectedVersion: 0,
  });
  assert.equal(sent.headers["x-sindri-approval"], undefined);
  assert.equal(source.data.tasks[0].status, "ready");
  assert.ok(
    app.store
      .audits()
      .some(
        (a) => a.action === "budget.raise" && a.outcome === "source confirmed",
      ),
  );
  // A stale version comes back as Mimir's refusal, with nothing changed.
  const stale = await call(
    "commands",
    { ...cmd, body: { ...cmd.body, limitTokens: 4000000 } },
    key(),
  );
  assert.equal(stale.status, 409);
  assert.equal(source.budgets.crw_demo.limitTokens, 3000000);
});

test("Mimir's attention list is readable by a signed-in session", async (t) => {
  const { source, call, signIn } = await setup(t);
  source.attention = [
    {
      kind: "budget_exceeded",
      budgetId: "bgt_1",
      scope: "crew",
      missionId: "msn_demo",
      crewId: "crw_demo",
      spentTokens: 1200,
      spentCost: 0,
      limitTokens: 1000,
      limitCost: null,
      budgetVersion: 2,
      uncertain: false,
    },
  ];
  assert.equal((await call("attention")).status, 401);
  await signIn();
  const answer = await call("attention");
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).items, source.attention);
});

test("page paths serve the app, while missing assets and API paths stay 404", async (t) => {
  const web = mkdtempSync(join(tmpdir(), "heimdall-web-"));
  t.after(() => rmSync(web, { recursive: true, force: true }));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(web, "app.js"), "export {}");
  const { app } = await setup(t, { webDir: web });
  for (const path of [
    "/",
    "/pipeline",
    "/autonomy/all",
    "/docs/glossary?project=prj_demo",
  ]) {
    const r = await fetch(app.url + path);
    assert.equal(r.status, 200, path);
    assert.match(await r.text(), /<title>app<\/title>/, path);
  }
  assert.equal(
    (await fetch(app.url + "/app.js")).headers.get("content-type"),
    "text/javascript",
  );
  assert.equal((await fetch(app.url + "/missing.js")).status, 404);
  assert.equal(
    (await fetch(app.url + "/%2E%2E%2Fsecret.txt")).status,
    404,
    "no escape from the web root",
  );
  assert.equal((await fetch(app.url + "/api/nope")).status, 401);
});

test("a cost limit too large to be a number is refused, not sent as null and dropped", () => {
  // JSON turns Infinity into null, which the server reads as "no new cost limit".
  for (const cost of ["Infinity", "1e400"])
    assert.match(
      budgetBlock(true, "crw_a", "", cost, undefined),
      /cost limit/,
      cost,
    );
});
