// Shared start-up for server tests: a fixture backend, a Heimdall on a free port, a temp data dir.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls instead of sleeping a fixed time, so a loaded machine only makes a test slower. */
export async function until(check, what = "condition", limitMs = 20000) {
  const end = Date.now() + limitMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error("Timed out waiting for " + what);
    await wait(25);
  }
}
export async function setup(t, { env = {}, sources = ["mimir", "sindri"], ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-test-"));
  const source = await fixture();
  const app = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: "test-token",
      ...(sources.includes("mimir") ? { MIMIR_URL: source.url, MIMIR_TOKEN: "fixture-token" } : {}),
      ...(sources.includes("sindri") ? { SINDRI_URL: source.url, SINDRI_TOKEN: "fixture-token" } : {}),
      ...env,
    },
    operatorCode: "operator-test",
    ...options,
  });
  t.after(async () => {
    await app.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let cookie = "";
  const call = (path, body, extra = {}) =>
    fetch(app.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-heimdall-request": "1",
        ...extra,
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const signIn = async () => {
    const answer = await call("login", { token: "test-token" });
    cookie = answer.headers.get("set-cookie").split(";")[0];
    return cookie;
  };
  /** Signed in, unlocked and (with Sindri) paired, after the first snapshot arrived. */
  const operator = async ({ pair = sources.includes("sindri") } = {}) => {
    await signIn();
    await until(() => app.hub.state.generatedAt, "the first snapshot");
    await call("unlock", { code: "operator-test" });
    if (pair) await call("pair", { code: "sindri-code" });
  };
  const posts = (path) =>
    source.requests.filter((r) => r.method === "POST" && r.path === path).length;
  let keys = 0;
  const key = () => ({ "idempotency-key": "test-key-" + String(++keys).padStart(12, "0") });
  return {
    app,
    source,
    dir,
    call,
    signIn,
    operator,
    posts,
    key,
    setCookie: (value) => (cookie = value),
  };
}
/** A loopback source that answers as the test says; `handle` may be replaced at any time. */
export async function stub(t, handle) {
  const api = { handle, requests: [] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    api.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    await api.handle(req, res, body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.connection = { url: api.url, token: "stub-token" };
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return api;
}
export const send = (res, status, body, headers = {}) => {
  res.writeHead(status, headers);
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
