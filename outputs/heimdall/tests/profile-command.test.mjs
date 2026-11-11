import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { attentionRecords } from "../apps/server/preferences.mjs";
import { fixture } from "./fixture.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-profile-"));
  const source = await fixture();
  const app = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: "test-token",
      MIMIR_URL: source.url,
      MIMIR_TOKEN: "fixture-token",
      SINDRI_URL: source.url,
      SINDRI_TOKEN: "fixture-token",
    },
    operatorCode: "operator-test",
  });
  t.after(async () => {
    await app.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let cookie = "";
  const call = (path, body, extra = {}) =>
    fetch(app.url + "/api/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-heimdall-request": "1",
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const signIn = async () => {
    cookie = (await call("login", { token: "test-token" })).headers
      .get("set-cookie")
      .split(";")[0];
  };
  const sent = (method, path) =>
    source.requests.filter((r) => r.method === method && r.path === path);
  return { app, source, call, signIn, sent };
}
const profile = {
  checks: [{ id: "test", command: ["make", "test"], cwd: "src/app" }],
  env: { GOCACHE: "/cache/go-build" },
};
const profilePath = "/v1/projects/prj_demo/profile";

test("a profile change is a PUT that carries the approval secret and the whole profile", async (t) => {
  const { source, call, signIn, sent } = await setup(t);
  await signIn();
  await wait(200);
  const save = { action: "project.profile", id: "prj_demo", reason: "Go checks", body: profile };
  const key = { "idempotency-key": "profile-key-1234567890" };
  assert.equal((await call("commands", save, key)).status, 403, "read-only session");
  await call("unlock", { code: "operator-test" });
  const unpaired = await call("commands", save, key);
  assert.equal(unpaired.status, 403);
  assert.match((await unpaired.json()).message, /Pair with Sindri/);
  assert.equal(sent("PUT", profilePath).length, 0, "an unpaired session is stopped before Sindri");
  await call("pair", { code: "sindri-code" });
  const answer = await call("commands", save, key);
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).result, {
    profile,
    harness: { name: "sindri-fixture-1a2b3c4d", version: "1.0.0" },
  });
  const [put] = sent("PUT", profilePath);
  assert.equal(sent("POST", profilePath).length, 0);
  assert.equal(put.headers["x-sindri-approval"], "sindri-human-secret");
  assert.equal(put.headers["idempotency-key"], "profile-key-1234567890");
  assert.equal(put.headers.authorization, "Bearer fixture-token");
  assert.deepEqual(JSON.parse(put.body), profile);
  assert.deepEqual(source.profiles.prj_demo, profile);
  const empty = await call(
    "commands",
    { ...save, body: {} },
    { "idempotency-key": "profile-key-empty-12345" },
  );
  assert.equal((await empty.json()).result.harness, null);
  assert.equal(sent("PUT", profilePath).at(-1).body, "{}");
});

test("the stored profile is read through Heimdall, which says when it hid a value", async (t) => {
  const { source, call, signIn } = await setup(t);
  assert.equal((await call("details/profile/prj_demo")).status, 401);
  await signIn();
  assert.deepEqual(await (await call("details/profile/prj_demo")).json(), {
    profile: {},
    altered: false,
  });
  source.profiles.prj_demo = profile;
  assert.deepEqual(await (await call("details/profile/prj_demo")).json(), {
    profile,
    altered: false,
  });
  source.profiles.prj_demo = { env: { OPENAI_BASE: "sk-abcdefghijklmnop1234" } };
  assert.deepEqual(await (await call("details/profile/prj_demo")).json(), {
    profile: { env: { OPENAI_BASE: "[redacted]" } },
    altered: true,
  });
  assert.equal((await call("details/profile/..%2Fescape")).status, 404);
});

