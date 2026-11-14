// A restart (an update, a reboot, Stop and Start) keeps the access token, the operator code and
// signed-in sessions, so nobody is signed out or handed a new token by it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";

const start = (dir, source, port = "0") =>
  startHeimdall({
    env: {
      HEIMDALL_PORT: port,
      HEIMDALL_DATA_DIR: dir,
      SINDRI_URL: source.url,
      SINDRI_TOKEN: "fixture-token",
    },
  });

const call = async (app, path, body, cookie = "") => {
  const send = () =>
    fetch(app.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json", "x-heimdall-request": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // fetch reuses a kept-alive socket to the server that was just restarted on this port.
  return send().catch((e) => (e.cause?.code === "ECONNRESET" ? send() : Promise.reject(e)));
};

test("a restart keeps the access token, operator code and sessions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-auth-"));
  const source = await fixture();
  t.after(async () => {
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const first = await start(dir, source);
  t.after(() => first.close());
  const { token, operatorCode } = first;
  const login = await call(first, "login", { token });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  // Sessions last a week, not 12 hours.
  assert.match(login.headers.get("set-cookie"), /Max-Age=604800/);
  assert.equal((await call(first, "unlock", { code: operatorCode }, cookie)).status, 200);
  await first.close();

  // Owner-only files: they hold the token and live sessions.
  for (const file of ["auth.json", "sessions.json"])
    assert.equal(statSync(join(dir, file)).mode & 0o077, 0, file);

  // Same port, as the factory always uses: the session cookie is named after it.
  const second = await start(dir, source, new URL(first.url).port);
  t.after(() => second.close());
  assert.equal(second.token, token);
  assert.equal(second.operatorCode, operatorCode);
  const session = await call(second, "session", undefined, cookie);
  assert.equal(session.status, 200);
  assert.equal((await session.json()).operator, true);

  // Signing out still ends the session for good, across a restart too.
  assert.equal((await call(second, "logout", {}, cookie)).status, 200);
  assert.equal((await call(second, "session", undefined, cookie)).status, 401);
});

test("an explicitly configured token and operator code win over saved ones", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-auth-"));
  const source = await fixture();
  t.after(async () => {
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await start(dir, source);
  t.after(() => first.close());
  await first.close();
  const second = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: "configured",
      SINDRI_URL: source.url,
      SINDRI_TOKEN: "fixture-token",
    },
    operatorCode: "configured-code",
  });
  t.after(() => second.close());
  assert.equal(second.token, "configured");
  assert.equal(second.operatorCode, "configured-code");
});