test("cancelling a run posts the operator's reason and a finished run is refused", async (t) => {
  const { source, call, signIn, sent } = await setup(t);
  await signIn();
  await wait(200);
  await call("unlock", { code: "operator-test" });
  await call("pair", { code: "sindri-code" });
  source.execution.execution.status = "running";
  const cancel = {
    action: "execution.cancel",
    id: "exe_demo",
    reason: "Wrong plan",
    body: { reason: "Wrong plan" },
  };
  const path = "/v1/executions/exe_demo/cancel";
  const answer = await call("commands", cancel, { "idempotency-key": "cancel-key-12345678901" });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).result.execution.status, "cancelled");
  assert.deepEqual(JSON.parse(sent("POST", path)[0].body), { reason: "Wrong plan" });
  const again = await call("commands", cancel, { "idempotency-key": "cancel-key-second-12345" });
  assert.equal(again.status, 409);
  assert.match((await again.json()).message, /nothing to cancel/);
});

test("a failed run raises a notification", () => {
  const records = attentionRecords({
    mimir: {},
    sindri: {
      executions: [
        { execution: { id: "exe_bad", status: "failed" } },
        { execution: { id: "exe_stopped", status: "cancelled" } },
        { execution: { id: "exe_live", status: "running" } },
      ],
    },
  });
  assert.deepEqual(
    records.map((r) => [r.id, r.kind, r.severity]),
    [["execution:exe_bad", "execution", "error"]],
  );
});

test("a local delivery patch passes through byte for byte; the rest is still cleaned", async (t) => {
  const { source, call, signIn } = await setup(t);
  await signIn();
  const patch =
    "diff --git a/client.js b/client.js\r\n+const key = 'sk-abcdefghijklmnop1234';\n+auth: Bearer abcdefghijklmnop1234\n+<b>kept</b>\t \n";
  source.workflow = {
    deliveries: [{ id: "exe_demo" }],
    local: {
      baseSha: "base000",
      resultCommit: "abc1234",
      patch,
      repoPath: "/example/invoice",
      apply: "git merge abc1234 # sk-abcdefghijklmnop1234",
      undo: "git reset --hard base000",
      followUp: { baseSha: "mid111", patch: patch + "+more\n" },
    },
  };
  const { result } = await (await call("details/local/exe_demo")).json();
  assert.equal(result.patch, patch);
  assert.equal(result.patchExact, true);
  assert.equal(result.followUp.patch, patch + "+more\n");
  assert.equal(result.followUp.patchExact, true);
  assert.equal(result.followUp.baseSha, "mid111");
  assert.equal(result.apply, "git merge abc1234 # [redacted]");

  // Heimdall's own source tokens never leave it; such a patch is marked as not exact.
  source.workflow.local = { ...source.workflow.local, patch: patch + "+token fixture-token\n", followUp: undefined };
  const leaked = (await (await call("details/local/exe_demo")).json()).result;
  assert.equal(leaked.patchExact, false);
  assert.equal(leaked.patch.includes("fixture-token"), false);
  assert.equal(leaked.followUp, undefined);

  source.workflow.local = null;
  assert.deepEqual(await (await call("details/local/exe_demo")).json(), { result: null });
});

test("sign-in and operator-code failures are counted and locked separately", async (t) => {
  const { call, signIn } = await setup(t);
  await signIn();
  // A token holder signing in again does not reset the operator-code count.
  for (let i = 0; i < 4; i++)
    assert.equal((await call("unlock", { code: "wrong" })).status, 403);
  assert.equal((await call("login", { token: "test-token" })).status, 200);
  assert.equal((await call("unlock", { code: "wrong" })).status, 403);
  assert.equal((await call("unlock", { code: "operator-test" })).status, 429);
  // The operator-code lockout does not lock sign-in, and a sign-in does not lift it.
  assert.equal((await call("login", { token: "test-token" })).status, 200);
  assert.equal((await call("unlock", { code: "operator-test" })).status, 429);
});

test("a sign-in lockout leaves the operator code usable, and each success resets only its own count", async (t) => {
  const { call, signIn } = await setup(t);
  await signIn();
  for (let i = 0; i < 4; i++)
    assert.equal((await call("login", { token: "wrong" })).status, 401);
  // Unlocking does not reset the sign-in count: the fifth failure still locks sign-in.
  assert.equal((await call("unlock", { code: "operator-test" })).status, 200);
  assert.equal((await call("login", { token: "wrong" })).status, 401);
  assert.equal((await call("login", { token: "test-token" })).status, 429);
  assert.equal((await call("unlock", { code: "operator-test" })).status, 200);
});
